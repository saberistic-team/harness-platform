import { randomUUID } from "node:crypto";
import type {
  ControlPlaneRepository,
  EventSink,
  OutboxEventRecord,
  OutboxKick,
} from "./types";
import { addMilliseconds, requireId, requireInteger } from "./util";

export interface OutboxPublisherOptions {
  repository: ControlPlaneRepository;
  sink: EventSink;
  publisherId?: string;
  now?: () => string;
  leaseMs?: number;
  retryDelayMs?: number;
  pollIntervalMs?: number;
  onHealthFailure?: (error: unknown) => void;
  onHealthRecovery?: () => void;
}

/**
 * Ordered, fenced outbox delivery. Mutating API calls only call `kick`; they do
 * not join delivery, so a sink outage cannot roll back or fail committed state.
 * A delivery whose acknowledgement is lost is retried with the same eventId.
 */
export class OutboxPublisher implements OutboxKick {
  private readonly repository: ControlPlaneRepository;
  private readonly sink: EventSink;
  private readonly publisherId: string;
  private readonly now: () => string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly onHealthFailure?: (error: unknown) => void;
  private readonly onHealthRecovery?: () => void;
  private running?: Promise<number>;
  private requested = false;
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private unhealthy = false;
  private recoveryNeedsDelivery = false;

  constructor(options: OutboxPublisherOptions) {
    this.repository = options.repository;
    this.sink = options.sink;
    this.publisherId = requireId(
      options.publisherId ?? `publisher-${randomUUID()}`,
      "publisherId",
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseMs = requireInteger(options.leaseMs ?? 30_000, "leaseMs", 1_000, 3_600_000);
    this.retryDelayMs = requireInteger(options.retryDelayMs ?? 1_000, "retryDelayMs", 1, 60_000);
    this.pollIntervalMs = requireInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs", 10, 60_000);
    this.onHealthFailure = options.onHealthFailure;
    this.onHealthRecovery = options.onHealthRecovery;
  }

  private reportFailure(error: unknown, recoveryNeedsDelivery: boolean): void {
    this.unhealthy = true;
    this.recoveryNeedsDelivery ||= recoveryNeedsDelivery;
    try { this.onHealthFailure?.(error); } catch {
      // Health reporting must not change durable publisher behavior.
    }
  }

  private reportRecovery(delivered: boolean): void {
    if (!this.unhealthy || (this.recoveryNeedsDelivery && !delivered)) return;
    this.unhealthy = false;
    this.recoveryNeedsDelivery = false;
    try { this.onHealthRecovery?.(); } catch {
      // Health reporting must not change durable publisher behavior.
    }
  }

  start(): void {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = setInterval(() => this.kick(), this.pollIntervalMs);
    this.pollTimer.unref();
    this.kick();
  }

  kick(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.running) return;
    const run = this.drainRequested();
    this.running = run;
    void run.catch(() => {
      this.armRetry(this.retryDelayMs);
    }).finally(() => {
      if (this.running === run) this.running = undefined;
      if (this.requested && !this.stopped) this.kick();
    });
  }

  /** Explicitly wait for the current best-effort publish pass (useful in tests). */
  async flush(): Promise<number> {
    if (this.stopped) return 0;
    this.requested = true;
    if (!this.running) {
      const run = this.drainRequested();
      this.running = run;
      try {
        return await run;
      } finally {
        if (this.running === run) this.running = undefined;
      }
    }
    return this.running;
  }

  private async drainRequested(): Promise<number> {
    let published = 0;
    do {
      this.requested = false;
      published += await this.drainAvailable();
    } while (this.requested && !this.stopped);
    return published;
  }

  private async drainAvailable(): Promise<number> {
    let published = 0;
    while (!this.stopped) {
      const now = this.now();
      let claimed: OutboxEventRecord | undefined;
      try {
        claimed = await this.repository.claimOutbox({
          publisherId: this.publisherId,
          leaseMs: this.leaseMs,
          now,
          expiresAt: addMilliseconds(now, this.leaseMs),
        });
      } catch (error) {
        this.reportFailure(error, false);
        throw error;
      }
      if (!claimed) {
        this.reportRecovery(false);
        return published;
      }
      if (!await this.publishOne(claimed)) return published;
      published += 1;
    }
    return published;
  }

  private async publishOne(claimed: OutboxEventRecord): Promise<boolean> {
    try {
      await this.sink(claimed.event);
    } catch (error) {
      this.reportFailure(error, true);
      const now = this.now();
      await this.repository.releaseOutbox({
        eventId: claimed.event.eventId,
        publisherId: this.publisherId,
        fencingToken: claimed.fencingToken,
        now,
        availableAt: addMilliseconds(now, this.retryDelayMs),
        retryDelayMs: this.retryDelayMs,
        error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
      });
      this.armRetry(this.retryDelayMs);
      return false;
    }
    try {
      await this.repository.markOutboxPublished({
        eventId: claimed.event.eventId,
        publisherId: this.publisherId,
        fencingToken: claimed.fencingToken,
        now: this.now(),
      });
      this.reportRecovery(true);
      return true;
    } catch (error) {
      this.reportFailure(error, true);
      // Delivery may have succeeded. Leave the fenced claim to expire so the
      // exact same eventId is retried instead of guessing whether it arrived.
      this.armRetry(this.leaseMs);
      throw error;
    }
  }

  private armRetry(delayMs: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, delayMs);
    this.retryTimer.unref();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.running;
  }
}

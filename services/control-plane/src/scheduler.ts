import { decodeTaskManifest, type TaskManifest } from "@harness/sdk";
import { ControlPlaneError } from "./errors";
import type {
  CompleteRunInput,
  ControlPlaneRepository,
  LeaseExpiryResult,
  OutboxKick,
  RunRecord,
  TaskRecord,
  TerminalRunState,
} from "./types";
import {
  addMilliseconds,
  canonicalJson,
  defaultId,
  requireId,
  requireInteger,
  requireIso,
  sha256Hex,
} from "./util";

export interface SchedulerOptions {
  repository: ControlPlaneRepository;
  outbox?: OutboxKick;
  now?: () => string;
  newId?: (prefix: string) => string;
  defaultLeaseMs?: number;
  maxLeaseMs?: number;
}

export interface LeaseIdentity {
  runId: string;
  workerId: string;
  leaseId: string;
  fencingToken: number;
}

/** Typed orchestration over a repository; policy remains outside this service. */
export class Scheduler {
  private readonly repository: ControlPlaneRepository;
  private readonly outbox?: OutboxKick;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly defaultLeaseMs: number;
  private readonly maxLeaseMs: number;

  constructor(options: SchedulerOptions) {
    this.repository = options.repository;
    this.outbox = options.outbox;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultId;
    this.maxLeaseMs = options.maxLeaseMs ?? 15 * 60_000;
    this.defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
    requireInteger(this.maxLeaseMs, "maxLeaseMs", 1_000, 24 * 60 * 60_000);
    requireInteger(this.defaultLeaseMs, "defaultLeaseMs", 1_000, this.maxLeaseMs);
  }

  async ready(): Promise<void> {
    await this.repository.ready();
  }

  private timestamp(): string {
    return requireIso(this.now(), "scheduler clock");
  }

  async admitTask(manifestInput: unknown, admissionKey: string): Promise<{ task: TaskRecord; created: boolean }> {
    let manifest: TaskManifest;
    try {
      manifest = decodeTaskManifest(manifestInput);
    } catch (error) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "task manifest is invalid", { cause: error });
    }
    const key = requireId(admissionKey, "idempotency key");
    const manifestDigest = sha256Hex(canonicalJson(manifest));
    const result = await this.repository.admitTask({
      manifest,
      manifestDigest,
      admissionKey: key,
      admittedAt: this.timestamp(),
    });
    this.outbox?.kick();
    return { task: result.record, created: result.created };
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const id = requireId(taskId, "taskId");
    const record = await this.repository.getTask(id);
    if (!record) throw new ControlPlaneError("CP_NOT_FOUND", `task ${id} was not found`);
    return record;
  }

  listTasks(limit = 100): Promise<TaskRecord[]> {
    return this.repository.listTasks({ limit: requireInteger(limit, "limit", 1, 500) });
  }

  async scheduleRun(input: {
    taskId: string;
    admissionKey: string;
    runId?: string;
    priority?: number;
  }): Promise<{ run: RunRecord; created: boolean }> {
    const task = await this.getTask(input.taskId);
    const admissionKey = requireId(input.admissionKey, "idempotency key");
    const runId = input.runId === undefined
      ? this.newId("run")
      : requireId(input.runId, "runId");
    const priority = requireInteger(input.priority ?? 0, "priority", -1_000, 1_000);
    const result = await this.repository.enqueueRun({
      runId,
      taskId: task.taskId,
      manifestDigest: task.manifestDigest,
      admissionKey,
      priority,
      queuedAt: this.timestamp(),
    });
    this.outbox?.kick();
    return { run: result.record, created: result.created };
  }

  async getRun(runId: string): Promise<RunRecord> {
    const id = requireId(runId, "runId");
    const record = await this.repository.getRun(id);
    if (!record) throw new ControlPlaneError("CP_NOT_FOUND", `run ${id} was not found`);
    return record;
  }

  listRuns(input: { taskId?: string; limit?: number } = {}): Promise<RunRecord[]> {
    return this.repository.listRuns({
      ...(input.taskId === undefined ? {} : { taskId: requireId(input.taskId, "taskId") }),
      limit: requireInteger(input.limit ?? 100, "limit", 1, 500),
    });
  }

  async reapExpiredLeases(): Promise<LeaseExpiryResult> {
    const result = await this.repository.reapExpiredLeases(this.timestamp());
    this.outbox?.kick();
    return result;
  }

  async claimRun(workerId: string, requestedLeaseMs?: number): Promise<RunRecord | undefined> {
    const worker = requireId(workerId, "workerId");
    const leaseMs = requireInteger(
      requestedLeaseMs ?? this.defaultLeaseMs,
      "leaseMs",
      1_000,
      this.maxLeaseMs,
    );
    const now = this.timestamp();
    const claimed = await this.repository.claimRun({
      workerId: worker,
      leaseId: this.newId("lease"),
      leaseMs,
      now,
      expiresAt: addMilliseconds(now, leaseMs),
    });
    this.outbox?.kick();
    return claimed;
  }

  private leaseIdentity(input: LeaseIdentity): LeaseIdentity {
    return {
      runId: requireId(input.runId, "runId"),
      workerId: requireId(input.workerId, "workerId"),
      leaseId: requireId(input.leaseId, "leaseId"),
      fencingToken: requireInteger(input.fencingToken, "fencingToken", 1, Number.MAX_SAFE_INTEGER),
    };
  }

  private operatorNote(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (
      typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 2_000 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new ControlPlaneError(
        "CP_INVALID_INPUT",
        "note must be a plain string between 1 and 2000 UTF-8 bytes",
      );
    }
    return value;
  }

  async startRun(input: LeaseIdentity): Promise<RunRecord> {
    const record = await this.repository.startRun({ ...this.leaseIdentity(input), now: this.timestamp() });
    this.outbox?.kick();
    return record;
  }

  async heartbeatRun(input: LeaseIdentity & { leaseMs?: number }): Promise<RunRecord> {
    const lease = this.leaseIdentity(input);
    const leaseMs = requireInteger(
      input.leaseMs ?? this.defaultLeaseMs,
      "leaseMs",
      1_000,
      this.maxLeaseMs,
    );
    const now = this.timestamp();
    const record = await this.repository.heartbeatRun({
      ...lease,
      leaseMs,
      now,
      expiresAt: addMilliseconds(now, leaseMs),
    });
    this.outbox?.kick();
    return record;
  }

  async completeRun(input: LeaseIdentity & {
    status: TerminalRunState;
    completionKey: string;
    reportPath?: string;
  }): Promise<RunRecord> {
    if (!(["passed", "failed", "blocked", "canceled"] as const).includes(input.status)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "invalid terminal run status");
    }
    if (input.reportPath !== undefined && (
      input.reportPath.length === 0 || input.reportPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input.reportPath)
    )) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "reportPath is invalid");
    }
    const complete: CompleteRunInput = {
      ...this.leaseIdentity(input),
      status: input.status,
      completionKey: requireId(input.completionKey, "completion idempotency key"),
      ...(input.reportPath === undefined ? {} : { reportPath: input.reportPath }),
      now: this.timestamp(),
    };
    const record = await this.repository.completeRun(complete);
    this.outbox?.kick();
    return record;
  }

  async cancelRun(input: { runId: string; expectedVersion: number; note?: string }): Promise<RunRecord> {
    const note = this.operatorNote(input.note);
    const record = await this.repository.cancelRun({
      runId: requireId(input.runId, "runId"),
      expectedVersion: requireInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
      ...(note === undefined ? {} : { note }),
      now: this.timestamp(),
    });
    this.outbox?.kick();
    return record;
  }

  async reconcileRun(input: {
    runId: string;
    expectedVersion: number;
    action: "retry" | "cancel";
    note?: string;
  }): Promise<RunRecord> {
    if (input.action !== "retry" && input.action !== "cancel") {
      throw new ControlPlaneError("CP_INVALID_INPUT", "invalid reconciliation action");
    }
    const note = this.operatorNote(input.note);
    const record = await this.repository.reconcileRun({
      runId: requireId(input.runId, "runId"),
      expectedVersion: requireInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
      action: input.action,
      ...(note === undefined ? {} : { note }),
      now: this.timestamp(),
    });
    this.outbox?.kick();
    return record;
  }
}

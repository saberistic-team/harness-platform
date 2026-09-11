import { deserializeEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import { assertOwnerId, assertSessionId, SessionStoreError, type SessionStore, type SessionCheckpoint } from "./store";
/** Production adapter for the kernel's structurally compatible EventStore port. */
export class SessionEventStore {
  readonly checkpointVersion = 1 as const;
  private tail: Promise<void> = Promise.resolve();
  private revision: number | undefined;
  constructor(private readonly store: SessionStore, readonly sessionId: string, private readonly ownerId: string) {
    assertSessionId(sessionId);
    assertOwnerId(ownerId);
  }
  append(event: AnyHarnessEvent): Promise<void> {
    // Snapshot before returning control to the caller; retained IDs are never regenerated.
    const copy = deserializeEvent(serializeEvent(event));
    if ((copy.data as {
      sessionId?: string;
    }).sessionId !== this.sessionId)
      return Promise.reject(new SessionStoreError("SESS_INVALID_RECORD", "runtime event belongs to another session"));
    if (copy.type === "runtime.checkpoint") {
      const payload = copy.data.payload;
      if (payload.version !== 1 || payload.sessionId !== this.sessionId || payload.runId !== copy.data.runId || payload.turnId !== copy.data.turnId)
        return Promise.reject(new SessionStoreError("SESS_SCHEMA_VERSION", "invalid runtime checkpoint identity/version"));
    }
    const operation = this.tail.then(async () => {
      if (this.revision === undefined)
        this.revision = (await this.store.getCheckpoint(this.sessionId))?.revision ?? 0;
      const row = await this.store.appendEvent(this.sessionId, copy, { ownerId: this.ownerId });
      if (copy.type === "runtime.checkpoint") {
        const payload = copy.data.payload;
        const current = await this.store.getCheckpoint(this.sessionId);
        // Identical redelivery can revisit a committed checkpoint without changing CAS.
        if (current && current.afterSeq > row.seq) {
          this.revision = current.revision;
          return;
        }
        if (current && current.afterSeq === row.seq && JSON.stringify(current.payload) === JSON.stringify(payload)) {
          this.revision = current.revision;
          return;
        }
        const saved = await this.store.saveCheckpoint(this.sessionId, { expectedRevision: this.revision!, afterSeq: row.seq, payload, ownerId: this.ownerId });
        this.revision = saved.revision;
      }
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async *readSession(sessionId: string): AsyncIterable<AnyHarnessEvent> {
    if (sessionId !== this.sessionId)
      throw new SessionStoreError("SESS_INVALID_RECORD", "adapter is bound to another session");
    let afterSeq = -1;
    while (true) {
      const page = await this.store.readSessionEvents(sessionId, { afterSeq, limit: 1000 });
      for (const row of page.events)
        yield row.event;
      if (!page.hasMore)
        return;
      if (page.nextAfterSeq <= afterSeq)
        throw new SessionStoreError("SESS_INVALID_CURSOR", "non-advancing session cursor");
      afterSeq = page.nextAfterSeq;
    }
  }
  async loadCheckpoint(): Promise<SessionCheckpoint | undefined> {
    await this.tail;
    const checkpoint = await this.store.getCheckpoint(this.sessionId);
    if (checkpoint && (!checkpoint.payload || typeof checkpoint.payload !== "object" || !("version" in checkpoint.payload) || checkpoint.payload.version !== 1))
      throw new SessionStoreError("SESS_SCHEMA_VERSION", "unsupported runtime checkpoint version");
    return checkpoint;
  }
}

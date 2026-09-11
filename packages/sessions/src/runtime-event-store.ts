import { createEvent, deserializeEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
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
  async markInterrupted(): Promise<void> {
    await this.tail;
    const record=await this.store.getSession(this.sessionId);
    const events:AnyHarnessEvent[]=[];for await(const event of this.readSession(this.sessionId))events.push(event);
    const checkpoint=await this.store.getCheckpoint(this.sessionId);
    // A competing healthy owner must never be closed by the losing claimant.
    if(Date.parse(String(record.metadata.leaseExpiresAt)) > Date.parse(await this.store.currentTime()))return;
    await this.store.recoverInterrupted(this.sessionId,createEvent("session.restored",{
      sessionId:this.sessionId,afterSeq:checkpoint?.afterSeq??-1,availableThroughSeq:events.length-1,
      availableEvents:events.length,outcome:"interrupted",note:"indeterminate segment; automatic execution forbidden",
    }),undefined,record.metadata);
  }

  async claimContinuation(identity: {runId:string;sessionId:string;turnId:string}): Promise<{payload:unknown}> {
    await this.tail;
    if (identity.sessionId !== this.sessionId) throw new SessionStoreError("SESS_INVALID_RECORD", "session mismatch");
    const checkpoint = await this.store.getCheckpoint(this.sessionId);
    const record = await this.store.getSession(this.sessionId);
    const now = await this.store.currentTime();
    const saved = await this.store.continueSession(this.sessionId, {
      expectedRevision: checkpoint?.revision ?? 0, expectedMetadata:record.metadata,
      ownerId:this.ownerId, leaseExpiresAt:new Date(Date.parse(now) + 60_000).toISOString(),
      event:createEvent("runtime.continued", {...identity, ownerId:this.ownerId, checkpointRevision:checkpoint?.revision ?? 1}),
    });
    this.revision = saved.revision;
    return saved;
  }

  async loadCheckpoint(): Promise<SessionCheckpoint | undefined> {
    await this.tail;
    const checkpoint = await this.store.getCheckpoint(this.sessionId);
    if (checkpoint && (!checkpoint.payload || typeof checkpoint.payload !== "object" || !("version" in checkpoint.payload) || checkpoint.payload.version !== 1))
      throw new SessionStoreError("SESS_SCHEMA_VERSION", "unsupported runtime checkpoint version");
    return checkpoint;
  }
}

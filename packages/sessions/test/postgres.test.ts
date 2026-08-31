import { describe, expect, it } from "vitest";
import { createEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import {
  migratePostgresSessions,
  POSTGRES_SESSION_MIGRATIONS,
  PostgresSessionStore,
  type Queryable,
  type QueryResult,
  type TransactionRunner,
} from "../src";

interface Step {
  tag: string;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  values?: readonly unknown[];
}

class ScriptedDatabase implements Queryable, TransactionRunner {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  transactionRuns = 0;

  constructor(private readonly steps: Step[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected query: ${text}`);
    expect(text).toContain(step.tag);
    if (step.values) expect(values).toEqual(step.values);
    this.calls.push({ text, values });
    return {
      rows: (step.rows ?? []) as Row[],
      rowCount: step.rowCount ?? step.rows?.length ?? 0,
    };
  }

  async run<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T> {
    this.transactionRuns++;
    return operation(this);
  }

  expectDone(): void {
    expect(this.steps).toEqual([]);
  }
}

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-pg",
    task_id: "m4-control-plane",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    metadata: "{}",
    next_seq: "0",
    checkpoint_revision: "0",
    checkpoint_seq: null,
    checkpoint_payload: null,
    checkpoint_updated_at: null,
    ...overrides,
  };
}

function eventRow(
  event: AnyHarnessEvent,
  seq: number,
  globalSeq: number,
  sessionId = "sess-pg",
): Record<string, unknown> {
  return {
    session_id: sessionId,
    seq: String(seq),
    global_seq: String(globalSeq),
    event_id: event.eventId,
    at: event.at,
    actor: event.actor ?? null,
    type: event.type,
    payload: serializeEvent(event),
  };
}

function storeWith(db: ScriptedDatabase): PostgresSessionStore {
  return new PostgresSessionStore({
    queryable: db,
    transactions: db,
    now: () => "2026-01-01T01:00:00.000Z",
    newId: (prefix) => `${prefix}-fixed`,
  });
}

describe("Postgres sessions migrations", () => {
  it("applies ordered migrations under one injected transaction", async () => {
    const migrationSteps: Step[] = [
      { tag: "sessions:migration-lock" },
      { tag: "sessions:migration-meta" },
      { tag: "sessions:migration-version-read", rows: [] },
      ...POSTGRES_SESSION_MIGRATIONS.flatMap((migration) => [
        ...migration.statements.map((statement) => ({
          tag: statement.match(/sessions:[^ *]+/u)?.[0] ?? statement,
        })),
        {
          tag: "sessions:migration-version-write",
          values: [String(migration.version)],
        },
      ]),
    ];
    const db = new ScriptedDatabase(migrationSteps);
    await migratePostgresSessions(db, db);
    expect(db.transactionRuns).toBe(1);
    db.expectDone();
  });

  it("defines immutable event rows and both ordering constraints", () => {
    const sql = POSTGRES_SESSION_MIGRATIONS.flatMap((migration) => migration.statements)
      .join("\n");
    expect(sql).toContain("event_id TEXT NOT NULL UNIQUE");
    expect(sql).toContain("UNIQUE (session_id, seq)");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON harness_events");
    expect(sql).toContain("harness_event_global_sequence");
    expect(sql).toContain("DROP IDENTITY IF EXISTS");
  });

  it("upgrades an existing v1 identity schema without replaying v1", async () => {
    const migration = POSTGRES_SESSION_MIGRATIONS.find((candidate) => candidate.version === 2)!;
    const db = new ScriptedDatabase([
      { tag: "sessions:migration-lock" },
      { tag: "sessions:migration-meta" },
      { tag: "sessions:migration-version-read", rows: [{ value: "1" }] },
      ...migration.statements.map((statement) => ({
        tag: statement.match(/sessions:[^ *]+/u)?.[0] ?? statement,
      })),
      { tag: "sessions:migration-version-write", values: ["2"] },
    ]);
    await migratePostgresSessions(db, db);
    expect(db.calls.some((call) =>
      call.text.includes("sessions:migration-v1-sessions"))).toBe(false);
    const dropIndex = migration.statements.findIndex((statement) =>
      statement.includes("DROP IDENTITY"));
    const initializeIndex = migration.statements.findIndex((statement) =>
      statement.includes("COALESCE(MAX(global_seq)"));
    expect(dropIndex).toBeGreaterThan(-1);
    expect(initializeIndex).toBeGreaterThan(dropIndex);
    db.expectDone();
  });
});

describe("PostgresSessionStore with an offline query seam", () => {
  it("uses the database clock when no deterministic clock is injected", async () => {
    const databaseNow = new Date("2026-01-01T01:00:00.000Z");
    const expired = sessionRow({
      metadata: JSON.stringify({
        ownerId: "worker-1",
        leaseExpiresAt: "2026-01-01T00:30:00.000Z",
      }),
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:storage-time", rows: [{ now: databaseNow }] },
      { tag: "sessions:session-lock", rows: [expired] },
      { tag: "sessions:storage-time", rows: [{ now: databaseNow }] },
    ]);
    const store = new PostgresSessionStore({ queryable: db, transactions: db });
    await expect(store.currentTime()).resolves.toBe(databaseNow.toISOString());
    await expect(store.setMetadata("sess-pg", {
      ownerId: "worker-1",
      leaseExpiresAt: "2026-01-01T02:00:00.000Z",
    }, { ownerId: "worker-1" })).rejects.toMatchObject({
      code: "SESS_OWNERSHIP_LOST",
    });
    db.expectDone();
  });

  it("fences owner-bound metadata renewal and close after lease expiry", async () => {
    const expired = sessionRow({
      metadata: JSON.stringify({
        ownerId: "worker-1",
        leaseExpiresAt: "2026-01-01T00:30:00.000Z",
      }),
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:session-lock", rows: [expired] },
      { tag: "sessions:session-lock", rows: [expired] },
    ]);
    const store = storeWith(db);
    await expect(store.setMetadata("sess-pg", {
      ownerId: "worker-1",
      leaseExpiresAt: "2026-01-01T02:00:00.000Z",
    }, { ownerId: "worker-1" })).rejects.toMatchObject({
      code: "SESS_OWNERSHIP_LOST",
    });
    await expect(store.transitionSession(
      "sess-pg",
      "active",
      "closed",
      "2026-01-01T01:00:00.000Z",
      { ownerId: "worker-1" },
    )).rejects.toMatchObject({ code: "SESS_OWNERSHIP_LOST" });
    db.expectDone();
  });

  it("allocates seq while holding the session lock and retries by eventId", async () => {
    const event = createEvent("session.created", { sessionId: "sess-pg" }, {
      eventId: "evt-pg-0",
      at: "2026-01-01T00:00:00.000Z",
      actor: "kernel",
    });
    const storedRow = eventRow(event, 0, 41);
    const db = new ScriptedDatabase([
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:session-lock", rows: [sessionRow()] },
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:global-seq-allocate", rows: [{ global_seq: "41" }] },
      { tag: "sessions:event-insert", rows: [storedRow] },
      { tag: "sessions:next-seq-advance", rowCount: 1 },
      // Same ID after a later close is still an idempotent success and never
      // reaches a status check or sequence allocation.
      { tag: "sessions:event-by-id", rows: [storedRow] },
    ]);
    const store = storeWith(db);
    const first = await store.appendEvent("sess-pg", event);
    const retry = await store.appendEvent("sess-pg", event);
    expect(first).toMatchObject({ seq: 0, globalSeq: 41 });
    expect(retry).toEqual(first);
    expect(db.transactionRuns).toBe(2);
    const allocationIndex = db.calls.findIndex((call) =>
      call.text.includes("sessions:global-seq-allocate"));
    const insertIndex = db.calls.findIndex((call) => call.text.includes("sessions:event-insert"));
    expect(allocationIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(allocationIndex);
    expect(db.calls[insertIndex]!.text).toContain("global_seq, session_id");
    expect(db.calls[insertIndex]!.values[0]).toBe(41);
    db.expectDone();
  });

  it("rejects a new closed-session append and conflicting eventId reuse", async () => {
    const event = createEvent("session.created", { sessionId: "sess-pg" }, {
      eventId: "evt-new-after-close",
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:session-lock", rows: [sessionRow({ status: "closed" })] },
      { tag: "sessions:event-by-id", rows: [] },
      {
        tag: "sessions:event-by-id",
        rows: [eventRow({ ...event, data: { sessionId: "another" } } as AnyHarnessEvent, 0, 1)],
      },
    ]);
    const store = storeWith(db);
    await expect(store.appendEvent("sess-pg", event)).rejects.toMatchObject({
      code: "SESS_CLOSED",
    });
    await expect(store.appendEvent("sess-pg", event)).rejects.toMatchObject({
      code: "SESS_EVENT_CONFLICT",
    });
    db.expectDone();
  });

  it("fences owner-bound appends under the lock while preserving retries and unowned logs", async () => {
    const committed = createEvent("task.updated", {
      taskId: "m4",
      phase: "running",
    }, { eventId: "evt-owned-committed" });
    const wrongOwner = createEvent("task.updated", {
      taskId: "m4",
      phase: "verifying",
    }, { eventId: "evt-owned-wrong-owner" });
    const expired = createEvent("task.updated", {
      taskId: "m4",
      phase: "blocked",
    }, { eventId: "evt-owned-expired" });
    const generic = createEvent("task.updated", {
      taskId: "m4-audit",
      phase: "running",
    }, { eventId: "evt-unowned-generic" });
    const committedRow = eventRow(committed, 0, 60);
    const genericRow = eventRow(generic, 1, 61);
    const db = new ScriptedDatabase([
      {
        tag: "sessions:session-lock",
        rows: [sessionRow({
          metadata: JSON.stringify({
            ownerId: "worker-1",
            leaseExpiresAt: "2026-01-01T02:00:00.000Z",
          }),
        })],
      },
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:global-seq-allocate", rows: [{ global_seq: "60" }] },
      { tag: "sessions:event-insert", rows: [committedRow] },
      { tag: "sessions:next-seq-advance", rowCount: 1 },
      // Wrong owner is rejected after the session lock and duplicate recheck,
      // before consuming a global audit sequence.
      {
        tag: "sessions:session-lock",
        rows: [sessionRow({
          next_seq: "1",
          metadata: JSON.stringify({
            ownerId: "worker-2",
            leaseExpiresAt: "2026-01-01T02:00:00.000Z",
          }),
        })],
      },
      { tag: "sessions:event-by-id", rows: [] },
      // Matching owner with an expired lease is also fenced before allocation.
      {
        tag: "sessions:session-lock",
        rows: [sessionRow({
          next_seq: "1",
          metadata: JSON.stringify({
            ownerId: "worker-1",
            leaseExpiresAt: "2026-01-01T02:00:00.000Z",
          }),
        })],
      },
      { tag: "sessions:event-by-id", rows: [] },
      // Even a committed owner-bound retry must prove a live lease under lock.
      {
        tag: "sessions:session-lock",
        rows: [sessionRow({
          status: "closed",
          next_seq: "1",
          metadata: JSON.stringify({
            ownerId: "worker-1",
            leaseExpiresAt: "2026-01-01T02:00:00.000Z",
          }),
        })],
      },
      { tag: "sessions:event-by-id", rows: [committedRow] },
      // The same retry remains idempotent through an explicitly unowned log.
      { tag: "sessions:event-by-id", rows: [committedRow] },
      // An unowned control-plane log retains the generic append behavior.
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:session-lock", rows: [sessionRow({ next_seq: "1" })] },
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:global-seq-allocate", rows: [{ global_seq: "61" }] },
      { tag: "sessions:event-insert", rows: [genericRow] },
      { tag: "sessions:next-seq-advance", rowCount: 1 },
    ]);
    let now = "2026-01-01T01:00:00.000Z";
    const store = new PostgresSessionStore({
      queryable: db,
      transactions: db,
      now: () => now,
    });
    const owned = store.eventLog("sess-pg", { ownerId: "worker-1" });
    expect(await owned.appendSequenced(committed)).toMatchObject({ globalSeq: 60 });
    await expect(owned.append(wrongOwner)).rejects.toMatchObject({
      code: "SESS_OWNERSHIP_LOST",
    });
    now = "2026-01-01T03:00:00.000Z";
    await expect(owned.append(expired)).rejects.toMatchObject({
      code: "SESS_OWNERSHIP_LOST",
    });
    await expect(owned.append(committed)).rejects.toMatchObject({
      code: "SESS_OWNERSHIP_LOST",
    });
    expect(await store.eventLog("sess-pg").append(committed)).toBe(0);
    expect(await store.eventLog("sess-pg").appendSequenced(generic)).toMatchObject({
      globalSeq: 61,
    });
    expect(db.calls.filter((call) =>
      call.text.includes("sessions:global-seq-allocate"))).toHaveLength(2);
    db.expectDone();
  });

  it("returns bounded session and global audit pages with canonical cursors", async () => {
    const a = createEvent("session.created", { sessionId: "sess-pg" }, {
      eventId: "evt-page-a",
    });
    const b = createEvent("task.updated", { taskId: "m4", phase: "running" }, {
      eventId: "evt-page-b",
    });
    const c = createEvent("task.updated", { taskId: "m4", phase: "verifying" }, {
      eventId: "evt-page-c",
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:session-exists", rows: [{ found: 1 }] },
      {
        tag: "sessions:event-page",
        values: ["sess-pg", -1, 3],
        rows: [eventRow(a, 0, 10), eventRow(b, 1, 11), eventRow(c, 2, 12)],
      },
      {
        tag: "sessions:audit-page",
        values: [10, 2],
        rows: [eventRow(b, 1, 11), eventRow(c, 2, 12)],
      },
    ]);
    const store = storeWith(db);
    const session = await store.readSessionEvents("sess-pg", { afterSeq: -1, limit: 2 });
    expect(session.events.map((item) => item.seq)).toEqual([0, 1]);
    expect(session.nextAfterSeq).toBe(1);
    expect(session.hasMore).toBe(true);
    const audit = await store.readAuditEvents({ afterGlobalSeq: 10, limit: 1 });
    expect(audit.events.map((item) => item.globalSeq)).toEqual([11]);
    expect(audit.nextAfterGlobalSeq).toBe(11);
    expect(audit.hasMore).toBe(true);
    db.expectDone();
  });

  it("keeps checkpoint cursors monotonic, retries idempotently, and transitions under a lock", async () => {
    const checkpointRow = sessionRow({
      next_seq: "1",
      checkpoint_revision: "1",
      checkpoint_seq: "0",
      checkpoint_payload: JSON.stringify({ step: 1 }),
      checkpoint_updated_at: "2026-01-01T00:02:00.000Z",
    });
    const closed = sessionRow({
      status: "closed",
      closed_at: "2026-01-01T00:03:00.000Z",
      next_seq: "1",
      checkpoint_revision: "1",
      checkpoint_seq: "0",
      checkpoint_payload: JSON.stringify({ step: 1 }),
      checkpoint_updated_at: "2026-01-01T00:02:00.000Z",
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:session-lock", rows: [sessionRow({ next_seq: "1" })] },
      { tag: "sessions:checkpoint-save", rows: [checkpointRow] },
      { tag: "sessions:session-lock", rows: [checkpointRow] },
      { tag: "sessions:session-lock", rows: [checkpointRow] },
      { tag: "sessions:checkpoint-get", rows: [checkpointRow] },
      { tag: "sessions:session-lock", rows: [checkpointRow] },
      { tag: "sessions:session-transition", rows: [closed] },
    ]);
    const store = storeWith(db);
    const saved = await store.saveCheckpoint("sess-pg", {
      expectedRevision: 0,
      afterSeq: 0,
      payload: { step: 1 },
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    expect(saved).toMatchObject({ revision: 1, afterSeq: 0, payload: { step: 1 } });
    expect(await store.saveCheckpoint("sess-pg", {
      expectedRevision: 0,
      afterSeq: 0,
      payload: { step: 1 },
      updatedAt: "2026-01-01T00:02:30.000Z",
    })).toEqual(saved);
    await expect(store.saveCheckpoint("sess-pg", {
      expectedRevision: 1,
      afterSeq: -1,
      payload: { step: 0 },
    })).rejects.toMatchObject({ code: "SESS_CHECKPOINT_CONFLICT" });
    expect(await store.getCheckpoint("sess-pg")).toEqual(saved);
    const transition = await store.transitionSession(
      "sess-pg",
      "active",
      "closed",
      "2026-01-01T00:03:00.000Z",
    );
    expect(transition).toMatchObject({ changed: true, record: { status: "closed" } });
    db.expectDone();
  });

  it("atomically appends an interrupted restore event and closes only once", async () => {
    const restored = createEvent("session.restored", {
      sessionId: "sess-pg",
      afterSeq: -1,
      availableThroughSeq: 0,
      availableEvents: 1,
      outcome: "interrupted",
    }, {
      eventId: "evt-pg-restore",
      at: "2026-01-01T00:04:00.000Z",
    });
    const restoredRow = eventRow(restored, 1, 52);
    const closed = sessionRow({
      status: "closed",
      next_seq: "2",
      closed_at: "2026-01-01T00:04:00.000Z",
    });
    const db = new ScriptedDatabase([
      { tag: "sessions:session-lock", rows: [sessionRow({ next_seq: "1" })] },
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:event-by-id", rows: [] },
      { tag: "sessions:global-seq-allocate", rows: [{ global_seq: "52" }] },
      { tag: "sessions:event-insert", rows: [restoredRow] },
      { tag: "sessions:next-seq-advance", rowCount: 1 },
      { tag: "sessions:recover-close", rows: [closed] },
      // Idempotent retry sees the closed row and previously committed event.
      { tag: "sessions:session-lock", rows: [closed] },
      { tag: "sessions:event-by-id", rows: [restoredRow] },
    ]);
    const store = storeWith(db);
    const first = await store.recoverInterrupted(
      "sess-pg",
      restored,
      "2026-01-01T00:04:00.000Z",
    );
    expect(first).toMatchObject({
      recovered: true,
      record: { status: "closed" },
      event: { seq: 1, globalSeq: 52 },
    });
    const retry = await store.recoverInterrupted("sess-pg", restored);
    expect(retry).toMatchObject({ recovered: false, event: { seq: 1 } });
    expect(db.transactionRuns).toBe(2);
    db.expectDone();
  });

  it("rejects recovery when the validated owner metadata changed before the lock", async () => {
    const restored = createEvent("session.restored", {
      sessionId: "sess-pg",
      afterSeq: -1,
      availableThroughSeq: -1,
      availableEvents: 0,
      outcome: "interrupted",
    }, { eventId: "evt-pg-stale-restore" });
    const db = new ScriptedDatabase([
      {
        tag: "sessions:session-lock",
        rows: [sessionRow({
          metadata: JSON.stringify({
            ownerId: "worker-1",
            leaseExpiresAt: "2026-01-01T00:02:00.000Z",
          }),
        })],
      },
    ]);
    const store = storeWith(db);
    await expect(store.recoverInterrupted(
      "sess-pg",
      restored,
      undefined,
      {
        ownerId: "worker-1",
        leaseExpiresAt: "2026-01-01T00:01:00.000Z",
      },
    )).rejects.toMatchObject({ code: "SESS_RECOVERY_CONFLICT" });
    db.expectDone();
  });
});

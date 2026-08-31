import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEvent,
  deserializeEvent,
  EventSchemaError,
  EventVersionError,
  UnknownEventTypeError,
} from "@harness/events";
import {
  getSessionRecord,
  listSessions,
  openSqliteSession,
  openSqliteStore,
  SessionStoreError,
  setSessionStatus,
} from "../src/index";

let dir: string;
let dbPath: string;

function makeSession(taskId?: string) {
  return openSqliteSession(dbPath, { taskId, createdAt: "2026-01-01T00:00:00.000Z" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-sess-"));
  dbPath = join(dir, "runs", "sessions.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteEventLog", () => {
  it("appends with monotonic sequence numbers and reports size", async () => {
    const s = makeSession("kernel-0001");
    try {
      for (let i = 0; i < 3; i++) {
        const seq = await s.log.append(
          createEvent("model.request", {
            requestId: `req-${i}`,
            model: "fake-model/v1",
            messageCount: i + 1,
          }),
        );
        expect(seq).toBe(i);
      }
      expect(await s.log.size()).toBe(3);
    } finally {
      s.close();
    }
  });

  it("round-trips every stored frame through the wire schema", async () => {
    const s = makeSession("kernel-0001");
    try {
      const original = createEvent(
        "tool.result",
        {
          callId: "call-1",
          tool: "echo",
          ok: true,
          output: { answer: 42 },
          durationMs: 3,
        },
        { at: "2026-01-01T00:00:05.000Z", actor: "kernel" },
      );
      await s.log.append(original);
      const [back] = await s.log.slice(0, 1);
      expect(back).toEqual(original);
      // Read path is schema-validated (not a raw JSON pass-through).
      expect(() => deserializeEvent(JSON.stringify(back))).not.toThrow();
    } finally {
      s.close();
    }
  });

  it("slice honors the [from, to) range", async () => {
    const s = makeSession();
    try {
      for (let i = 0; i < 5; i++) {
        await s.log.append(
          createEvent("task.updated", { taskId: "t", phase: "running" }, {
            at: `2026-01-01T00:00:0${i}.000Z`,
          }),
        );
      }
      const slice = await s.log.slice(1, 3);
      expect(slice).toHaveLength(2);
      expect(slice.map((e) => e.at)).toEqual([
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
      ]);
    } finally {
      s.close();
    }
  });

  it("uses eventId as an idempotency key and rejects conflicting reuse", async () => {
    const s = makeSession();
    try {
      const event = createEvent("task.updated", {
        taskId: "t",
        phase: "running",
      }, {
        eventId: "evt-idempotent",
        at: "2026-01-01T00:00:00.000Z",
      });
      expect(await s.log.append(event)).toBe(0);
      expect(await s.log.append(event)).toBe(0);
      expect(await s.log.size()).toBe(1);

      const conflict = createEvent("task.updated", {
        taskId: "t",
        phase: "blocked",
      }, {
        eventId: "evt-idempotent",
        at: "2026-01-01T00:00:00.000Z",
      });
      await expect(s.log.append(conflict)).rejects.toMatchObject({
        code: "SESS_EVENT_CONFLICT",
      });
    } finally {
      s.close();
    }
  });

  it("rejects new events after close but accepts a retry of a committed event", async () => {
    const s = makeSession();
    const committed = createEvent("session.created", {
      sessionId: s.sessionId,
    }, {
      eventId: "evt-before-close",
      at: "2026-01-01T00:00:00.000Z",
    });
    try {
      expect(await s.log.append(committed)).toBe(0);
      setSessionStatus(dbPath, s.sessionId, "closed", "2026-01-01T01:00:00.000Z");
      expect(await s.log.append(committed)).toBe(0);
      await expect(s.log.append(createEvent("error", {
        code: "TOO_LATE",
        message: "new append",
      }))).rejects.toMatchObject({ code: "SESS_CLOSED" });
      expect(await s.log.size()).toBe(1);
    } finally {
      s.close();
    }
  });

  it("reads canonical sequence pages using a last-seen cursor", async () => {
    const s = makeSession();
    try {
      for (let index = 0; index < 3; index++) {
        await s.log.append(createEvent("task.updated", {
          taskId: "t",
          phase: "running",
          note: String(index),
        }, { eventId: `evt-page-${index}` }));
      }
      const first = await s.log.read({ afterSeq: -1, limit: 2 });
      expect(first.events.map((item) => item.seq)).toEqual([0, 1]);
      expect(first.nextAfterSeq).toBe(1);
      expect(first.hasMore).toBe(true);
      const second = await s.log.read({ afterSeq: first.nextAfterSeq, limit: 2 });
      expect(second.events.map((item) => item.seq)).toEqual([2]);
      expect(second.hasMore).toBe(false);
    } finally {
      s.close();
    }
  });

  it("fences owner-bound appends and validates committed retries with the store clock", async () => {
    let now = "2026-01-01T01:00:00.000Z";
    const store = openSqliteStore(dbPath, { now: () => now });
    try {
      const session = await store.createSession({
        sessionId: "sess-owned",
        metadata: {
          ownerId: "worker-1",
          leaseExpiresAt: "2026-01-01T02:00:00.000Z",
        },
      });
      const committed = createEvent("task.updated", {
        taskId: "owned-task",
        phase: "running",
      }, { eventId: "evt-owned-sqlite" });
      const owned = store.eventLog(session.sessionId, { ownerId: "worker-1" });
      expect(await owned.append(committed)).toBe(0);
      await expect(store.eventLog(session.sessionId, {
        ownerId: "worker-2",
      }).append(createEvent("task.updated", {
        taskId: "owned-task",
        phase: "verifying",
      }, { eventId: "evt-wrong-owner-sqlite" }))).rejects.toMatchObject({
        code: "SESS_OWNERSHIP_LOST",
      });

      now = "2026-01-01T03:00:00.000Z";
      await expect(owned.append(createEvent("task.updated", {
        taskId: "owned-task",
        phase: "blocked",
      }, { eventId: "evt-expired-owner-sqlite" }))).rejects.toMatchObject({
        code: "SESS_OWNERSHIP_LOST",
      });
      await expect(store.setMetadata(session.sessionId, {
        ownerId: "worker-1",
        leaseExpiresAt: "2026-01-01T04:00:00.000Z",
      }, { ownerId: "worker-1" })).rejects.toMatchObject({
        code: "SESS_OWNERSHIP_LOST",
      });
      await expect(store.transitionSession(
        session.sessionId,
        "active",
        "closed",
        now,
        { ownerId: "worker-1" },
      )).rejects.toMatchObject({ code: "SESS_OWNERSHIP_LOST" });
      await store.transitionSession(session.sessionId, "active", "closed");
      await expect(owned.append(committed)).rejects.toMatchObject({
        code: "SESS_OWNERSHIP_LOST",
      });
      // Explicitly unowned service logs preserve committed retry semantics.
      expect(await store.eventLog(session.sessionId).append(committed)).toBe(0);
      expect(await owned.size()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("rejects a frame whose payload fails the wire schema (typed error)", async () => {
    const s = makeSession();
    try {
      const bad = {
        v: 1,
        type: "agent.stopped",
        eventId: "evt-bad",
        at: "2026-01-01T00:00:00.000Z",
        data: { agentId: "a", status: "not-a-status", steps: 1, toolCalls: 0 },
      } as never;
      await expect(s.log.append(bad)).rejects.toThrow(EventSchemaError);
      expect(await s.log.size()).toBe(0);
    } finally {
      s.close();
    }
  });

  it("throws typed errors when reading corrupted frames (no silent fallback)", async () => {
    const s = makeSession();
    await s.log.append(
      createEvent("session.created", { sessionId: s.sessionId }, {
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    s.close();

    // Corrupt one stored frame directly at the byte level.
    const db = new DatabaseSync(dbPath);
    const corrupt = (mutation: (payload: string) => string) => {
      const rows = db
        .prepare(
          "SELECT e.payload FROM events e WHERE e.session_id = ? ORDER BY e.seq",
        )
        .all(s.sessionId) as { payload: string }[];
      const last = rows[rows.length - 1];
      if (!last) throw new Error("expected a stored frame");
      db.prepare(
        "UPDATE events SET payload = ? WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM events WHERE session_id = ?)",
      ).run(mutation(last.payload), s.sessionId, s.sessionId);
    };

    // Unknown envelope version
    corrupt((p) =>
      JSON.stringify({ ...JSON.parse(p), v: 99 }),
    );
    const s2 = openSqliteSession(dbPath, { sessionId: s.sessionId });
    await expect(s2.log.slice(0, 1)).rejects.toThrow(EventVersionError);
    s2.close();

    // Unknown event type (version reset to a valid one)
    corrupt((p) =>
      JSON.stringify({ ...JSON.parse(p), v: 1, type: "payload.exfiltrated" }),
    );
    const s3 = openSqliteSession(dbPath, { sessionId: s.sessionId });
    await expect(s3.log.slice(0, 1)).rejects.toThrow(UnknownEventTypeError);
    s3.close();

    // Broken JSON is a hard parse error, never a partial event.
    corrupt((p) => p.slice(0, Math.floor(p.length / 2)));
    const { EventParseError } = await import("@harness/events");
    const s5 = openSqliteSession(dbPath, { sessionId: s.sessionId });
    await expect(s5.log.slice(0, 1)).rejects.toThrow(EventParseError);
    s5.close();
  });
});

describe("session records", () => {
  it("creates, updates and lists sessions", () => {
    const a = makeSession("kernel-0001");
    a.close();
    const b = makeSession("m1-tui");
    b.close();

    const record = getSessionRecord(dbPath, a.sessionId);
    expect(record.taskId).toBe("kernel-0001");
    expect(record.status).toBe("active");

    setSessionStatus(dbPath, a.sessionId, "closed", "2026-01-02T00:00:00.000Z");
    const closed = getSessionRecord(dbPath, a.sessionId);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBe("2026-01-02T00:00:00.000Z");

    const all = listSessions(dbPath);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.sessionId)).toContain(a.sessionId);
  });

  it("supports metadata and compare-and-swap checkpoints", async () => {
    const store = openSqliteStore(dbPath);
    try {
      const session = await store.createSession({
        sessionId: "sess-checkpoint",
        taskId: "kernel-0001",
        metadata: { worker: "worker-1" },
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(session.metadata).toEqual({ worker: "worker-1" });
      await store.appendEvent(session.sessionId, createEvent("session.created", {
        sessionId: session.sessionId,
      }, { eventId: "evt-checkpoint-0" }));
      const checkpoint = await store.saveCheckpoint(session.sessionId, {
        expectedRevision: 0,
        afterSeq: 0,
        payload: { step: 1, transcript: ["safe-boundary"] },
        updatedAt: "2026-01-01T00:01:00.000Z",
      });
      expect(checkpoint).toMatchObject({ revision: 1, afterSeq: 0 });
      expect(await store.saveCheckpoint(session.sessionId, {
        expectedRevision: 0,
        afterSeq: 0,
        payload: { step: 1, transcript: ["safe-boundary"] },
        updatedAt: "2026-01-01T00:02:00.000Z",
      })).toEqual(checkpoint);
      await expect(store.saveCheckpoint(session.sessionId, {
        expectedRevision: 1,
        afterSeq: -1,
        payload: { step: 0 },
      })).rejects.toMatchObject({ code: "SESS_CHECKPOINT_CONFLICT" });
      expect(await store.getCheckpoint(session.sessionId)).toEqual(checkpoint);
      await expect(store.saveCheckpoint(session.sessionId, {
        expectedRevision: 0,
        afterSeq: 0,
        payload: {},
      })).rejects.toMatchObject({ code: "SESS_CHECKPOINT_CONFLICT" });
      expect((await store.setMetadata(session.sessionId, { worker: "worker-2" })).metadata)
        .toEqual({ worker: "worker-2" });
    } finally {
      store.close();
    }
  });

  it("atomically records interrupted recovery once and closes the session", async () => {
    const store = openSqliteStore(dbPath);
    try {
      const session = await store.createSession({
        sessionId: "sess-recover",
        metadata: { ownerId: "worker-1", leaseExpiresAt: "2026-01-01T00:01:00.000Z" },
      });
      await store.appendEvent(session.sessionId, createEvent("session.created", {
        sessionId: session.sessionId,
      }, { eventId: "evt-recover-created" }));
      const restored = createEvent("session.restored", {
        sessionId: session.sessionId,
        afterSeq: -1,
        availableThroughSeq: 0,
        availableEvents: 1,
        outcome: "interrupted",
        note: "worker died mid-turn; turn was not re-executed",
      }, {
        eventId: "evt-recover-once",
        at: "2026-01-01T00:02:00.000Z",
      });
      const refreshed = await store.setMetadata(session.sessionId, {
        ownerId: "worker-1",
        leaseExpiresAt: "2026-01-01T00:01:30.000Z",
      });
      await expect(store.recoverInterrupted(
        session.sessionId,
        restored,
        "2026-01-01T00:02:00.000Z",
        session.metadata,
      )).rejects.toMatchObject({ code: "SESS_RECOVERY_CONFLICT" });

      const first = await store.recoverInterrupted(
        session.sessionId,
        restored,
        "2026-01-01T00:02:00.000Z",
        refreshed.metadata,
      );
      expect(first.recovered).toBe(true);
      expect(first.event?.seq).toBe(1);
      expect(first.record.status).toBe("closed");

      const retry = await store.recoverInterrupted(session.sessionId, restored);
      expect(retry.recovered).toBe(false);
      expect(retry.event?.seq).toBe(1);
      expect((await store.readSessionEvents(session.sessionId)).events).toHaveLength(2);
      await expect(store.setMetadata(session.sessionId, {
        ownerId: "stale-worker",
      })).rejects.toMatchObject({ code: "SESS_CLOSED" });
    } finally {
      store.close();
    }
  });

  it("provides one store-wide audit cursor across sessions", async () => {
    const store = openSqliteStore(dbPath);
    try {
      const a = await store.createSession({ sessionId: "sess-a" });
      const b = await store.createSession({ sessionId: "sess-b" });
      await store.appendEvent(a.sessionId, createEvent("session.created", {
        sessionId: a.sessionId,
      }, { eventId: "evt-global-a" }));
      await store.appendEvent(b.sessionId, createEvent("session.created", {
        sessionId: b.sessionId,
      }, { eventId: "evt-global-b" }));
      const first = await store.readAuditEvents({ afterGlobalSeq: -1, limit: 1 });
      expect(first.events).toHaveLength(1);
      expect(first.hasMore).toBe(true);
      const second = await store.readAuditEvents({
        afterGlobalSeq: first.nextAfterGlobalSeq,
        limit: 1,
      });
      expect(second.events).toHaveLength(1);
      expect(second.events[0]!.globalSeq).toBeGreaterThan(first.events[0]!.globalSeq);
      expect(new Set([
        first.events[0]!.sessionId,
        second.events[0]!.sessionId,
      ])).toEqual(new Set([a.sessionId, b.sessionId]));
    } finally {
      store.close();
    }
  });

  it("re-opens the same session with its existing record", () => {
    const first = makeSession("kernel-0001");
    const id = first.sessionId;
    first.close();

    const second = openSqliteSession(dbPath, {
      sessionId: id,
    });
    expect(second.record.sessionId).toBe(id);
    expect(second.record.createdAt).toBe("2026-01-01T00:00:00.000Z");
    second.close();
  });

  it("fails with a typed error for unknown sessions", () => {
    expect(() => getSessionRecord(dbPath, "sess-nope")).toThrowError(
      SessionStoreError,
    );
    const s = makeSession();
    try {
      expect(() => getSessionRecord(dbPath, "sess-nope")).toThrowError(
        /not found/,
      );
    } finally {
      s.close();
    }
  });
});

describe("file-level helpers", () => {
  it("persists across close/re-open of the raw database", async () => {
    const s = makeSession("kernel-0001");
    await s.log.append(
      createEvent("session.created", { sessionId: s.sessionId }),
    );
    s.close();

    // A fresh process-equivalent handle sees the same data.
    const db = new DatabaseSync(dbPath);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});

describe("store file layout", () => {
  it("migrates the M1 schema in place without changing existing event order", async () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions (session_id),
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    const event = createEvent("session.created", { sessionId: "sess-legacy" }, {
      eventId: "evt-legacy",
      at: "2026-01-01T00:00:00.000Z",
    });
    legacy.prepare(
      "INSERT INTO sessions (session_id, task_id, status, created_at) VALUES (?, ?, 'active', ?)",
    ).run("sess-legacy", "m1-sessions-sqlite", "2026-01-01T00:00:00.000Z");
    legacy.prepare(
      "INSERT INTO events (session_id, seq, event_id, at, actor, type, payload) VALUES (?, 0, ?, ?, NULL, ?, ?)",
    ).run("sess-legacy", event.eventId, event.at, event.type, JSON.stringify(event));
    legacy.close();

    const migrated = openSqliteSession(dbPath, { sessionId: "sess-legacy" });
    try {
      expect((await migrated.log.read()).events.map((item) => item.seq)).toEqual([0]);
      expect(await migrated.log.append(createEvent("task.updated", {
        taskId: "m1-sessions-sqlite",
        phase: "delivered",
      }, { eventId: "evt-after-migration" }))).toBe(1);
      const db = new DatabaseSync(dbPath);
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string };
      db.close();
      expect(version.value).toBe("2");
    } finally {
      migrated.close();
    }
  });

  it("refuses to write to an uncreatable location with a plain error", () => {
    const blockedParent = join(dir, "afile");
    writeFileSync(blockedParent, "i am a file, not a directory");
    const blocked = join(blockedParent, "x", "sessions.sqlite");
    expect(() => openSqliteSession(blocked)).toThrow();
  });
});

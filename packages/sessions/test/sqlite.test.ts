import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("refuses to write to an uncreatable location with a plain error", () => {
    const blockedParent = join(dir, "afile");
    writeFileSync(blockedParent, "i am a file, not a directory");
    const blocked = join(blockedParent, "x", "sessions.sqlite");
    expect(() => openSqliteSession(blocked)).toThrow();
  });
});

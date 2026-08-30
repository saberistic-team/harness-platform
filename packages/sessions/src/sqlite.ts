import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deserializeEvent,
  serializeEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import type { EventLog, SessionRecord, SessionStatus } from "./index";

/**
 * SQLite persistence for session logs — the durable store behind the
 * in-memory log (M1). Backed by Node's built-in `node:sqlite`, so the
 * platform adds no native dependency and no network install.
 *
 * Invariants (mirroring the in-memory log):
 *  - The event log is append-only; corrections are new events.
 *  - Every frame is validated against the wire schema on BOTH write
 *    and read. Unknown envelope versions and unknown event types are
 *    typed errors, never a silent best-effort parse (rule 4).
 *  - The session row is the identity (id, task, status, timestamps);
 *    events reference it and carry their own `seq` within it.
 *
 * Note on concurrency: this store assumes a single writer per file
 * (one harness process per run). The sandbox-runner (M3) serializes
 * access to a session at the process boundary.
 */

export const SESSIONS_SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'archived')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

/**
 * A typed store error. Distinct names let callers (CLI, TUI, services)
 * react precisely instead of string-matching.
 */
export class SessionStoreError extends Error {
  constructor(
    readonly code:
      | "SESS_NOT_FOUND"
      | "SESS_INVALID_RECORD"
      | "SESS_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export class SqliteEventLog implements EventLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionId: string,
  ) {}

  async append(event: AnyHarnessEvent): Promise<number> {
    // Validate on the wire before it touches the disk: the store must
    // never accumulate frames this build cannot decode.
    const wire = serializeEvent(event);
    deserializeEvent(wire);

    const obj = JSON.parse(wire) as AnyHarnessEvent;
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?",
      )
      .get(this.sessionId) as { next: number };
    this.db
      .prepare(
        "INSERT INTO events (session_id, seq, event_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.sessionId,
        row.next,
        obj.eventId,
        obj.at,
        obj.actor ?? null,
        obj.type,
        wire,
      );
    return row.next;
  }

  async slice(from: number, to?: number): Promise<AnyHarnessEvent[]> {
    const lo = Math.max(0, from);
    if (to === undefined) {
      const rows = this.db
        .prepare(
          "SELECT payload FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq",
        )
        .all(this.sessionId, lo) as { payload: string | number | Record<string, never> }[];
      return rows.map((r) => deserializeEvent(String(r.payload)));
    }
    const hi = Math.max(lo, to);
    const rows = this.db
      .prepare(
        "SELECT payload FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
      )
      .all(this.sessionId, lo, hi) as { payload: string | number | Record<string, never> }[];
    return rows.map((r) => deserializeEvent(String(r.payload)));
  }

  async size(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get(this.sessionId) as { n: number };
    return row.n;
  }
}

export interface OpenedSession {
  sessionId: string;
  record: SessionRecord;
  log: SqliteEventLog;
  /** Close the underlying database handle. */
  close(): void;
}

export interface OpenSessionOptions {
  taskId?: string;
  /** Re-open an existing session instead of creating a new one. */
  sessionId?: string;
  createdAt?: string;
}

/**
 * Open (or create) a session in the SQLite store at `dbPath`.
 * Creates parent directories as needed.
 */
export function openSqliteSession(
  dbPath: string,
  opts: OpenSessionOptions = {},
): OpenedSession {
  const dir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SESSIONS_SCHEMA_VERSION),
  );

  const sessionId = opts.sessionId ?? `sess-${randomUUID()}`;
  interface Row {
    task_id: string | null;
    status: string;
    created_at: string;
    closed_at: string | null;
  }
  let existing = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as Row | undefined;

  if (existing) {
    if (opts.taskId && !existing.task_id) {
      db.prepare("UPDATE sessions SET task_id = ? WHERE session_id = ?").run(
        opts.taskId,
        sessionId,
      );
      existing.task_id = opts.taskId;
    }
  } else {
    db.prepare(
      "INSERT INTO sessions (session_id, task_id, status, created_at) VALUES (?, ?, 'active', ?)",
    ).run(
      sessionId,
      opts.taskId ?? null,
      opts.createdAt ?? new Date().toISOString(),
    );
    existing = {
      task_id: opts.taskId ?? null,
      status: "active",
      created_at: opts.createdAt ?? new Date().toISOString(),
      closed_at: null,
    };
  }
  if (existing === undefined) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "failed to load session row");
  }

  const record: SessionRecord = {
    sessionId,
    taskId: existing.task_id ?? undefined,
    status: existing.status as SessionStatus,
    createdAt: existing.created_at,
    closedAt: existing.closed_at ?? undefined,
  };

  return {
    sessionId,
    record,
    log: new SqliteEventLog(db, sessionId),
    close: () => db.close(),
  };
}

/** Read back a session record without opening its log. */
export function getSessionRecord(dbPath: string, sessionId: string): SessionRecord {
  if (!existsSync(dbPath)) {
    throw new SessionStoreError(
      "SESS_NOT_FOUND",
      `no session store at ${dbPath} (nothing to read)`,
    );
  }
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as
      | {
          task_id: string | null;
          status: string;
          created_at: string;
          closed_at: string | null;
          event_count?: number;
        }
      | undefined;
    if (!row) {
      throw new SessionStoreError(
        "SESS_NOT_FOUND",
        `session "${sessionId}" not found in ${dbPath}`,
      );
    }
    return {
      sessionId,
      taskId: row.task_id ?? undefined,
      status: row.status as SessionStatus,
      createdAt: row.created_at,
      closedAt: row.closed_at ?? undefined,
    };
  } finally {
    db.close();
  }
}

export interface SessionListing extends SessionRecord {
  eventCount: number;
}

/** List all sessions in the store, most recently created first. */
export function listSessions(dbPath: string): SessionListing[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT s.session_id, s.task_id, s.status, s.created_at, s.closed_at,
                (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
         FROM sessions s
         ORDER BY s.created_at DESC, s.session_id DESC`,
      )
      .all() as {
      session_id: string;
      task_id: string | null;
      status: string;
      created_at: string;
      closed_at: string | null;
      event_count: number;
    }[];
    return rows.map((r) => ({
      sessionId: r.session_id,
      taskId: r.task_id ?? undefined,
      status: r.status as SessionStatus,
      createdAt: r.created_at,
      closedAt: r.closed_at ?? undefined,
      eventCount: r.event_count,
    }));
  } finally {
    db.close();
  }
}

/** Update a session's status; records `closedAt` when closing. */
export function setSessionStatus(
  dbPath: string,
  sessionId: string,
  status: SessionStatus,
  at?: string,
): void {
  if (!existsSync(dbPath)) {
    throw new SessionStoreError(
      "SESS_NOT_FOUND",
      `no session store at ${dbPath} (nothing to update)`,
    );
  }
  const db = new DatabaseSync(dbPath);
  try {
    const r = db
      .prepare(
        "UPDATE sessions SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END WHERE session_id = ?",
      )
      .run(status, status, at ?? new Date().toISOString(), sessionId);
    if (r.changes === 0) {
      throw new SessionStoreError(
        "SESS_NOT_FOUND",
        `session "${sessionId}" not found in ${dbPath}`,
      );
    }
  } finally {
    db.close();
  }
}

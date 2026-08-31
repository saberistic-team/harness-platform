import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  deserializeEvent,
  serializeEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import {
  assertAppendOwnership,
  assertRecoveryLeaseExpired,
  assertOwnerId,
  assertSessionId,
  assertStatusTransition,
  decodeMetadata,
  decodeSessionJson,
  encodeMetadata,
  encodeSessionJson,
  eventPageBounds,
  SessionStoreError,
  type AuditEventPage,
  type AuditPageOptions,
  type CreateSessionOptions,
  type EventLog,
  type EventLogOptions,
  type EventPageOptions,
  type RecoverInterruptedResult,
  type SaveCheckpointOptions,
  type SequencedEvent,
  type SessionCheckpoint,
  type SessionEventPage,
  type SessionListing,
  type SessionMetadata,
  type SessionRecord,
  type SessionStatus,
  type SessionStore,
  type StatusTransitionResult,
} from "./store";

/**
 * SQLite remains the offline/local implementation of the durable M4 contract.
 * Postgres uses the same externally visible sequencing and idempotency rules.
 */
export const SESSIONS_SCHEMA_VERSION = 2;

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
  closed_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  next_seq INTEGER NOT NULL DEFAULT 0,
  checkpoint_revision INTEGER NOT NULL DEFAULT 0,
  checkpoint_seq INTEGER,
  checkpoint_payload TEXT,
  checkpoint_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL,
  global_seq INTEGER,
  event_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

interface SqliteSessionRow {
  session_id: string;
  task_id: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
  metadata: string;
  next_seq: number;
  checkpoint_revision: number;
  checkpoint_seq: number | null;
  checkpoint_payload: string | null;
  checkpoint_updated_at: string | null;
}

interface SqliteEventRow {
  session_id: string;
  seq: number;
  global_seq: number;
  event_id: string;
  at: string;
  actor: string | null;
  type: string;
  payload: string | number | Record<string, never>;
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function migrateSqlite(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  const versionRow = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const version = versionRow ? Number(versionRow.value) : 1;
  if (!Number.isSafeInteger(version) || version > SESSIONS_SCHEMA_VERSION) {
    throw new SessionStoreError(
      "SESS_SCHEMA_VERSION",
      `unsupported sessions schema version: ${versionRow?.value ?? "missing"}`,
    );
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    const sessionColumns = tableColumns(db, "sessions");
    if (!sessionColumns.has("metadata")) {
      db.exec("ALTER TABLE sessions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';");
    }
    if (!sessionColumns.has("next_seq")) {
      db.exec("ALTER TABLE sessions ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 0;");
    }
    if (!sessionColumns.has("checkpoint_revision")) {
      db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_revision INTEGER NOT NULL DEFAULT 0;");
    }
    if (!sessionColumns.has("checkpoint_seq")) {
      db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_seq INTEGER;");
    }
    if (!sessionColumns.has("checkpoint_payload")) {
      db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_payload TEXT;");
    }
    if (!sessionColumns.has("checkpoint_updated_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_updated_at TEXT;");
    }

    const eventColumns = tableColumns(db, "events");
    if (!eventColumns.has("global_seq")) {
      db.exec("ALTER TABLE events ADD COLUMN global_seq INTEGER;");
    }
    db.exec("UPDATE events SET global_seq = rowid WHERE global_seq IS NULL;");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_uq ON events (event_id);");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_global_seq_uq ON events (global_seq);");
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_global_seq_required
      BEFORE INSERT ON events
      WHEN NEW.global_seq IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'events.global_seq is required');
      END;
    `);
    db.exec(`
      UPDATE sessions
      SET next_seq = COALESCE(
        (SELECT MAX(events.seq) + 1 FROM events WHERE events.session_id = sessions.session_id),
        0
      )
      WHERE next_seq < COALESCE(
        (SELECT MAX(events.seq) + 1 FROM events WHERE events.session_id = sessions.session_id),
        0
      );
    `);
    const maximum = db.prepare("SELECT COALESCE(MAX(global_seq), -1) AS maximum FROM events")
      .get() as { maximum: number };
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_global_seq', ?)")
      .run(String(maximum.maximum + 1));
    const counter = db.prepare("SELECT value FROM meta WHERE key = 'next_global_seq'")
      .get() as { value: string };
    if (Number(counter.value) <= maximum.maximum) {
      db.prepare("UPDATE meta SET value = ? WHERE key = 'next_global_seq'")
        .run(String(maximum.maximum + 1));
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(SESSIONS_SCHEMA_VERSION));
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the operation failure.
    }
    throw error;
  }
}

function asSafeInteger(value: unknown, label: string, minimum = 0): number {
  const number = typeof value === "string" && /^-?\d+$/u.test(value)
    ? Number(value)
    : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum) {
    throw new SessionStoreError("SESS_INVALID_RECORD", `${label} is not a safe integer`);
  }
  return number;
}

function recordFromRow(row: SqliteSessionRow | undefined, sessionId?: string): SessionRecord {
  if (!row) {
    throw new SessionStoreError(
      "SESS_NOT_FOUND",
      sessionId ? `session "${sessionId}" not found` : "session record not found",
    );
  }
  if (!(["active", "closed", "archived"] as const).includes(row.status as SessionStatus)) {
    throw new SessionStoreError("SESS_INVALID_RECORD", `invalid stored session status: ${row.status}`);
  }
  return {
    sessionId: row.session_id,
    taskId: row.task_id ?? undefined,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    closedAt: row.closed_at ?? undefined,
    metadata: decodeMetadata(row.metadata),
  };
}

function checkpointFromRow(
  row: SqliteSessionRow,
  sessionId: string,
): SessionCheckpoint | undefined {
  if (
    row.checkpoint_revision === 0 &&
    row.checkpoint_seq === null &&
    row.checkpoint_payload === null &&
    row.checkpoint_updated_at === null
  ) return undefined;
  if (
    row.checkpoint_revision <= 0 ||
    row.checkpoint_seq === null ||
    row.checkpoint_payload === null ||
    row.checkpoint_updated_at === null
  ) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "stored checkpoint is incomplete");
  }
  return {
    sessionId,
    revision: asSafeInteger(row.checkpoint_revision, "checkpoint revision", 1),
    afterSeq: asSafeInteger(row.checkpoint_seq, "checkpoint seq", -1),
    payload: decodeSessionJson(row.checkpoint_payload, "session checkpoint"),
    updatedAt: row.checkpoint_updated_at,
  };
}

function selectSessionRow(db: DatabaseSync, sessionId: string): SqliteSessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as SqliteSessionRow | undefined;
}

function createOrOpenSession(
  db: DatabaseSync,
  options: CreateSessionOptions = {},
): SessionRecord {
  const sessionId = options.sessionId ?? `sess-${randomUUID()}`;
  assertSessionId(sessionId);
  const metadata = encodeMetadata(options.metadata ?? {});
  let existing = selectSessionRow(db, sessionId);
  if (existing) {
    if (options.taskId && !existing.task_id) {
      db.prepare("UPDATE sessions SET task_id = ? WHERE session_id = ?")
        .run(options.taskId, sessionId);
      existing = selectSessionRow(db, sessionId);
    }
    return recordFromRow(existing, sessionId);
  }
  db.prepare(
    `INSERT INTO sessions
      (session_id, task_id, status, created_at, metadata, next_seq, checkpoint_revision)
     VALUES (?, ?, 'active', ?, ?, 0, 0)`,
  ).run(
    sessionId,
    options.taskId ?? null,
    options.createdAt ?? new Date().toISOString(),
    metadata,
  );
  return recordFromRow(selectSessionRow(db, sessionId), sessionId);
}

function canonicalEvent(event: AnyHarnessEvent): { event: AnyHarnessEvent; wire: string } {
  const decoded = deserializeEvent(serializeEvent(event));
  return { event: decoded, wire: serializeEvent(decoded) };
}

function eventFromRow(row: SqliteEventRow): SequencedEvent {
  const event = deserializeEvent(String(row.payload));
  if (
    event.eventId !== row.event_id ||
    event.type !== row.type ||
    event.at !== row.at ||
    (event.actor ?? null) !== row.actor
  ) {
    throw new SessionStoreError(
      "SESS_INVALID_RECORD",
      `event projection does not match payload for ${row.session_id}/${row.seq}`,
    );
  }
  return {
    sessionId: row.session_id,
    seq: asSafeInteger(row.seq, "event seq"),
    globalSeq: asSafeInteger(row.global_seq, "event global_seq"),
    event,
  };
}

interface AppendResult {
  stored: SequencedEvent;
  inserted: boolean;
}

function findEventById(
  db: DatabaseSync,
  eventId: string,
): SqliteEventRow | undefined {
  return db.prepare("SELECT * FROM events WHERE event_id = ?")
    .get(eventId) as SqliteEventRow | undefined;
}

function resolveExistingEvent(
  row: SqliteEventRow,
  sessionId: string,
  wire: string,
): AppendResult {
  if (row.session_id !== sessionId || String(row.payload) !== wire) {
    throw new SessionStoreError(
      "SESS_EVENT_CONFLICT",
      `eventId "${row.event_id}" is already used by a different event`,
    );
  }
  return { stored: eventFromRow(row), inserted: false };
}

/** Caller must hold an IMMEDIATE transaction. */
function appendEventInTransaction(
  db: DatabaseSync,
  sessionId: string,
  rawEvent: AnyHarnessEvent,
  options: EventLogOptions | undefined,
  now: () => string,
): AppendResult {
  assertSessionId(sessionId);
  const { event, wire } = canonicalEvent(rawEvent);
  const duplicate = findEventById(db, event.eventId);
  if (!options && duplicate) return resolveExistingEvent(duplicate, sessionId, wire);

  const session = selectSessionRow(db, sessionId);
  if (!session) {
    throw new SessionStoreError("SESS_NOT_FOUND", `session "${sessionId}" not found`);
  }
  if (options) {
    assertAppendOwnership(decodeMetadata(session.metadata), options.ownerId, now());
  }
  if (duplicate) return resolveExistingEvent(duplicate, sessionId, wire);
  if (session.status !== "active") {
    throw new SessionStoreError(
      "SESS_CLOSED",
      `session "${sessionId}" is ${session.status}; new events cannot be appended`,
    );
  }
  const seq = asSafeInteger(session.next_seq, "session next_seq");
  const counter = db.prepare("SELECT value FROM meta WHERE key = 'next_global_seq'")
    .get() as { value: string } | undefined;
  if (!counter) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "global event counter is missing");
  }
  const globalSeq = asSafeInteger(counter.value, "global event counter");
  db.prepare(
    `INSERT INTO events
      (session_id, seq, global_seq, event_id, at, actor, type, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    seq,
    globalSeq,
    event.eventId,
    event.at,
    event.actor ?? null,
    event.type,
    wire,
  );
  db.prepare("UPDATE sessions SET next_seq = next_seq + 1 WHERE session_id = ?")
    .run(sessionId);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'next_global_seq'")
    .run(String(globalSeq + 1));
  return {
    stored: { sessionId, seq, globalSeq, event },
    inserted: true,
  };
}

function appendSqliteEvent(
  db: DatabaseSync,
  sessionId: string,
  event: AnyHarnessEvent,
  options: EventLogOptions | undefined,
  now: () => string,
): SequencedEvent {
  return transaction(db, () =>
    appendEventInTransaction(db, sessionId, event, options, now)).stored;
}

function pageFromRows(
  rows: SqliteEventRow[],
  limit: number,
  cursor: number,
  cursorKind: "session" | "audit",
): SessionEventPage | AuditEventPage {
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(eventFromRow);
  if (cursorKind === "session") {
    return {
      events,
      nextAfterSeq: events.at(-1)?.seq ?? cursor,
      hasMore,
    };
  }
  return {
    events,
    nextAfterGlobalSeq: events.at(-1)?.globalSeq ?? cursor,
    hasMore,
  };
}

function readSessionEventPage(
  db: DatabaseSync,
  sessionId: string,
  options: EventPageOptions = {},
): SessionEventPage {
  assertSessionId(sessionId);
  if (!selectSessionRow(db, sessionId)) {
    throw new SessionStoreError("SESS_NOT_FOUND", `session "${sessionId}" not found`);
  }
  const { cursor, limit } = eventPageBounds(options.afterSeq, options.limit, "afterSeq");
  const rows = db.prepare(
    "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
  ).all(sessionId, cursor, limit + 1) as unknown as SqliteEventRow[];
  return pageFromRows(rows, limit, cursor, "session") as SessionEventPage;
}

function readAuditEventPage(
  db: DatabaseSync,
  options: AuditPageOptions = {},
): AuditEventPage {
  const { cursor, limit } = eventPageBounds(
    options.afterGlobalSeq,
    options.limit,
    "afterGlobalSeq",
  );
  const rows = db.prepare(
    "SELECT * FROM events WHERE global_seq > ? ORDER BY global_seq LIMIT ?",
  ).all(cursor, limit + 1) as unknown as SqliteEventRow[];
  return pageFromRows(rows, limit, cursor, "audit") as AuditEventPage;
}

function listSessionRows(db: DatabaseSync): SessionListing[] {
  const rows = db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM events e WHERE e.session_id = s.session_id) AS event_count
     FROM sessions s
     ORDER BY s.created_at DESC, s.session_id DESC`,
  ).all() as unknown as Array<SqliteSessionRow & { event_count: number }>;
  return rows.map((row) => ({
    ...recordFromRow(row),
    eventCount: asSafeInteger(row.event_count, "session event_count"),
  }));
}

function transitionSessionInTransaction(
  db: DatabaseSync,
  sessionId: string,
  expected: SessionStatus,
  next: SessionStatus,
  at: string,
): StatusTransitionResult {
  const row = selectSessionRow(db, sessionId);
  const current = recordFromRow(row, sessionId);
  if (current.status !== expected) return { changed: false, record: current };
  assertStatusTransition(current.status, next);
  if (current.status === next) return { changed: false, record: current };
  db.prepare(
    `UPDATE sessions
     SET status = ?,
         closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END
     WHERE session_id = ? AND status = ?`,
  ).run(next, next, at, sessionId, expected);
  return {
    changed: true,
    record: recordFromRow(selectSessionRow(db, sessionId), sessionId),
  };
}

export class SqliteEventLog implements EventLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionId: string,
    private readonly options?: EventLogOptions,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async append(event: AnyHarnessEvent): Promise<number> {
    return (await this.appendSequenced(event)).seq;
  }

  async appendSequenced(event: AnyHarnessEvent): Promise<SequencedEvent> {
    return appendSqliteEvent(this.db, this.sessionId, event, this.options, this.now);
  }

  async read(options: EventPageOptions = {}): Promise<SessionEventPage> {
    return readSessionEventPage(this.db, this.sessionId, options);
  }

  async slice(from: number, to?: number): Promise<AnyHarnessEvent[]> {
    const lo = Math.max(0, from);
    const rows = to === undefined
      ? this.db.prepare(
        "SELECT * FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq",
      ).all(this.sessionId, lo) as unknown as SqliteEventRow[]
      : this.db.prepare(
        "SELECT * FROM events WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
      ).all(this.sessionId, lo, Math.max(lo, to)) as unknown as SqliteEventRow[];
    return rows.map((row) => eventFromRow(row).event);
  }

  async size(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get(this.sessionId) as { n: number };
    return asSafeInteger(row.n, "event count");
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
  metadata?: SessionMetadata;
}

export interface SqliteSessionStoreOptions {
  /** Injectable database-service clock used for owner lease fencing. */
  now?: () => string;
}

export class SqliteSessionStore implements SessionStore {
  private closed = false;
  private readonly now: () => string;

  constructor(
    readonly db: DatabaseSync,
    options: SqliteSessionStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionStoreError("SESS_INVALID_RECORD", "session store is closed");
    }
  }

  async currentTime(): Promise<string> {
    this.assertOpen();
    return this.now();
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionRecord> {
    this.assertOpen();
    return createOrOpenSession(this.db, {
      ...options,
      createdAt: options.createdAt ?? this.now(),
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    this.assertOpen();
    assertSessionId(sessionId);
    return recordFromRow(selectSessionRow(this.db, sessionId), sessionId);
  }

  async listSessions(): Promise<SessionListing[]> {
    this.assertOpen();
    return listSessionRows(this.db);
  }

  eventLog(sessionId: string, options?: EventLogOptions): SqliteEventLog {
    this.assertOpen();
    assertSessionId(sessionId);
    if (options) assertOwnerId(options.ownerId);
    return new SqliteEventLog(
      this.db,
      sessionId,
      options ? { ownerId: options.ownerId } : undefined,
      this.now,
    );
  }

  async appendEvent(
    sessionId: string,
    event: AnyHarnessEvent,
    options?: EventLogOptions,
  ): Promise<SequencedEvent> {
    this.assertOpen();
    if (options) assertOwnerId(options.ownerId);
    return appendSqliteEvent(this.db, sessionId, event, options, this.now);
  }

  async readSessionEvents(
    sessionId: string,
    options: EventPageOptions = {},
  ): Promise<SessionEventPage> {
    this.assertOpen();
    return readSessionEventPage(this.db, sessionId, options);
  }

  async readAuditEvents(options: AuditPageOptions = {}): Promise<AuditEventPage> {
    this.assertOpen();
    return readAuditEventPage(this.db, options);
  }

  async transitionSession(
    sessionId: string,
    expected: SessionStatus,
    next: SessionStatus,
    at = this.now(),
    options?: EventLogOptions,
  ): Promise<StatusTransitionResult> {
    this.assertOpen();
    assertSessionId(sessionId);
    if (options) assertOwnerId(options.ownerId);
    return transaction(this.db, () => {
      const current = recordFromRow(selectSessionRow(this.db, sessionId), sessionId);
      if (current.status === expected && current.status !== next && options) {
        assertAppendOwnership(current.metadata, options.ownerId, this.now());
      }
      return transitionSessionInTransaction(this.db, sessionId, expected, next, at);
    });
  }

  async setMetadata(
    sessionId: string,
    metadata: SessionMetadata,
    options?: EventLogOptions,
  ): Promise<SessionRecord> {
    this.assertOpen();
    assertSessionId(sessionId);
    if (options) assertOwnerId(options.ownerId);
    const wire = encodeMetadata(metadata);
    return transaction(this.db, () => {
      const current = selectSessionRow(this.db, sessionId);
      if (!current) {
        throw new SessionStoreError("SESS_NOT_FOUND", `session "${sessionId}" not found`);
      }
      if (current.status !== "active") {
        throw new SessionStoreError("SESS_CLOSED", `session "${sessionId}" is ${current.status}`);
      }
      if (options) {
        assertAppendOwnership(decodeMetadata(current.metadata), options.ownerId, this.now());
      }
      this.db.prepare("UPDATE sessions SET metadata = ? WHERE session_id = ? AND status = 'active'")
        .run(wire, sessionId);
      return recordFromRow(selectSessionRow(this.db, sessionId), sessionId);
    });
  }

  async getCheckpoint(sessionId: string): Promise<SessionCheckpoint | undefined> {
    this.assertOpen();
    assertSessionId(sessionId);
    const row = selectSessionRow(this.db, sessionId);
    if (!row) throw new SessionStoreError("SESS_NOT_FOUND", `session "${sessionId}" not found`);
    return checkpointFromRow(row, sessionId);
  }

  async saveCheckpoint(
    sessionId: string,
    options: SaveCheckpointOptions,
  ): Promise<SessionCheckpoint> {
    this.assertOpen();
    assertSessionId(sessionId);
    const expected = asSafeInteger(options.expectedRevision, "expected checkpoint revision");
    const afterSeq = asSafeInteger(options.afterSeq, "checkpoint seq", -1);
    const payload = encodeSessionJson(options.payload, "session checkpoint");
    const updatedAt = options.updatedAt ?? this.now();
    return transaction(this.db, () => {
      const row = selectSessionRow(this.db, sessionId);
      if (!row) throw new SessionStoreError("SESS_NOT_FOUND", `session "${sessionId}" not found`);
      if (row.status !== "active") {
        throw new SessionStoreError("SESS_CLOSED", `session "${sessionId}" is ${row.status}`);
      }
      const currentCheckpoint = checkpointFromRow(row, sessionId);
      if (
        row.checkpoint_revision === expected + 1 &&
        currentCheckpoint?.afterSeq === afterSeq &&
        row.checkpoint_payload === payload
      ) {
        return currentCheckpoint;
      }
      if (row.checkpoint_revision !== expected) {
        throw new SessionStoreError(
          "SESS_CHECKPOINT_CONFLICT",
          `checkpoint revision ${row.checkpoint_revision} does not match expected ${expected}`,
        );
      }
      if (currentCheckpoint && afterSeq < currentCheckpoint.afterSeq) {
        throw new SessionStoreError(
          "SESS_CHECKPOINT_CONFLICT",
          `checkpoint seq ${afterSeq} is behind current seq ${currentCheckpoint.afterSeq}`,
        );
      }
      if (afterSeq >= row.next_seq) {
        throw new SessionStoreError(
          "SESS_INVALID_RECORD",
          `checkpoint seq ${afterSeq} is not yet durable`,
        );
      }
      const revision = expected + 1;
      this.db.prepare(
        `UPDATE sessions
         SET checkpoint_revision = ?, checkpoint_seq = ?, checkpoint_payload = ?, checkpoint_updated_at = ?
         WHERE session_id = ? AND checkpoint_revision = ?`,
      ).run(revision, afterSeq, payload, updatedAt, sessionId, expected);
      return {
        sessionId,
        revision,
        afterSeq,
        payload: decodeSessionJson(payload, "session checkpoint"),
        updatedAt,
      };
    });
  }

  async recoverInterrupted(
    sessionId: string,
    event: AnyHarnessEvent,
    closedAt = this.now(),
    expectedMetadata?: SessionMetadata,
  ): Promise<RecoverInterruptedResult> {
    this.assertOpen();
    assertSessionId(sessionId);
    const canonical = canonicalEvent(event);
    return transaction(this.db, () => {
      const row = selectSessionRow(this.db, sessionId);
      const current = recordFromRow(row, sessionId);
      if (
        expectedMetadata !== undefined &&
        encodeMetadata(current.metadata) !== encodeMetadata(expectedMetadata)
      ) {
        throw new SessionStoreError(
          "SESS_RECOVERY_CONFLICT",
          `session "${sessionId}" owner metadata changed before recovery`,
        );
      }
      if (expectedMetadata !== undefined) {
        assertRecoveryLeaseExpired(current.metadata, this.now());
      }
      const duplicate = findEventById(this.db, canonical.event.eventId);
      const existing = duplicate
        ? resolveExistingEvent(duplicate, sessionId, canonical.wire).stored
        : undefined;
      if (current.status !== "active") {
        return { recovered: false, record: current, event: existing };
      }
      const stored = existing ?? appendEventInTransaction(
        this.db,
        sessionId,
        canonical.event,
        undefined,
        this.now,
      ).stored;
      const transition = transitionSessionInTransaction(
        this.db,
        sessionId,
        "active",
        "closed",
        closedAt,
      );
      return { recovered: transition.changed, record: transition.record, event: stored };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Open a durable SQLite store without implicitly creating a session. */
export function openSqliteStore(
  dbPath: string,
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    migrateSqlite(db);
    return new SqliteSessionStore(db, options);
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Legacy M1 API: open (or create) one session and return its scoped event log.
 */
export function openSqliteSession(
  dbPath: string,
  options: OpenSessionOptions = {},
): OpenedSession {
  const store = openSqliteStore(dbPath);
  try {
    const record = createOrOpenSession(store.db, options);
    return {
      sessionId: record.sessionId,
      record,
      log: store.eventLog(record.sessionId),
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

function withExistingDatabase<T>(dbPath: string, operation: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) {
    throw new SessionStoreError(
      "SESS_NOT_FOUND",
      `no session store at ${dbPath} (nothing to read)`,
    );
  }
  const db = new DatabaseSync(dbPath);
  try {
    migrateSqlite(db);
    return operation(db);
  } finally {
    db.close();
  }
}

/** Read back a session record without retaining a database handle. */
export function getSessionRecord(dbPath: string, sessionId: string): SessionRecord {
  assertSessionId(sessionId);
  return withExistingDatabase(dbPath, (db) =>
    recordFromRow(selectSessionRow(db, sessionId), sessionId));
}

/** List all sessions in the store, most recently created first. */
export function listSessions(dbPath: string): SessionListing[] {
  if (!existsSync(dbPath)) return [];
  return withExistingDatabase(dbPath, listSessionRows);
}

/**
 * Legacy status helper. It now enforces the same one-way lifecycle as the
 * common store and records `closedAt` when closing.
 */
export function setSessionStatus(
  dbPath: string,
  sessionId: string,
  status: SessionStatus,
  at = new Date().toISOString(),
): void {
  assertSessionId(sessionId);
  withExistingDatabase(dbPath, (db) => {
    transaction(db, () => {
      const row = selectSessionRow(db, sessionId);
      const current = recordFromRow(row, sessionId);
      assertStatusTransition(current.status, status);
      if (current.status !== status) {
        transitionSessionInTransaction(db, sessionId, current.status, status, at);
      }
    });
  });
}

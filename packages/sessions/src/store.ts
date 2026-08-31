import type { AnyHarnessEvent } from "@harness/events";

/** Lifecycle of the durable session row, independent of an agent result. */
export type SessionStatus = "active" | "closed" | "archived";

export type SessionMetadata = Readonly<Record<string, unknown>>;

export interface SessionRecord {
  sessionId: string;
  taskId?: string;
  status: SessionStatus;
  createdAt: string;
  closedAt?: string;
  /** Service-owned routing/recovery metadata. Never exported as audit data. */
  metadata: SessionMetadata;
}

export interface SessionListing extends SessionRecord {
  eventCount: number;
}

/** An event together with the ordering assigned by durable storage. */
export interface SequencedEvent {
  sessionId: string;
  /** Per-session sequence. ACP cursors use this value. */
  seq: number;
  /**
   * Store-wide committed append order. Audit exporters use this value as an
   * opaque cursor; migrated histories can contain gaps.
   */
  globalSeq: number;
  event: AnyHarnessEvent;
}

export interface SessionEventPage {
  events: SequencedEvent[];
  /** Cursor to pass as `afterSeq` on the next request. */
  nextAfterSeq: number;
  hasMore: boolean;
}

export interface AuditEventPage {
  events: SequencedEvent[];
  /** Cursor to pass as `afterGlobalSeq` on the next request. */
  nextAfterGlobalSeq: number;
  hasMore: boolean;
}

export interface EventPageOptions {
  /** Last sequence already observed. Reads return events with seq > cursor. */
  afterSeq?: number;
  limit?: number;
}

export interface AuditPageOptions {
  /** Last global sequence already exported. */
  afterGlobalSeq?: number;
  limit?: number;
}

export interface SessionCheckpoint {
  sessionId: string;
  /** Compare-and-swap revision, starting at one for the first checkpoint. */
  revision: number;
  /** Last durable session event incorporated into the checkpoint. */
  afterSeq: number;
  payload: unknown;
  updatedAt: string;
}

export interface SaveCheckpointOptions {
  /** Current revision observed by the caller; zero means no checkpoint yet. */
  expectedRevision: number;
  /** Must not move behind the previous revision's durable event cursor. */
  afterSeq: number;
  payload: unknown;
  updatedAt?: string;
}

export interface StatusTransitionResult {
  changed: boolean;
  record: SessionRecord;
}

export interface RecoverInterruptedResult {
  /** True only for the caller that atomically changed active -> closed. */
  recovered: boolean;
  record: SessionRecord;
  /** The restore event, whether inserted now or found on an idempotent retry. */
  event?: SequencedEvent;
}

export interface CreateSessionOptions {
  sessionId?: string;
  taskId?: string;
  createdAt?: string;
  metadata?: SessionMetadata;
}

/**
 * Bind appends to the current owner recorded in session metadata. Omit this
 * object for generic/control-plane sessions that do not use owner leases.
 */
export interface EventLogOptions {
  readonly ownerId: string;
}

export interface EventLog {
  /** Append an event; returns its durable per-session sequence number. */
  append(event: AnyHarnessEvent): Promise<number>;
  /** Append and retain both the session and global durable ordering. */
  appendSequenced(event: AnyHarnessEvent): Promise<SequencedEvent>;
  /** Cursor-based read; `afterSeq` is the last sequence already observed. */
  read(options?: EventPageOptions): Promise<SessionEventPage>;
  /** Legacy range read [from, to), preserved for the TUI and M1 callers. */
  slice(from: number, to?: number): Promise<AnyHarnessEvent[]>;
  size(): Promise<number>;
}

export interface SessionHandle {
  record: SessionRecord;
  log: EventLog;
}

/**
 * Durable session contract shared by SQLite and Postgres.
 *
 * Implementations must serialize appends per session, derive sequence numbers
 * in storage, and treat an identical eventId retry as success. A reused
 * eventId with different bytes or a different session is a typed conflict.
 */
export interface SessionStore {
  /** Authoritative storage clock used for cross-replica lease decisions. */
  currentTime(): Promise<string>;
  createSession(options?: CreateSessionOptions): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord>;
  listSessions(): Promise<SessionListing[]>;
  eventLog(sessionId: string, options?: EventLogOptions): EventLog;
  appendEvent(
    sessionId: string,
    event: AnyHarnessEvent,
    options?: EventLogOptions,
  ): Promise<SequencedEvent>;
  readSessionEvents(sessionId: string, options?: EventPageOptions): Promise<SessionEventPage>;
  readAuditEvents(options?: AuditPageOptions): Promise<AuditEventPage>;
  transitionSession(
    sessionId: string,
    expected: SessionStatus,
    next: SessionStatus,
    at?: string,
    options?: EventLogOptions,
  ): Promise<StatusTransitionResult>;
  setMetadata(
    sessionId: string,
    metadata: SessionMetadata,
    options?: EventLogOptions,
  ): Promise<SessionRecord>;
  getCheckpoint(sessionId: string): Promise<SessionCheckpoint | undefined>;
  /**
   * Advance a checkpoint with revision CAS and a nondecreasing event cursor.
   * Retrying the immediately preceding identical cursor/payload is idempotent.
   */
  saveCheckpoint(sessionId: string, options: SaveCheckpointOptions): Promise<SessionCheckpoint>;
  /**
   * Crash recovery primitive. It atomically appends the caller-supplied
   * `session.restored` event and closes an active session. It never re-opens or
   * re-executes the interrupted turn.
   */
  recoverInterrupted(
    sessionId: string,
    event: AnyHarnessEvent,
    closedAt?: string,
    /** Metadata snapshot whose lease/owner the caller validated. */
    expectedMetadata?: SessionMetadata,
  ): Promise<RecoverInterruptedResult>;
  close(): void | Promise<void>;
}

export class SessionStoreError extends Error {
  constructor(
    readonly code:
      | "SESS_NOT_FOUND"
      | "SESS_INVALID_RECORD"
      | "SESS_CLOSED"
      | "SESS_EVENT_CONFLICT"
      | "SESS_INVALID_CURSOR"
      | "SESS_INVALID_TRANSITION"
      | "SESS_CHECKPOINT_CONFLICT"
      | "SESS_RECOVERY_CONFLICT"
      | "SESS_OWNERSHIP_LOST"
      | "SESS_SCHEMA_VERSION",
    message: string,
  ) {
    super(message);
    this.name = "SessionStoreError";
  }
}

export const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_EVENT_PAGE_LIMIT = 1_000;

export function eventPageBounds(
  cursor: number | undefined,
  limit: number | undefined,
  cursorName: "afterSeq" | "afterGlobalSeq",
): { cursor: number; limit: number } {
  const normalizedCursor = cursor ?? -1;
  const normalizedLimit = limit ?? DEFAULT_EVENT_PAGE_LIMIT;
  if (!Number.isSafeInteger(normalizedCursor) || normalizedCursor < -1) {
    throw new SessionStoreError(
      "SESS_INVALID_CURSOR",
      `${cursorName} must be a safe integer >= -1`,
    );
  }
  if (
    !Number.isSafeInteger(normalizedLimit) ||
    normalizedLimit <= 0 ||
    normalizedLimit > MAX_EVENT_PAGE_LIMIT
  ) {
    throw new SessionStoreError(
      "SESS_INVALID_CURSOR",
      `limit must be a safe integer between 1 and ${MAX_EVENT_PAGE_LIMIT}`,
    );
  }
  return { cursor: normalizedCursor, limit: normalizedLimit };
}

export function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "sessionId must be 1-256 characters");
  }
}

export function assertOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 256) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "ownerId must be 1-256 characters");
  }
}

/** Evaluate an owner lease only after the implementation has locked its row. */
export function assertAppendOwnership(
  metadata: SessionMetadata,
  ownerId: string,
  now: string,
): void {
  assertOwnerId(ownerId);
  const storedOwner = metadata.ownerId;
  const leaseExpiresAt = metadata.leaseExpiresAt;
  const nowMilliseconds = Date.parse(now);
  const expiryMilliseconds = typeof leaseExpiresAt === "string"
    ? Date.parse(leaseExpiresAt)
    : Number.NaN;
  if (
    storedOwner !== ownerId ||
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(expiryMilliseconds) ||
    expiryMilliseconds <= nowMilliseconds
  ) {
    throw new SessionStoreError(
      "SESS_OWNERSHIP_LOST",
      `session owner "${ownerId}" does not hold a valid unexpired lease`,
    );
  }
}

/** Evaluate recovery eligibility only after the implementation has locked its row. */
export function assertRecoveryLeaseExpired(
  metadata: SessionMetadata,
  now: string,
): void {
  const ownerId = metadata.ownerId;
  const leaseExpiresAt = metadata.leaseExpiresAt;
  const nowMilliseconds = Date.parse(now);
  const expiryMilliseconds = typeof leaseExpiresAt === "string"
    ? Date.parse(leaseExpiresAt)
    : Number.NaN;
  if (
    typeof ownerId !== "string" || ownerId.length === 0 || ownerId.length > 256 ||
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(expiryMilliseconds) ||
    expiryMilliseconds > nowMilliseconds
  ) {
    throw new SessionStoreError(
      "SESS_RECOVERY_CONFLICT",
      "session owner lease is still live or invalid",
    );
  }
}

export function assertStatusTransition(
  current: SessionStatus,
  next: SessionStatus,
): void {
  const valid = current === next ||
    (current === "active" && next === "closed") ||
    (current === "closed" && next === "archived");
  if (!valid) {
    throw new SessionStoreError(
      "SESS_INVALID_TRANSITION",
      `invalid session status transition: ${current} -> ${next}`,
    );
  }
}

const MAX_SESSION_JSON_BYTES = 16 * 1024 * 1024;

/** Copy a value through JSON and enforce a process-boundary size limit. */
export function encodeSessionJson(value: unknown, label: string): string {
  let wire: string | undefined;
  try {
    wire = JSON.stringify(value);
  } catch {
    // Typed error below.
  }
  if (wire === undefined || Buffer.byteLength(wire, "utf8") > MAX_SESSION_JSON_BYTES) {
    throw new SessionStoreError(
      "SESS_INVALID_RECORD",
      `${label} must be a bounded JSON value`,
    );
  }
  return wire;
}

export function decodeSessionJson(wire: unknown, label: string): unknown {
  if (typeof wire !== "string") {
    throw new SessionStoreError("SESS_INVALID_RECORD", `${label} is not stored JSON text`);
  }
  try {
    return JSON.parse(wire);
  } catch {
    throw new SessionStoreError("SESS_INVALID_RECORD", `${label} contains invalid JSON`);
  }
}

export function encodeMetadata(metadata: SessionMetadata): string {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "session metadata must be a JSON object");
  }
  const wire = encodeSessionJson(metadata, "session metadata");
  const decoded = decodeSessionJson(wire, "session metadata");
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "session metadata must be a JSON object");
  }
  return wire;
}

export function decodeMetadata(wire: unknown): SessionMetadata {
  const value = decodeSessionJson(wire, "session metadata");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionStoreError("SESS_INVALID_RECORD", "session metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

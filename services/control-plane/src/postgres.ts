import { readFile } from "node:fs/promises";
import { deserializeEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import { ControlPlaneError, controlPlaneError } from "./errors";
import {
  artifactRegisteredEvent,
  auditExportedEvent,
  runLeasedEvent,
  runScheduledEvent,
  runUpdatedEvent,
  taskAdmittedEvent,
} from "./outbox-events";
import { isTerminalRunState } from "./state";
import type {
  AdmissionResult,
  AdmitTaskInput,
  ArtifactRecord,
  AuditExportCommitInput,
  AuditCheckpoint,
  CancelRunInput,
  ClaimOutboxInput,
  ClaimRunInput,
  CompleteRunInput,
  ControlPlaneRepository,
  EnqueueRunInput,
  HeartbeatRunInput,
  LeaseExpiryResult,
  LeaseMutationInput,
  ListOptions,
  OutboxEventRecord,
  OutboxMutationInput,
  ReleaseOutboxInput,
  ReconcileRunInput,
  RunRecord,
  RunState,
  TaskRecord,
} from "./types";
import { canonicalJson } from "./util";

export type PostgresParameter = string | number | boolean | null | Uint8Array | Date;

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PostgresQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresClient extends PostgresQueryable {
  release(error?: unknown): void;
}

/** Structurally compatible with `pg.Pool` without taking a package dependency. */
export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresClient>;
}

type Row = Record<string, unknown>;

function text(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  throw new ControlPlaneError("CP_STORAGE_FAILED", `database returned invalid ${field}`);
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === null || value === undefined ? undefined : text(value, field);
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ControlPlaneError("CP_STORAGE_FAILED", `database returned invalid ${field}`);
  }
  return parsed;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw new ControlPlaneError("CP_STORAGE_FAILED", `database returned invalid ${field}`);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ControlPlaneError("CP_STORAGE_FAILED", `database returned invalid ${field}`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ControlPlaneError("CP_STORAGE_FAILED", `database returned invalid ${field}`);
  }
  return parsed as Record<string, unknown>;
}

function taskRow(row: Row): TaskRecord {
  return {
    taskId: text(row.task_id, "task_id"),
    manifest: jsonObject(row.manifest, "manifest") as unknown as TaskRecord["manifest"],
    manifestDigest: text(row.manifest_digest, "manifest_digest"),
    admissionKey: text(row.admission_key, "admission_key"),
    admittedAt: text(row.admitted_at, "admitted_at"),
    version: integer(row.version, "version"),
  };
}

function runRow(row: Row): RunRecord {
  return {
    runId: text(row.run_id, "run_id"),
    taskId: text(row.task_id, "task_id"),
    manifestDigest: text(row.manifest_digest, "manifest_digest"),
    admissionKey: text(row.admission_key, "admission_key"),
    status: text(row.status, "status") as RunState,
    priority: integer(row.priority, "priority"),
    attempt: integer(row.attempt, "attempt"),
    ...(optionalText(row.worker_id, "worker_id") === undefined ? {} : { workerId: optionalText(row.worker_id, "worker_id") }),
    ...(optionalText(row.lease_id, "lease_id") === undefined ? {} : { leaseId: optionalText(row.lease_id, "lease_id") }),
    fencingToken: integer(row.fencing_token, "fencing_token"),
    ...(optionalText(row.lease_expires_at, "lease_expires_at") === undefined ? {} : { leaseExpiresAt: optionalText(row.lease_expires_at, "lease_expires_at") }),
    queuedAt: text(row.queued_at, "queued_at"),
    ...(optionalText(row.started_at, "started_at") === undefined ? {} : { startedAt: optionalText(row.started_at, "started_at") }),
    ...(optionalText(row.finished_at, "finished_at") === undefined ? {} : { finishedAt: optionalText(row.finished_at, "finished_at") }),
    ...(optionalText(row.completion_key, "completion_key") === undefined ? {} : { completionKey: optionalText(row.completion_key, "completion_key") }),
    ...(optionalText(row.report_path, "report_path") === undefined ? {} : { reportPath: optionalText(row.report_path, "report_path") }),
    version: integer(row.version, "version"),
  };
}

function artifactRow(row: Row): ArtifactRecord {
  return {
    artifactId: text(row.artifact_id, "artifact_id"),
    kind: text(row.kind, "kind") as ArtifactRecord["kind"],
    bucket: text(row.bucket, "bucket"),
    key: text(row.object_key, "object_key"),
    sha256: text(row.sha256, "sha256"),
    bytes: integer(row.bytes, "bytes"),
    contentType: text(row.content_type, "content_type"),
    ...(optionalText(row.task_id, "task_id") === undefined ? {} : { taskId: optionalText(row.task_id, "task_id") }),
    ...(optionalText(row.run_id, "run_id") === undefined ? {} : { runId: optionalText(row.run_id, "run_id") }),
    ...(optionalText(row.session_id, "session_id") === undefined ? {} : { sessionId: optionalText(row.session_id, "session_id") }),
    createdAt: text(row.created_at, "created_at"),
  };
}

function checkpointRow(row: Row): AuditCheckpoint {
  return {
    sessionId: text(row.session_id, "session_id"),
    nextSeq: integer(row.next_seq, "next_seq"),
    ...(optionalText(row.artifact_id, "artifact_id") === undefined ? {} : { artifactId: optionalText(row.artifact_id, "artifact_id") }),
    updatedAt: text(row.updated_at, "updated_at"),
  };
}

function outboxRow(row: Row): OutboxEventRecord {
  const payload = text(row.payload, "payload");
  return {
    sequence: integer(row.sequence, "sequence"),
    event: deserializeEvent(payload),
    attempts: integer(row.publish_attempts, "publish_attempts"),
    fencingToken: integer(row.fencing_token, "fencing_token"),
  };
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function artifactsEqual(left: ArtifactRecord, right: ArtifactRecord): boolean {
  const { createdAt: _leftCreatedAt, ...leftIdentity } = left;
  const { createdAt: _rightCreatedAt, ...rightIdentity } = right;
  return recordsEqual(leftIdentity, rightIdentity);
}

const TASK_COLUMNS = "task_id, manifest, manifest_digest, admission_key, admitted_at, version";
const RUN_COLUMNS = `run_id, task_id, manifest_digest, admission_key, status, priority,
  attempt, worker_id, lease_id, fencing_token, lease_expires_at, queued_at,
  started_at, finished_at, completion_key, report_path, version`;
const ARTIFACT_COLUMNS = `artifact_id, kind, bucket, object_key, sha256, bytes,
  content_type, task_id, run_id, session_id, created_at`;

const OUTBOX_COLUMNS = `sequence, event_id, payload, publish_attempts, fencing_token`;
const CONTROL_PLANE_SCHEMA_VERSION = 2;
const CONTROL_PLANE_MIGRATION_LOCK = 1_219_733_764;

export async function readControlPlaneMigration(): Promise<string> {
  return (await readControlPlaneMigrations()).join("\n");
}

export async function readControlPlaneMigrations(): Promise<readonly string[]> {
  return Promise.all([
    readFile(new URL("../migrations/001_control_plane.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/002_event_outbox.sql", import.meta.url), "utf8"),
  ]);
}

async function transaction<T>(pool: PostgresPool, operation: (client: PostgresClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseError: unknown;
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // Preserve the operation failure, but retire a connection that could not
      // be returned to a known transaction state.
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export interface PostgresRepositoryOptions {
  autoMigrate?: boolean;
}

/** Multi-writer control-plane repository with PostgreSQL-enforced fencing. */
export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  private migrated?: Promise<void>;

  constructor(
    private readonly pool: PostgresPool,
    private readonly options: PostgresRepositoryOptions = {},
  ) {}

  async migrate(): Promise<void> {
    if (!this.migrated) {
      const attempt = (async () => {
        try {
          const migrations = await readControlPlaneMigrations();
          await transaction(this.pool, async (client) => {
            await client.query("SELECT pg_advisory_xact_lock($1)", [CONTROL_PLANE_MIGRATION_LOCK]);
            await client.query(
              `CREATE TABLE IF NOT EXISTS control_plane_meta (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
               )`,
            );
            const versionResult = await client.query<Row>(
              "SELECT value FROM control_plane_meta WHERE key = 'schema_version' FOR UPDATE",
            );
            const rawVersion = versionResult.rows[0]?.value;
            const current = rawVersion === undefined ? 0 : Number(rawVersion);
            if (!Number.isSafeInteger(current) || current < 0) {
              throw new ControlPlaneError("CP_STORAGE_FAILED", "control-plane schema version is invalid");
            }
            if (current > CONTROL_PLANE_SCHEMA_VERSION) {
              throw new ControlPlaneError(
                "CP_NOT_READY",
                `control-plane schema version ${current} is newer than supported version ${CONTROL_PLANE_SCHEMA_VERSION}`,
              );
            }
            for (let version = current + 1; version <= CONTROL_PLANE_SCHEMA_VERSION; version++) {
              await client.query(migrations[version - 1]!);
              await client.query(
                `INSERT INTO control_plane_meta (key, value) VALUES ('schema_version', $1)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [String(version)],
              );
            }
          });
        } catch (error) {
          throw controlPlaneError(error, "control-plane database migration failed");
        }
      })();
      this.migrated = attempt;
      void attempt.catch(() => {
        if (this.migrated === attempt) this.migrated = undefined;
      });
    }
    return this.migrated;
  }

  private async prepared(): Promise<void> {
    if (this.options.autoMigrate !== false) await this.migrate();
  }

  async ready(): Promise<void> {
    await this.prepared();
    try {
      const result = await this.pool.query<{ value: unknown }>(
        "SELECT value FROM control_plane_meta WHERE key = 'schema_version'",
      );
      if (result.rows[0]?.value !== String(CONTROL_PLANE_SCHEMA_VERSION)) {
        throw new ControlPlaneError("CP_NOT_READY", "control-plane database schema is not ready");
      }
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError("CP_NOT_READY", "control-plane database is not ready", { cause: error });
    }
  }

  private async tx<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    await this.prepared();
    try {
      return await transaction(this.pool, operation);
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  private async enqueueOutboxWith(
    client: PostgresQueryable,
    event: AnyHarnessEvent,
  ): Promise<void> {
    const payload = serializeEvent(event);
    const already = await client.query<Row>(
      "SELECT payload FROM control_event_outbox WHERE event_id = $1",
      [event.eventId],
    );
    if (already.rows[0]) {
      if (text(already.rows[0].payload, "payload") !== payload) {
        throw new ControlPlaneError("CP_CONFLICT", `outbox event ${event.eventId} conflicts with existing payload`);
      }
      return;
    }
    // This singleton row is deliberately updated before insert. PostgreSQL
    // holds the row lock until commit, so sequence order is commit order rather
    // than the allocation order of a non-transactional identity/sequence.
    const allocated = await client.query<Row>(
      `UPDATE control_event_outbox_sequence
       SET next_sequence = next_sequence + 1
       WHERE singleton = TRUE
       RETURNING next_sequence - 1 AS sequence`,
    );
    const sequence = integer(allocated.rows[0]?.sequence, "outbox sequence");
    const inserted = await client.query<Row>(
      `INSERT INTO control_event_outbox (sequence, event_id, payload, available_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [sequence, event.eventId, payload],
    );
    if (inserted.rows[0]) return;
    const existing = await client.query<Row>(
      "SELECT payload FROM control_event_outbox WHERE event_id = $1",
      [event.eventId],
    );
    if (!existing.rows[0] || text(existing.rows[0].payload, "payload") !== payload) {
      throw new ControlPlaneError("CP_CONFLICT", `outbox event ${event.eventId} conflicts with existing payload`);
    }
  }

  async admitTask(input: AdmitTaskInput): Promise<AdmissionResult<TaskRecord>> {
    return this.tx(async (client) => {
      const inserted = await client.query<Row>(
        `INSERT INTO control_tasks
          (task_id, manifest, manifest_digest, admission_key, admitted_at)
         VALUES ($1, CAST($2 AS jsonb), $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING ${TASK_COLUMNS}`,
        [input.manifest.id, canonicalJson(input.manifest), input.manifestDigest, input.admissionKey, input.admittedAt],
      );
      if (inserted.rows[0]) {
        const record = taskRow(inserted.rows[0]);
        await this.enqueueOutboxWith(client, taskAdmittedEvent(record));
        return { record, created: true };
      }
      const found = await client.query<Row>(
        `SELECT ${TASK_COLUMNS} FROM control_tasks
         WHERE task_id = $1 OR admission_key = $2
         FOR UPDATE`,
        [input.manifest.id, input.admissionKey],
      );
      const byId = found.rows.map(taskRow).find((record) => record.taskId === input.manifest.id);
      const byKey = found.rows.map(taskRow).find((record) => record.admissionKey === input.admissionKey);
      if (byKey && byKey.taskId !== input.manifest.id) {
        throw new ControlPlaneError("CP_CONFLICT", "task idempotency key was already used");
      }
      if (
        !byId || byId.manifestDigest !== input.manifestDigest ||
        byId.admissionKey !== input.admissionKey
      ) {
        throw new ControlPlaneError(
          "CP_CONFLICT",
          `task ${input.manifest.id} already has another manifest or idempotency key`,
        );
      }
      await this.enqueueOutboxWith(client, taskAdmittedEvent(byId));
      return { record: byId, created: false };
    });
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.prepared();
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${TASK_COLUMNS} FROM control_tasks WHERE task_id = $1`,
        [taskId],
      );
      return result.rows[0] ? taskRow(result.rows[0]) : undefined;
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  async listTasks(options: ListOptions): Promise<TaskRecord[]> {
    await this.prepared();
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${TASK_COLUMNS} FROM control_tasks ORDER BY task_id LIMIT $1`,
        [options.limit],
      );
      return result.rows.map(taskRow);
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  async enqueueRun(input: EnqueueRunInput): Promise<AdmissionResult<RunRecord>> {
    return this.tx(async (client) => {
      const task = await client.query<Row>(
        "SELECT manifest_digest FROM control_tasks WHERE task_id = $1 FOR SHARE",
        [input.taskId],
      );
      if (!task.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `task ${input.taskId} was not admitted`);
      if (text(task.rows[0].manifest_digest, "manifest_digest") !== input.manifestDigest) {
        throw new ControlPlaneError("CP_CONFLICT", "scheduled manifest does not match admitted task");
      }
      const inserted = await client.query<Row>(
        `INSERT INTO control_runs
          (run_id, task_id, manifest_digest, admission_key, status, priority, attempt,
           fencing_token, queued_at)
         VALUES ($1, $2, $3, $4, 'queued', $5, 1, 0, CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING
         RETURNING ${RUN_COLUMNS}`,
        [input.runId, input.taskId, input.manifestDigest, input.admissionKey, input.priority],
      );
      if (inserted.rows[0]) {
        const record = runRow(inserted.rows[0]);
        await this.enqueueOutboxWith(client, runScheduledEvent(record));
        return { record, created: true };
      }
      const found = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM control_runs
         WHERE run_id = $1 OR admission_key = $2 FOR UPDATE`,
        [input.runId, input.admissionKey],
      );
      const records = found.rows.map(runRow);
      const byKey = records.find((record) => record.admissionKey === input.admissionKey);
      if (byKey && byKey.taskId === input.taskId && byKey.manifestDigest === input.manifestDigest && byKey.priority === input.priority) {
        await this.enqueueOutboxWith(client, runScheduledEvent(byKey));
        return { record: byKey, created: false };
      }
      if (byKey) throw new ControlPlaneError("CP_CONFLICT", "run idempotency key was already used");
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} already exists`);
    });
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    await this.prepared();
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM control_runs WHERE run_id = $1`,
        [runId],
      );
      return result.rows[0] ? runRow(result.rows[0]) : undefined;
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  async listRuns(options: ListOptions & { taskId?: string }): Promise<RunRecord[]> {
    await this.prepared();
    try {
      const result = options.taskId === undefined
        ? await this.pool.query<Row>(
            `SELECT ${RUN_COLUMNS} FROM control_runs
             ORDER BY priority DESC, queued_at ASC, run_id ASC LIMIT $1`,
            [options.limit],
          )
        : await this.pool.query<Row>(
            `SELECT ${RUN_COLUMNS} FROM control_runs WHERE task_id = $1
             ORDER BY priority DESC, queued_at ASC, run_id ASC LIMIT $2`,
            [options.taskId, options.limit],
          );
      return result.rows.map(runRow);
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  private async reapWith(client: PostgresQueryable, now: string): Promise<LeaseExpiryResult> {
    const requeued = await client.query<Row>(
      `UPDATE control_runs
       SET status = 'queued', attempt = attempt + 1, queued_at = CURRENT_TIMESTAMP,
           worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
           version = version + 1
       WHERE status = 'leased' AND lease_expires_at <= CURRENT_TIMESTAMP
       RETURNING ${RUN_COLUMNS}, CURRENT_TIMESTAMP AS transition_at`,
    );
    const indeterminate = await client.query<Row>(
      `UPDATE control_runs
       SET status = 'indeterminate', worker_id = NULL, lease_id = NULL,
           lease_expires_at = NULL, version = version + 1
       WHERE status = 'running' AND lease_expires_at <= CURRENT_TIMESTAMP
       RETURNING ${RUN_COLUMNS}, CURRENT_TIMESTAMP AS transition_at`,
    );
    const requeuedRows = requeued.rows
      .map((row) => ({ run: runRow(row), at: text(row.transition_at, "transition_at") }))
      .sort((left, right) => left.run.runId.localeCompare(right.run.runId));
    const indeterminateRows = indeterminate.rows
      .map((row) => ({ run: runRow(row), at: text(row.transition_at, "transition_at") }))
      .sort((left, right) => left.run.runId.localeCompare(right.run.runId));
    for (const { run, at } of requeuedRows) {
      await this.enqueueOutboxWith(client, runUpdatedEvent(run, "lease_expired_requeued", "leased", at));
    }
    for (const { run, at } of indeterminateRows) {
      await this.enqueueOutboxWith(client, runUpdatedEvent(run, "lease_expired_indeterminate", "running", at));
    }
    return {
      requeued: requeuedRows.map(({ run }) => run),
      indeterminate: indeterminateRows.map(({ run }) => run),
    };
  }

  reapExpiredLeases(now: string): Promise<LeaseExpiryResult> {
    return this.tx((client) => this.reapWith(client, now));
  }

  async claimRun(input: ClaimRunInput): Promise<RunRecord | undefined> {
    return this.tx(async (client) => {
      await this.reapWith(client, input.now);
      const result = await client.query<Row>(
        `WITH candidate AS (
           SELECT run_id FROM control_runs
           WHERE status = 'queued'
           ORDER BY priority DESC, queued_at ASC, run_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE control_runs AS run
         SET status = 'leased', worker_id = $1, lease_id = $2,
             fencing_token = run.fencing_token + 1,
             lease_expires_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond'),
             version = run.version + 1
         FROM candidate
         WHERE run.run_id = candidate.run_id
         RETURNING ${RUN_COLUMNS.split(",").map((column) => `run.${column.trim()}`).join(", ")},
                   CURRENT_TIMESTAMP AS transition_at`,
        [input.workerId, input.leaseId, input.leaseMs],
      );
      if (!result.rows[0]) return undefined;
      const record = runRow(result.rows[0]);
      await this.enqueueOutboxWith(client, runLeasedEvent(record, text(result.rows[0].transition_at, "transition_at")));
      return record;
    });
  }

  private async diagnoseLease(client: PostgresQueryable, input: LeaseMutationInput): Promise<never> {
    const result = await client.query<Row>(
      `SELECT ${RUN_COLUMNS}, lease_expires_at > CURRENT_TIMESTAMP AS lease_active
       FROM control_runs WHERE run_id = $1`,
      [input.runId],
    );
    if (!result.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
    const run = runRow(result.rows[0]);
    if (run.workerId !== input.workerId || run.leaseId !== input.leaseId || run.fencingToken !== input.fencingToken) {
      throw new ControlPlaneError("CP_STALE_LEASE", `run ${input.runId} lease is stale`);
    }
    if (!run.leaseExpiresAt || !boolean(result.rows[0].lease_active, "lease_active")) {
      throw new ControlPlaneError("CP_LEASE_EXPIRED", `run ${input.runId} lease expired`);
    }
    throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is ${run.status}`);
  }

  async startRun(input: LeaseMutationInput): Promise<RunRecord> {
    return this.tx(async (client) => {
      const locked = await client.query<Row>(
        `SELECT ${RUN_COLUMNS}, lease_expires_at > CURRENT_TIMESTAMP AS lease_active
         FROM control_runs WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      if (!locked.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
      const current = runRow(locked.rows[0]);
      if (current.workerId !== input.workerId || current.leaseId !== input.leaseId || current.fencingToken !== input.fencingToken) {
        throw new ControlPlaneError("CP_STALE_LEASE", `run ${input.runId} lease is stale`);
      }
      if (!current.leaseExpiresAt || !boolean(locked.rows[0].lease_active, "lease_active")) {
        throw new ControlPlaneError("CP_LEASE_EXPIRED", `run ${input.runId} lease expired`);
      }
      if (current.status === "running") return current;
      if (current.status !== "leased") {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is ${current.status}`);
      }
      const result = await client.query<Row>(
        `UPDATE control_runs
         SET status = 'running', started_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE run_id = $1 AND version = $2 AND status = 'leased'
           AND lease_expires_at > CURRENT_TIMESTAMP
         RETURNING ${RUN_COLUMNS}`,
        [input.runId, current.version],
      );
      if (!result.rows[0]) return this.diagnoseLease(client, input);
      const record = runRow(result.rows[0]);
      await this.enqueueOutboxWith(client, runUpdatedEvent(record, "started", "leased", record.startedAt!));
      return record;
    });
  }

  async heartbeatRun(input: HeartbeatRunInput): Promise<RunRecord> {
    return this.tx(async (client) => {
      const result = await client.query<Row>(
        `UPDATE control_runs
         SET lease_expires_at = CURRENT_TIMESTAMP + ($5 * INTERVAL '1 millisecond'),
             version = version + 1
         WHERE run_id = $1 AND worker_id = $2 AND lease_id = $3
           AND fencing_token = $4 AND lease_expires_at > CURRENT_TIMESTAMP
           AND status IN ('leased', 'running')
         RETURNING ${RUN_COLUMNS}, CURRENT_TIMESTAMP AS transition_at`,
        [input.runId, input.workerId, input.leaseId, input.fencingToken, input.leaseMs],
      );
      if (!result.rows[0]) return this.diagnoseLease(client, input);
      const record = runRow(result.rows[0]);
      await this.enqueueOutboxWith(client, runUpdatedEvent(
        record,
        "heartbeat",
        record.status,
        text(result.rows[0].transition_at, "transition_at"),
      ));
      return record;
    });
  }

  async completeRun(input: CompleteRunInput): Promise<RunRecord> {
    return this.tx(async (client) => {
      const locked = await client.query<Row>(
        `SELECT ${RUN_COLUMNS}, lease_expires_at > CURRENT_TIMESTAMP AS lease_active
         FROM control_runs WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      if (!locked.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
      const current = runRow(locked.rows[0]);
      if (isTerminalRunState(current.status)) {
        if (
          current.completionKey === input.completionKey &&
          current.status === input.status &&
          current.reportPath === input.reportPath
        ) return current;
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is already complete`);
      }
      if (current.workerId !== input.workerId || current.leaseId !== input.leaseId || current.fencingToken !== input.fencingToken) {
        throw new ControlPlaneError("CP_STALE_LEASE", `run ${input.runId} lease is stale`);
      }
      if (!current.leaseExpiresAt || !boolean(locked.rows[0].lease_active, "lease_active")) {
        throw new ControlPlaneError("CP_LEASE_EXPIRED", `run ${input.runId} lease expired`);
      }
      if (current.status !== "running" && !(current.status === "leased" && input.status === "canceled")) {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} has not started`);
      }
      let result: PostgresQueryResult<Row>;
      try {
        result = await client.query<Row>(
          `UPDATE control_runs
           SET status = $2, completion_key = $3, report_path = $4,
               finished_at = CURRENT_TIMESTAMP, worker_id = NULL, lease_id = NULL,
               lease_expires_at = NULL, version = version + 1
           WHERE run_id = $1 AND version = $5
             AND lease_expires_at > CURRENT_TIMESTAMP
           RETURNING ${RUN_COLUMNS}`,
          [input.runId, input.status, input.completionKey, input.reportPath ?? null, current.version],
        );
      } catch (error) {
        // The schema's global uniqueness constraint is the race-safe arbiter;
        // translate its SQLSTATE instead of reporting a permanent conflict as 503.
        if (postgresErrorCode(error) === "23505") {
          throw new ControlPlaneError("CP_CONFLICT", "completion idempotency key was already used");
        }
        throw error;
      }
      if (!result.rows[0]) return this.diagnoseLease(client, input);
      const record = runRow(result.rows[0]);
      await this.enqueueOutboxWith(client, runUpdatedEvent(
        record,
        record.status === "canceled" ? "canceled" : "completed",
        current.status,
        record.finishedAt!,
      ));
      return record;
    });
  }

  async cancelRun(input: CancelRunInput): Promise<RunRecord> {
    return this.tx(async (client) => {
      const locked = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM control_runs WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      if (!locked.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
      const current = runRow(locked.rows[0]);
      if (current.version !== input.expectedVersion) {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
      }
      if (isTerminalRunState(current.status)) {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is already complete`);
      }
      const updated = await client.query<Row>(
        `UPDATE control_runs
         SET status = 'canceled', finished_at = CURRENT_TIMESTAMP,
             worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
             version = version + 1
         WHERE run_id = $1 AND version = $2
         RETURNING ${RUN_COLUMNS}`,
        [input.runId, input.expectedVersion],
      );
      if (!updated.rows[0]) throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
      const record = runRow(updated.rows[0]);
      await this.enqueueOutboxWith(client, runUpdatedEvent(record, "canceled", current.status, record.finishedAt!, input.note));
      return record;
    });
  }

  async reconcileRun(input: ReconcileRunInput): Promise<RunRecord> {
    if (input.action !== "retry" && input.action !== "cancel") {
      throw new ControlPlaneError("CP_INVALID_INPUT", "invalid reconciliation action");
    }
    return this.tx(async (client) => {
      const locked = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM control_runs WHERE run_id = $1 FOR UPDATE`,
        [input.runId],
      );
      if (!locked.rows[0]) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
      const current = runRow(locked.rows[0]);
      if (current.version !== input.expectedVersion) {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
      }
      if (current.status !== "indeterminate") {
        throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is not indeterminate`);
      }
      const updated = input.action === "retry"
        ? await client.query<Row>(
            `UPDATE control_runs
             SET status = 'queued', attempt = attempt + 1,
                 queued_at = CURRENT_TIMESTAMP, started_at = NULL,
                 finished_at = NULL, completion_key = NULL, report_path = NULL,
                 worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
                 version = version + 1
             WHERE run_id = $1 AND version = $2 AND status = 'indeterminate'
             RETURNING ${RUN_COLUMNS}`,
            [input.runId, input.expectedVersion],
          )
        : await client.query<Row>(
            `UPDATE control_runs
             SET status = 'canceled', finished_at = CURRENT_TIMESTAMP,
                 worker_id = NULL, lease_id = NULL, lease_expires_at = NULL,
                 version = version + 1
             WHERE run_id = $1 AND version = $2 AND status = 'indeterminate'
             RETURNING ${RUN_COLUMNS}`,
            [input.runId, input.expectedVersion],
          );
      if (!updated.rows[0]) throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
      const record = runRow(updated.rows[0]);
      const transitionAt = record.status === "queued" ? record.queuedAt : record.finishedAt!;
      await this.enqueueOutboxWith(client, runUpdatedEvent(record, "reconciled", current.status, transitionAt, input.note));
      return record;
    });
  }

  private async registerArtifactWith(
    client: PostgresQueryable,
    record: ArtifactRecord,
    emitEvent = true,
  ): Promise<AdmissionResult<ArtifactRecord>> {
    const inserted = await client.query<Row>(
      `INSERT INTO control_artifacts
        (artifact_id, kind, bucket, object_key, sha256, bytes, content_type,
         task_id, run_id, session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT DO NOTHING
       RETURNING ${ARTIFACT_COLUMNS}`,
      [
        record.artifactId, record.kind, record.bucket, record.key, record.sha256,
        record.bytes, record.contentType, record.taskId ?? null, record.runId ?? null,
        record.sessionId ?? null, record.createdAt,
      ],
    );
    if (inserted.rows[0]) {
      const stored = artifactRow(inserted.rows[0]);
      if (emitEvent) await this.enqueueOutboxWith(client, artifactRegisteredEvent(stored));
      return { record: stored, created: true };
    }
    const found = await client.query<Row>(
      `SELECT ${ARTIFACT_COLUMNS} FROM control_artifacts
       WHERE artifact_id = $1 OR (bucket = $2 AND object_key = $3)`,
      [record.artifactId, record.bucket, record.key],
    );
    const existing = found.rows.map(artifactRow).find((item) => item.artifactId === record.artifactId);
    if (!existing || !artifactsEqual(existing, record)) {
      throw new ControlPlaneError("CP_CONFLICT", `artifact ${record.artifactId} conflicts with existing metadata`);
    }
    if (emitEvent) await this.enqueueOutboxWith(client, artifactRegisteredEvent(existing));
    return { record: existing, created: false };
  }

  registerArtifact(record: ArtifactRecord): Promise<AdmissionResult<ArtifactRecord>> {
    return this.tx((client) => this.registerArtifactWith(client, record));
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    await this.prepared();
    try {
      const result = await this.pool.query<Row>(
        `SELECT ${ARTIFACT_COLUMNS} FROM control_artifacts WHERE artifact_id = $1`,
        [artifactId],
      );
      return result.rows[0] ? artifactRow(result.rows[0]) : undefined;
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  async getAuditCheckpoint(sessionId: string, now: string): Promise<AuditCheckpoint> {
    await this.prepared();
    try {
      const result = await this.pool.query<Row>(
        "SELECT session_id, next_seq, artifact_id, updated_at FROM control_audit_checkpoints WHERE session_id = $1",
        [sessionId],
      );
      return result.rows[0] ? checkpointRow(result.rows[0]) : { sessionId, nextSeq: -1, updatedAt: now };
    } catch (error) {
      throw controlPlaneError(error);
    }
  }

  async commitAuditExport(input: AuditExportCommitInput): Promise<{ checkpoint: AuditCheckpoint; artifact: AdmissionResult<ArtifactRecord>; committed: boolean }> {
    return this.tx(async (client) => {
      if (input.artifact.kind !== "audit" || input.artifact.sessionId !== input.sessionId) {
        throw new ControlPlaneError("CP_INVALID_INPUT", "audit artifact session does not match checkpoint");
      }
      await client.query(
        `INSERT INTO control_audit_checkpoints (session_id, next_seq, updated_at)
         VALUES ($1, -1, $2) ON CONFLICT (session_id) DO NOTHING`,
        [input.sessionId, input.updatedAt],
      );
      const locked = await client.query<Row>(
        `SELECT session_id, next_seq, artifact_id, updated_at
         FROM control_audit_checkpoints WHERE session_id = $1 FOR UPDATE`,
        [input.sessionId],
      );
      const current = checkpointRow(locked.rows[0]!);
      if (current.nextSeq !== input.expectedNextSeq) {
        if (current.nextSeq === input.nextSeq && current.artifactId === input.artifact.artifactId) {
          const existing = await this.getArtifactWith(client, input.artifact.artifactId);
          if (!existing || !artifactsEqual(existing, input.artifact)) {
            throw new ControlPlaneError("CP_CONFLICT", "audit retry does not match committed artifact");
          }
          return { checkpoint: current, artifact: { record: existing, created: false }, committed: false };
        }
        throw new ControlPlaneError("CP_CONFLICT", "audit checkpoint advanced concurrently");
      }
      if (input.nextSeq <= input.expectedNextSeq) {
        throw new ControlPlaneError("CP_INVALID_INPUT", "audit checkpoint must advance");
      }
      const artifact = await this.registerArtifactWith(client, input.artifact, false);
      const updated = await client.query<Row>(
        `UPDATE control_audit_checkpoints
         SET next_seq = $2, artifact_id = $3, updated_at = $4
         WHERE session_id = $1 AND next_seq = $5
         RETURNING session_id, next_seq, artifact_id, updated_at`,
        [input.sessionId, input.nextSeq, artifact.record.artifactId, input.updatedAt, input.expectedNextSeq],
      );
      if (!updated.rows[0]) throw new ControlPlaneError("CP_CONFLICT", "audit checkpoint advanced concurrently");
      if (input.eventCount > 0) {
        await this.enqueueOutboxWith(client, artifactRegisteredEvent(artifact.record));
        await this.enqueueOutboxWith(client, auditExportedEvent(input));
      }
      return { checkpoint: checkpointRow(updated.rows[0]), artifact, committed: true };
    });
  }

  async claimOutbox(input: ClaimOutboxInput): Promise<OutboxEventRecord | undefined> {
    return this.tx(async (client) => {
      const result = await client.query<Row>(
        `WITH first_unpublished AS (
           SELECT candidate.sequence
           FROM control_event_outbox AS candidate
           WHERE candidate.published_at IS NULL
             AND candidate.available_at <= CURRENT_TIMESTAMP
             AND (candidate.publisher_id IS NULL OR candidate.claim_expires_at <= CURRENT_TIMESTAMP)
             AND NOT EXISTS (
               SELECT 1 FROM control_event_outbox AS earlier
               WHERE earlier.published_at IS NULL
                 AND earlier.sequence < candidate.sequence
             )
           ORDER BY candidate.sequence ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE control_event_outbox AS event
         SET publisher_id = $1,
             claim_expires_at = CURRENT_TIMESTAMP + ($2 * INTERVAL '1 millisecond'),
             publish_attempts = event.publish_attempts + 1,
             fencing_token = event.fencing_token + 1,
             last_error = NULL
         FROM first_unpublished
         WHERE event.sequence = first_unpublished.sequence
         RETURNING ${OUTBOX_COLUMNS.split(",").map((column) => `event.${column.trim()}`).join(", ")}`,
        [input.publisherId, input.leaseMs],
      );
      return result.rows[0] ? outboxRow(result.rows[0]) : undefined;
    });
  }

  async markOutboxPublished(input: OutboxMutationInput): Promise<void> {
    await this.tx(async (client) => {
      const result = await client.query<Row>(
        `UPDATE control_event_outbox
         SET published_at = CURRENT_TIMESTAMP, publisher_id = NULL, claim_expires_at = NULL,
             last_error = NULL
         WHERE event_id = $1 AND publisher_id = $2 AND fencing_token = $3
           AND published_at IS NULL
         RETURNING event_id`,
        [input.eventId, input.publisherId, input.fencingToken],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneError("CP_STALE_LEASE", `outbox event ${input.eventId} claim is stale`);
      }
    });
  }

  async releaseOutbox(input: ReleaseOutboxInput): Promise<void> {
    await this.tx(async (client) => {
      const result = await client.query<Row>(
        `UPDATE control_event_outbox
         SET publisher_id = NULL, claim_expires_at = NULL,
             available_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
             last_error = $5
         WHERE event_id = $1 AND publisher_id = $2 AND fencing_token = $3
           AND published_at IS NULL
         RETURNING event_id`,
        [input.eventId, input.publisherId, input.fencingToken, input.retryDelayMs, input.error],
      );
      if (!result.rows[0]) {
        throw new ControlPlaneError("CP_STALE_LEASE", `outbox event ${input.eventId} claim is stale`);
      }
    });
  }

  private async getArtifactWith(client: PostgresQueryable, artifactId: string): Promise<ArtifactRecord | undefined> {
    const result = await client.query<Row>(
      `SELECT ${ARTIFACT_COLUMNS} FROM control_artifacts WHERE artifact_id = $1`,
      [artifactId],
    );
    return result.rows[0] ? artifactRow(result.rows[0]) : undefined;
  }
}

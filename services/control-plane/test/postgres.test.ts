import { describe, expect, it } from "vitest";
import { NativePostgresPool } from "../src/pg-wire";
import {
  PostgresControlPlaneRepository,
  readControlPlaneMigration,
  type PostgresClient,
  type PostgresParameter,
  type PostgresPool,
  type PostgresQueryResult,
} from "../src/postgres";

const runRow = {
  run_id: "run-1",
  task_id: "task-1",
  manifest_digest: "a".repeat(64),
  admission_key: "admit-1",
  status: "leased",
  priority: 4,
  attempt: 1,
  worker_id: "worker-1",
  lease_id: "lease-1",
  fencing_token: "7",
  lease_expires_at: "2026-01-01T00:01:00.000Z",
  queued_at: "2026-01-01T00:00:00.000Z",
  started_at: null,
  finished_at: null,
  completion_key: null,
  report_path: null,
  version: "2",
};

class ScriptedPool implements PostgresPool {
  readonly calls: Array<{ sql: string; parameters?: readonly PostgresParameter[] }> = [];
  released: unknown[] = [];
  leaseActive = true;
  failHeartbeat = false;
  completionKeyCollision = false;
  private currentRun: Record<string, unknown> = { ...runRow };

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    return this.execute<Row>(sql, parameters);
  }

  async connect(): Promise<PostgresClient> {
    return {
      query: <Row extends Record<string, unknown>>(sql: string, parameters?: readonly PostgresParameter[]) => (
        this.execute<Row>(sql, parameters)
      ),
      release: (error?: unknown) => { this.released.push(error); },
    };
  }

  private async execute<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, parameters });
    if (sql.includes("SELECT manifest_digest FROM control_tasks")) {
      return { rows: [{ manifest_digest: "a".repeat(64) } as unknown as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO control_runs")) {
      return {
        rows: [{
          ...this.currentRun,
          status: "queued",
          worker_id: null,
          lease_id: null,
          lease_expires_at: null,
          fencing_token: "0",
          queued_at: "2026-01-01T00:00:00.000Z",
          version: "1",
        } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("FOR UPDATE SKIP LOCKED")) {
      return { rows: [{ ...this.currentRun, transition_at: "2026-01-01T00:00:00.000Z" } as Row], rowCount: 1 };
    }
    if (sql.includes("FROM control_runs WHERE run_id = $1") && sql.includes("lease_active")) {
      return { rows: [{ ...this.currentRun, lease_active: this.leaseActive } as Row], rowCount: 1 };
    }
    if (sql.includes("SET status = 'running', started_at = CURRENT_TIMESTAMP")) {
      this.currentRun = {
        ...this.currentRun,
        status: "running",
        started_at: "2026-01-01T00:00:01.000Z",
        version: "3",
      };
      return {
        rows: [{ ...this.currentRun, transition_at: "2026-01-01T00:00:02.000Z" } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("SET lease_expires_at = CURRENT_TIMESTAMP")) {
      if (this.failHeartbeat) return { rows: [], rowCount: 0 };
      this.currentRun = { ...this.currentRun, lease_expires_at: "2026-01-01T00:02:00.000Z", version: "4" };
      return {
        rows: [{ ...this.currentRun, transition_at: "2026-01-01T00:00:02.000Z" } as Row],
        rowCount: 1,
      };
    }
    if (sql.includes("SET status = $2, completion_key")) {
      if (this.completionKeyCollision) {
        throw Object.assign(new Error("duplicate completion key"), { code: "23505" });
      }
      this.currentRun = {
        ...this.currentRun,
        status: parameters?.[1],
        worker_id: null,
        lease_id: null,
        lease_expires_at: null,
        completion_key: parameters?.[2],
        report_path: parameters?.[3],
        finished_at: "2026-01-01T00:00:03.000Z",
        version: "5",
      };
      return { rows: [this.currentRun as Row], rowCount: 1 };
    }
    if (sql.includes("UPDATE control_event_outbox_sequence")) {
      return { rows: [{ sequence: "1" } as unknown as Row], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO control_event_outbox")) {
      return { rows: [{ event_id: "inserted" } as unknown as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class MigrationPool implements PostgresPool {
  readonly calls: string[] = [];
  readonly released: unknown[] = [];
  version: string | undefined;
  failOutboxOnce = false;
  private transactionVersion: string | undefined;

  constructor(version?: string) {
    this.version = version;
  }

  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    return this.execute(sql, parameters);
  }

  async connect(): Promise<PostgresClient> {
    return {
      query: <Row extends Record<string, unknown>>(sql: string, parameters?: readonly PostgresParameter[]) => (
        this.execute<Row>(sql, parameters)
      ),
      release: (error?: unknown) => { this.released.push(error); },
    };
  }

  private async execute<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(sql);
    if (sql === "BEGIN") this.transactionVersion = this.version;
    if (sql === "ROLLBACK") this.version = this.transactionVersion;
    if (sql.includes("SELECT value FROM control_plane_meta") && sql.includes("FOR UPDATE")) {
      return { rows: this.version === undefined ? [] : [{ value: this.version } as unknown as Row] };
    }
    if (sql.includes("control_event_outbox_sequence") && this.failOutboxOnce) {
      this.failOutboxOnce = false;
      throw new Error("transient migration failure");
    }
    if (sql.includes("INSERT INTO control_plane_meta") && parameters?.[0] !== undefined) {
      this.version = String(parameters[0]);
    }
    return { rows: [] };
  }
}

describe("Postgres control-plane repository", () => {
  it("ships an append-safe schema with queue and lease indexes", async () => {
    const migration = await readControlPlaneMigration();
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS control_tasks");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS control_runs");
    expect(migration).toContain("fencing_token BIGINT NOT NULL");
    expect(migration).toContain("UNIQUE (bucket, object_key)");
    expect(migration).toContain("next_seq >= -1");
    expect(migration).toContain("control_event_outbox_sequence");
    expect(migration).not.toContain("GENERATED ALWAYS AS IDENTITY");
    expect(migration).toContain("control_artifacts_immutable");
  });

  it("reaps expired leases and claims atomically with SKIP LOCKED and a fresh fence", async () => {
    const pool = new ScriptedPool();
    const repository = new PostgresControlPlaneRepository(pool, { autoMigrate: false });
    const claimed = await repository.claimRun({
      workerId: "worker-1",
      leaseId: "lease-1",
      leaseMs: 60_000,
      now: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(claimed).toMatchObject({
      runId: "run-1",
      status: "leased",
      workerId: "worker-1",
      leaseId: "lease-1",
      fencingToken: 7,
    });
    const sql = pool.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("status = 'queued', attempt = attempt + 1");
    expect(sql).toContain("status = 'indeterminate'");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("fencing_token = run.fencing_token + 1");
    expect(sql).toContain("CURRENT_TIMESTAMP + ($3 * INTERVAL '1 millisecond')");
    expect(sql).toContain("UPDATE control_event_outbox_sequence");
    expect(sql.indexOf("UPDATE control_event_outbox_sequence"))
      .toBeLessThan(sql.indexOf("INSERT INTO control_event_outbox"));
    expect(sql).toContain("COMMIT");
    expect(pool.released).toEqual([undefined]);
  });

  it("orders a newly queued run by the database timestamp, not replica time", async () => {
    const pool = new ScriptedPool();
    const repository = new PostgresControlPlaneRepository(pool, { autoMigrate: false });
    const result = await repository.enqueueRun({
      runId: "run-1",
      taskId: "task-1",
      manifestDigest: "a".repeat(64),
      admissionKey: "admit-1",
      priority: 4,
      queuedAt: "1900-01-01T00:00:00.000Z",
    });
    expect(result.record.queuedAt).toBe("2026-01-01T00:00:00.000Z");
    const insert = pool.calls.find((call) => call.sql.includes("INSERT INTO control_runs"))!;
    expect(insert.sql).toContain("CURRENT_TIMESTAMP");
    expect(insert.parameters).not.toContain("1900-01-01T00:00:00.000Z");
  });

  it("wraps the maintained PostgreSQL driver with strict URL and TLS configuration", () => {
    expect(() => new NativePostgresPool({ connectionString: "mysql://localhost/db" })).toThrow(/PostgreSQL/u);
    expect(() => new NativePostgresPool({ connectionString: "postgres://user@localhost/db?sslmode=maybe" }))
      .toThrow(/sslmode/u);
    expect(() => new NativePostgresPool({ connectionString: "postgres://user:pass@localhost/db?sslmode=disable" }))
      .not.toThrow();
  });

  it("uses database time for start, heartbeat, completion, and lease diagnosis", async () => {
    const pool = new ScriptedPool();
    const repository = new PostgresControlPlaneRepository(pool, { autoMigrate: false });
    const identity = {
      runId: "run-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      fencingToken: 7,
      now: "1900-01-01T00:00:00.000Z",
    };
    await expect(repository.startRun(identity)).resolves.toMatchObject({ status: "running" });
    await expect(repository.heartbeatRun({
      ...identity,
      leaseMs: 30_000,
      expiresAt: "1900-01-01T00:00:30.000Z",
    })).resolves.toMatchObject({ status: "running" });
    await expect(repository.completeRun({
      ...identity,
      status: "passed",
      completionKey: "complete-1",
    })).resolves.toMatchObject({ status: "passed" });
    const sql = pool.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("started_at = CURRENT_TIMESTAMP");
    expect(sql).toContain("lease_expires_at > CURRENT_TIMESTAMP");
    expect(sql).toContain("CURRENT_TIMESTAMP + ($5 * INTERVAL '1 millisecond')");
    expect(sql).toContain("finished_at = CURRENT_TIMESTAMP");

    const expiredPool = new ScriptedPool();
    expiredPool.failHeartbeat = true;
    expiredPool.leaseActive = false;
    const expiredRepository = new PostgresControlPlaneRepository(expiredPool, { autoMigrate: false });
    await expect(expiredRepository.heartbeatRun({
      ...identity,
      leaseMs: 30_000,
      expiresAt: "2999-01-01T00:00:30.000Z",
    })).rejects.toMatchObject({ code: "CP_LEASE_EXPIRED" });
  });

  it("allows leased worker cancellation and maps completion-key uniqueness races to conflict", async () => {
    const identity = {
      runId: "run-1",
      workerId: "worker-1",
      leaseId: "lease-1",
      fencingToken: 7,
      now: "2026-01-01T00:00:00.000Z",
    };
    const cancelPool = new ScriptedPool();
    const cancelRepository = new PostgresControlPlaneRepository(cancelPool, { autoMigrate: false });
    await expect(cancelRepository.completeRun({
      ...identity,
      status: "canceled",
      completionKey: "cancel-before-start",
    })).resolves.toMatchObject({ status: "canceled" });

    const collisionPool = new ScriptedPool();
    collisionPool.completionKeyCollision = true;
    const collisionRepository = new PostgresControlPlaneRepository(collisionPool, { autoMigrate: false });
    await expect(collisionRepository.completeRun({
      ...identity,
      status: "canceled",
      completionKey: "already-used",
    })).rejects.toMatchObject({ code: "CP_CONFLICT", status: 409 });
    expect(collisionPool.calls).toContainEqual(expect.objectContaining({ sql: "ROLLBACK" }));
  });

  it("serializes ordered migrations, retries transient failures, and preserves healthy clients", async () => {
    const pool = new MigrationPool();
    pool.failOutboxOnce = true;
    const repository = new PostgresControlPlaneRepository(pool);
    await expect(repository.migrate()).rejects.toMatchObject({ code: "CP_STORAGE_FAILED" });
    await expect(repository.migrate()).resolves.toBeUndefined();
    expect(pool.calls.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    const successfulStart = pool.calls.lastIndexOf("BEGIN");
    const successful = pool.calls.slice(successfulStart);
    expect(successful.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS control_tasks")))
      .toBeLessThan(successful.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS control_event_outbox")));
    expect(pool.version).toBe("2");
    expect(pool.released).toEqual([undefined, undefined]);
  });

  it("rejects a future schema under the advisory lock without applying migrations", async () => {
    const pool = new MigrationPool("99");
    const repository = new PostgresControlPlaneRepository(pool);
    await expect(repository.migrate()).rejects.toMatchObject({ code: "CP_NOT_READY" });
    expect(pool.calls.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(pool.calls.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS control_tasks"))).toBe(false);
    expect(pool.released).toEqual([undefined]);
  });
});

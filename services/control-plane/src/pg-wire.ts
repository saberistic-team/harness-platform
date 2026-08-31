import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { ControlPlaneError } from "./errors";
import type {
  PostgresClient,
  PostgresParameter,
  PostgresPool,
  PostgresQueryResult,
} from "./postgres";
import { requireInteger } from "./util";

export interface NativePostgresPoolOptions {
  connectionString: string;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  maxConnections?: number;
  maxWaiters?: number;
  idleTimeoutMs?: number;
}

interface ValidatedPoolOptions {
  connectionString: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  maxConnections: number;
  maxWaiters: number;
  idleTimeoutMs: number;
}

function validatedOptions(options: NativePostgresPoolOptions): ValidatedPoolOptions {
  let url: URL;
  try {
    url = new URL(options.connectionString);
  } catch {
    throw new ControlPlaneError("CP_INVALID_INPUT", "PostgreSQL connection string is invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname || !url.username || url.pathname === "/"
  ) {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      "PostgreSQL connection string must include a host, user, and database",
    );
  }
  const sslMode = url.searchParams.get("sslmode") ?? "verify-full";
  if (sslMode !== "disable" && sslMode !== "require" && sslMode !== "verify-full") {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      "PostgreSQL sslmode must be disable, require, or verify-full",
    );
  }
  // Production fails closed when sslmode is omitted. Local reference manifests
  // opt into plaintext explicitly with sslmode=disable.
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", sslMode);
  return {
    connectionString: url.toString(),
    connectTimeoutMs: requireInteger(
      options.connectTimeoutMs ?? 10_000,
      "PostgreSQL connectTimeoutMs",
      100,
      300_000,
    ),
    statementTimeoutMs: requireInteger(
      options.statementTimeoutMs ?? 60_000,
      "PostgreSQL statementTimeoutMs",
      100,
      600_000,
    ),
    maxConnections: requireInteger(
      options.maxConnections ?? 10,
      "PostgreSQL maxConnections",
      1,
      100,
    ),
    maxWaiters: requireInteger(
      options.maxWaiters ?? 100,
      "PostgreSQL maxWaiters",
      0,
      10_000,
    ),
    idleTimeoutMs: requireInteger(
      options.idleTimeoutMs ?? 30_000,
      "PostgreSQL idleTimeoutMs",
      1_000,
      600_000,
    ),
  };
}

function parameters(values: readonly PostgresParameter[] | undefined): unknown[] | undefined {
  return values?.map((value) => value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value)
    : value);
}

function result<Row extends Record<string, unknown>>(
  value: { rows: QueryResultRow[]; rowCount: number | null },
): PostgresQueryResult<Row> {
  return { rows: value.rows as Row[], rowCount: value.rowCount };
}

class StandardPostgresClient implements PostgresClient {
  private released = false;

  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    if (this.released) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "PostgreSQL client was already released");
    }
    return result<Row>(await this.client.query(sql, parameters(values)));
  }

  release(error?: unknown): void {
    if (this.released) return;
    this.released = true;
    if (error === undefined) this.client.release();
    else this.client.release(error instanceof Error ? error : new Error("PostgreSQL operation failed"));
  }
}

/**
 * Bounded adapter over the maintained `pg` driver. The historical class name
 * is retained so agent-server and deployments do not need a coordinated API
 * rename, but no PostgreSQL wire protocol is implemented in this repository.
 */
export class NativePostgresPool implements PostgresPool {
  private readonly pool: Pool;
  private readonly maxWaiters: number;
  private readonly maxConnections: number;
  private closed = false;

  constructor(options: NativePostgresPoolOptions) {
    const config = validatedOptions(options);
    this.maxWaiters = config.maxWaiters;
    this.maxConnections = config.maxConnections;
    this.pool = new Pool({
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      query_timeout: config.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.statementTimeoutMs,
      max: config.maxConnections,
      idleTimeoutMillis: config.idleTimeoutMs,
      allowExitOnIdle: true,
      application_name: "harness-control-plane",
    });
    // A background socket failure must never become an unhandled EventEmitter
    // error. The next bounded query/connect reports readiness failure normally.
    this.pool.on("error", () => {});
  }

  private assertAvailable(): void {
    if (this.closed) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "PostgreSQL pool is closed");
    }
    if (
      this.pool.idleCount === 0 &&
      this.pool.totalCount >= this.maxConnections &&
      this.pool.waitingCount >= this.maxWaiters
    ) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "PostgreSQL acquisition queue is full");
    }
  }

  async connect(): Promise<PostgresClient> {
    this.assertAvailable();
    try {
      return new StandardPostgresClient(await this.pool.connect());
    } catch (error) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "PostgreSQL connection acquisition failed", {
        cause: error,
      });
    }
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly PostgresParameter[],
  ): Promise<PostgresQueryResult<Row>> {
    this.assertAvailable();
    try {
      return result<Row>(await this.pool.query(sql, parameters(values)));
    } catch (error) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "PostgreSQL query failed", { cause: error });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

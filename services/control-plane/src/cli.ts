import { redactEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import {
  migratePostgresSessions,
  PostgresSessionStore,
  type Queryable,
  type TransactionRunner,
} from "@harness/sessions";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ArtifactRegistry, InMemoryObjectStore } from "./artifacts";
import {
  AuditExporter,
  SessionStoreAuditEventSource,
} from "./audit";
import { controlPlaneConfigFromEnvironment, type ControlPlaneConfig } from "./config";
import { ControlPlaneError } from "./errors";
import { InMemoryControlPlaneRepository } from "./memory-repository";
import { NativePostgresPool } from "./pg-wire";
import { OutboxPublisher } from "./outbox";
import {
  PostgresControlPlaneRepository,
  type PostgresParameter,
  type PostgresPool,
  type PostgresQueryable,
} from "./postgres";
import { S3ObjectStore } from "./s3";
import { Scheduler } from "./scheduler";
import { startControlPlaneServer, type RunningControlPlaneServer } from "./server";
import { canonicalJson, requireInteger } from "./util";
import type {
  AuditEventPage,
  AuditEventSource,
  ControlPlaneRepository,
  EventSink,
  ObjectStore,
  SequencedEvent,
} from "./types";

const HELP = `harness-control-plane — M4 scheduler, artifact registry, and audit service

Usage:
  harness-control-plane [--host host] [--port n]

Required production environment:
  DATABASE_URL
  HARNESS_ARTIFACT_ENDPOINT, HARNESS_ARTIFACT_BUCKET
  HARNESS_ARTIFACT_ACCESS_KEY, HARNESS_ARTIFACT_SECRET_KEY

For explicit offline development only:
  HARNESS_CONTROL_PLANE_IN_MEMORY=true`;

const CONTROL_PLANE_EVENT_SESSION_ID = "control-plane-events-v1";
const CONTROL_PLANE_EVENT_METADATA = { kind: "control-plane-events", version: 1 } as const;

function postgresParameter(value: unknown): PostgresParameter {
  if (
    value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean" || value instanceof Date || value instanceof Uint8Array
  ) return value;
  throw new ControlPlaneError("CP_INVALID_INPUT", "unsupported PostgreSQL parameter value");
}

function queryAdapter(queryable: PostgresQueryable): Queryable {
  return {
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      return queryable.query<Row>(text, values.map(postgresParameter));
    },
  };
}

function transactionAdapter(pool: PostgresPool): TransactionRunner {
  return {
    async run<T>(operation: (transaction: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let releaseError: unknown;
      try {
        await client.query("BEGIN");
        const result = await operation(queryAdapter(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          releaseError = rollbackError;
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
  };
}

class MemoryEventStream implements AuditEventSource {
  private readonly events: SequencedEvent[] = [];
  private readonly eventIds = new Map<string, string>();

  readonly sink: EventSink = (event) => {
    const redacted = redactEvent(event);
    const wire = serializeEvent(redacted);
    const existing = this.eventIds.get(redacted.eventId);
    if (existing === wire) return;
    if (existing !== undefined) {
      throw new ControlPlaneError("CP_CONFLICT", `event ${redacted.eventId} was delivered with another payload`);
    }
    this.eventIds.set(redacted.eventId, wire);
    this.events.push({ seq: this.events.length, event: redacted });
  };

  async read(streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage> {
    if (streamId !== "global") throw new ControlPlaneError("CP_NOT_FOUND", `audit stream ${streamId} was not found`);
    const events = this.events.filter((item) => item.seq > afterCursor).slice(0, limit);
    return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
  }
}

export interface ControlPlaneRuntimeDependencies {
  repository?: ControlPlaneRepository;
  objectStore?: ObjectStore;
  auditSource?: AuditEventSource;
  onEvent?: EventSink;
  postgresPool?: PostgresPool;
  newId?: (prefix: string) => string;
  now?: () => string;
  /** Set to zero to disable automatic audit draining in deterministic tests. */
  auditDrainIntervalMs?: number;
  auditDrainMaxPages?: number;
  onBackgroundError?: (error: unknown) => void;
}

export interface RunningControlPlaneRuntime {
  server: RunningControlPlaneServer;
  close(): Promise<void>;
}

export async function startControlPlaneRuntime(
  config: ControlPlaneConfig,
  dependencies: ControlPlaneRuntimeDependencies = {},
): Promise<RunningControlPlaneRuntime> {
  const newId = dependencies.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const now = dependencies.now ?? (() => new Date().toISOString());
  let pool = dependencies.postgresPool;
  let ownsPool = false;
  let sessionStore: PostgresSessionStore | undefined;
  let memoryEvents: MemoryEventStream | undefined;
  let outbox: OutboxPublisher | undefined;
  let auditTimer: NodeJS.Timeout | undefined;
  let auditDrainRunning: Promise<void> | undefined;
  const backgroundFailures = new Set<"outbox" | "audit">();
  const reportedBackgroundFailures = new Set<"outbox" | "audit">();
  const reportBackgroundFailure = (component: "outbox" | "audit", error: unknown): void => {
    backgroundFailures.add(component);
    if (reportedBackgroundFailures.has(component)) return;
    reportedBackgroundFailures.add(component);
    try {
      (dependencies.onBackgroundError ?? ((cause: unknown) => {
        console.error(
          cause instanceof ControlPlaneError
            ? `harness-control-plane: background ${component} failed: ${cause.message}`
            : `harness-control-plane: background ${component} failed`,
        );
      }))(error);
    } catch {
      // Observability hooks cannot stop retry or recovery.
    }
  };
  const reportBackgroundRecovery = (component: "outbox" | "audit"): void => {
    backgroundFailures.delete(component);
    reportedBackgroundFailures.delete(component);
  };
  const backgroundReady = (): void => {
    if (backgroundFailures.size > 0) {
      throw new ControlPlaneError("CP_NOT_READY", "control-plane background processing is not ready");
    }
  };

  try {
    let repository = dependencies.repository;
    if (!repository) {
      if (config.inMemory) repository = new InMemoryControlPlaneRepository();
      else {
        if (!pool) {
          pool = new NativePostgresPool({ connectionString: config.databaseUrl! });
          ownsPool = true;
        }
        repository = new PostgresControlPlaneRepository(pool);
      }
    }

    let eventSink = dependencies.onEvent;
    let auditSource = dependencies.auditSource;
    if ((!eventSink || !auditSource) && !pool && !config.inMemory) {
      pool = new NativePostgresPool({ connectionString: config.databaseUrl! });
      ownsPool = true;
    }
    if ((!eventSink || !auditSource) && pool) {
      const queryable = queryAdapter(pool);
      const transactions = transactionAdapter(pool);
      await migratePostgresSessions(queryable, transactions);
      sessionStore = new PostgresSessionStore({
        queryable,
        transactions,
        newId,
        // Deterministic tests may inject a clock. Production deliberately
        // leaves this unset so Postgres is authoritative for lease fencing.
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      });
      const stream = await sessionStore.createSession({
        sessionId: CONTROL_PLANE_EVENT_SESSION_ID,
        metadata: CONTROL_PLANE_EVENT_METADATA,
      });
      if (
        stream.status !== "active" ||
        canonicalJson(stream.metadata) !== canonicalJson(CONTROL_PLANE_EVENT_METADATA)
      ) {
        throw new ControlPlaneError("CP_STORAGE_FAILED", "shared control-plane event stream is invalid");
      }
      eventSink ??= async (event: AnyHarnessEvent) => {
        await sessionStore!.appendEvent(stream.sessionId, redactEvent(event));
      };
      auditSource ??= new SessionStoreAuditEventSource(sessionStore);
    }
    if (!eventSink || !auditSource) {
      memoryEvents = new MemoryEventStream();
      eventSink ??= memoryEvents.sink;
      auditSource ??= memoryEvents;
    }

    const objectStore = dependencies.objectStore ?? (
      config.s3 ? new S3ObjectStore(config.s3) : new InMemoryObjectStore()
    );
    outbox = new OutboxPublisher({
      repository,
      sink: eventSink,
      publisherId: newId("publisher"),
      now,
      onHealthFailure: (error) => reportBackgroundFailure("outbox", error),
      onHealthRecovery: () => reportBackgroundRecovery("outbox"),
    });
    const scheduler = new Scheduler({
      repository,
      outbox,
      newId,
      now,
      defaultLeaseMs: config.defaultLeaseMs,
      maxLeaseMs: config.maxLeaseMs,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore,
      outbox,
      newId,
      now,
      maxArtifactBytes: config.maxArtifactBytes,
    });
    const audit = new AuditExporter({
      repository,
      source: auditSource,
      artifacts,
      outbox,
    });
    const auditDrainIntervalMs = dependencies.auditDrainIntervalMs ?? 1_000;
    if (auditDrainIntervalMs !== 0) {
      requireInteger(auditDrainIntervalMs, "auditDrainIntervalMs", 10, 60_000);
    }
    const auditDrainMaxPages = requireInteger(
      dependencies.auditDrainMaxPages ?? 10,
      "auditDrainMaxPages",
      1,
      1_000,
    );
    const drainAudit = () => {
      if (auditDrainRunning) return;
      const running = audit.drainAvailable("global", auditDrainMaxPages).then(() => {
        reportBackgroundRecovery("audit");
      });
      auditDrainRunning = running;
      void running.catch((error) => {
        // Poison evidence and transient failures remain durable for the next
        // bounded interval; API serving and committed mutations continue.
        reportBackgroundFailure("audit", error);
      }).finally(() => {
        if (auditDrainRunning === running) auditDrainRunning = undefined;
      });
    };
    const server = await startControlPlaneServer({
      scheduler,
      artifacts,
      audit,
      host: config.host,
      port: config.port,
      authToken: config.authToken,
      maxRequestBytes: config.maxRequestBytes,
      maxInFlightRequests: config.maxInFlightRequests,
      backgroundReady,
      newId,
    });
    outbox.start();
    if (auditDrainIntervalMs !== 0) {
      auditTimer = setInterval(drainAudit, auditDrainIntervalMs);
      auditTimer.unref();
      drainAudit();
    }
    let closing: Promise<void> | undefined;
    return {
      server,
      close() {
        closing ??= (async () => {
          if (auditTimer) clearInterval(auditTimer);
          await server.close();
          try {
            await outbox?.flush();
            await auditDrainRunning?.catch(() => {});
            await audit.drainAvailable("global", auditDrainMaxPages).catch(() => {});
            await outbox?.flush();
          } finally {
            await outbox?.close().catch(() => {});
            sessionStore?.close();
            if (ownsPool && pool instanceof NativePostgresPool) await pool.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      if (auditTimer) clearInterval(auditTimer);
      await auditDrainRunning?.catch(() => {});
      await outbox?.close();
    } catch {
      // Preserve the startup failure while best-effort stopping its publisher.
    } finally {
      sessionStore?.close();
      if (ownsPool && pool instanceof NativePostgresPool) await pool.close();
    }
    throw error;
  }
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ControlPlaneRuntimeDependencies = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const config = controlPlaneConfigFromEnvironment(env);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--host") config.host = argv[++index] ?? "";
    else if (argument === "--port") config.port = Number(argv[++index]);
    else {
      console.error(`harness-control-plane: unknown option ${argument ?? ""}`);
      return 2;
    }
  }
  if (!config.host || !Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    console.error("harness-control-plane: invalid host or port");
    return 2;
  }
  const runtime = await startControlPlaneRuntime(config, dependencies);
  console.log(`harness-control-plane: ${runtime.server.url}`);
  let requestStop!: () => void;
  const stopping = new Promise<void>((resolve) => { requestStop = resolve; });
  const onSignal = () => requestStop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await stopping;
    await runtime.close();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

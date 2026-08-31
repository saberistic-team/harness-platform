import { deserializeEvent, redactEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import { ArtifactRegistry } from "./artifacts";
import { ControlPlaneError } from "./errors";
import type {
  ArtifactRecord,
  AuditEventSource,
  ControlPlaneRepository,
  OutboxKick,
  AuditEventPage,
  SequencedEvent,
} from "./types";
import { requireId, requireInteger, requireIso, sha256Hex } from "./util";
import type { PostgresQueryable } from "./postgres";

export function isDefaultAuditEvent(event: AnyHarnessEvent): boolean {
  // Export bookkeeping is observable through its own durable event, but
  // re-exporting it would manufacture an endless audit tail. Output/report
  // artifact registrations remain evidence; only the audit chunk itself is
  // excluded from its successor.
  if (event.type === "audit.exported") return false;
  if (event.type === "artifact.registered" && event.data.kind === "audit") return false;
  return true;
}

export interface AuditExporterOptions {
  repository: ControlPlaneRepository;
  source: AuditEventSource;
  artifacts: ArtifactRegistry;
  outbox?: OutboxKick;
  includeEvent?: (event: AnyHarnessEvent) => boolean;
  maxEventsPerExport?: number;
  maxExportBytes?: number;
}

export interface AuditExportResult {
  exportId: string;
  artifact: ArtifactRecord;
  fromSeq: number;
  /** Inclusive last source sequence represented by this export. */
  toSeq: number;
  eventCount: number;
  sha256: string;
  checkpointNextSeq: number;
}

export interface GlobalAuditSessionStore {
  readAuditEvents(options: {
    afterGlobalSeq?: number;
    limit?: number;
  }): Promise<{
    events: Array<{ globalSeq: number; event: AnyHarnessEvent }>;
    nextAfterGlobalSeq: number;
    hasMore: boolean;
  }>;
}

/** Adapt @harness/sessions' validated global audit cursor to this exporter. */
export class SessionStoreAuditEventSource implements AuditEventSource {
  constructor(
    private readonly store: GlobalAuditSessionStore,
    private readonly streamId = "global",
  ) {}

  async read(streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage> {
    if (streamId !== this.streamId) {
      throw new ControlPlaneError("CP_NOT_FOUND", `audit stream ${streamId} was not found`);
    }
    const page = await this.store.readAuditEvents({
      ...(afterCursor < 0 ? {} : { afterGlobalSeq: afterCursor }),
      limit,
    });
    return {
      events: page.events.map((item) => ({ seq: item.globalSeq, event: item.event })),
      nextCursor: page.nextAfterGlobalSeq,
    };
  }
}

/**
 * Production fallback over @harness/sessions' documented append-only schema.
 * Every payload still crosses deserializeEvent; malformed evidence fails closed.
 */
export class PostgresAuditEventSource implements AuditEventSource {
  constructor(
    private readonly database: PostgresQueryable,
    private readonly streamId = "global",
  ) {}

  async read(streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage> {
    if (streamId !== this.streamId) {
      throw new ControlPlaneError("CP_NOT_FOUND", `audit stream ${streamId} was not found`);
    }
    const page = await this.database.query<{ global_seq: unknown; payload: unknown }>(
      `SELECT global_seq, payload FROM harness_events
       WHERE global_seq > $1 ORDER BY global_seq ASC LIMIT $2`,
      [afterCursor, limit],
    );
    const events = page.rows.map((row) => {
      const globalSeq = Number(row.global_seq);
      if (!Number.isSafeInteger(globalSeq) || globalSeq < 0 || typeof row.payload !== "string") {
        throw new ControlPlaneError("CP_STORAGE_FAILED", "session database returned invalid audit evidence");
      }
      return { seq: globalSeq, event: deserializeEvent(row.payload) };
    });
    return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
  }
}

function assertOrdered(rows: readonly SequencedEvent[], afterCursor: number, nextCursor: number, limit: number): void {
  if (rows.length > limit) {
    throw new ControlPlaneError("CP_STORAGE_FAILED", "audit event source exceeded its requested limit");
  }
  let previous = afterCursor;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.seq) || row.seq <= previous) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "audit event source returned unordered or duplicate evidence");
    }
    previous = row.seq;
  }
  if (!Number.isSafeInteger(nextCursor) || (rows.length > 0 && nextCursor < previous)) {
    throw new ControlPlaneError("CP_STORAGE_FAILED", "audit event source returned an invalid cursor");
  }
}

/**
 * Export a deterministic redacted JSONL chunk. The object is written first;
 * artifact metadata and the checkpoint then commit in one repository transaction.
 */
export class AuditExporter {
  private readonly repository: ControlPlaneRepository;
  private readonly source: AuditEventSource;
  private readonly artifacts: ArtifactRegistry;
  private readonly outbox?: OutboxKick;
  private readonly includeEvent: (event: AnyHarnessEvent) => boolean;
  private readonly maxEventsPerExport: number;
  private readonly maxExportBytes: number;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: AuditExporterOptions) {
    this.repository = options.repository;
    this.source = options.source;
    this.artifacts = options.artifacts;
    this.outbox = options.outbox;
    this.includeEvent = options.includeEvent ?? isDefaultAuditEvent;
    this.maxEventsPerExport = requireInteger(
      options.maxEventsPerExport ?? 1_000,
      "maxEventsPerExport",
      1,
      10_000,
    );
    this.maxExportBytes = requireInteger(
      options.maxExportBytes ?? 8 * 1024 * 1024,
      "maxExportBytes",
      1,
      64 * 1024 * 1024,
    );
  }

  exportNext(sessionIdInput: string): Promise<AuditExportResult | undefined> {
    return this.exclusive(() => this.exportNextUnlocked(sessionIdInput));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => {}, () => {});
    return result;
  }

  private async exportNextUnlocked(sessionIdInput: string): Promise<AuditExportResult | undefined> {
    const sessionId = requireId(sessionIdInput, "sessionId");
    const probeAt = new Date(0).toISOString();
    const checkpoint = await this.repository.getAuditCheckpoint(sessionId, probeAt);
    let pageLimit = this.maxEventsPerExport;
    let page: AuditEventPage;
    let included: string[];
    let body: Buffer;
    for (;;) {
      page = await this.source.read(sessionId, checkpoint.nextSeq, pageLimit);
      assertOrdered(page.events, checkpoint.nextSeq, page.nextCursor, pageLimit);
      if (page.events.length === 0) return undefined;
      requireIso(page.events[page.events.length - 1]!.event.at, "audit event timestamp");
      included = page.events
        .filter((row) => this.includeEvent(row.event))
        .map((row) => serializeEvent(redactEvent(row.event)));
      const jsonl = included.length === 0 ? "" : `${included.join("\n")}\n`;
      body = Buffer.from(jsonl, "utf8");
      if (body.byteLength <= this.maxExportBytes) break;
      if (page.events.length === 1 || pageLimit === 1) {
        throw new ControlPlaneError(
          "CP_PAYLOAD_TOO_LARGE",
          `single audit event exceeds the ${this.maxExportBytes}-byte limit`,
        );
      }
      pageLimit = Math.max(1, Math.floor(Math.min(pageLimit, page.events.length) / 2));
    }

    const rows = page.events;

    const fromSeq = rows[0]!.seq;
    const toSeq = rows[rows.length - 1]!.seq;
    const nextSeq = page.nextCursor;
    const digest = sha256Hex(body);
    const sessionHash = sha256Hex(sessionId).slice(0, 24);
    const exportId = `audit-${sessionHash}-${fromSeq}-${toSeq}-${digest.slice(0, 16)}`;
    const artifactId = `artifact-${exportId}`;
    const objectKey = `audit/${sessionHash}/${String(fromSeq).padStart(16, "0")}-${String(toSeq).padStart(16, "0")}-${digest}.jsonl`;
    // An event timestamp is stable across retries, unlike the wall clock after
    // upload. This keeps deterministic artifact metadata under concurrency.
    const createdAt = requireIso(rows[rows.length - 1]!.event.at, "audit event timestamp");
    const prepared = await this.artifacts.prepare({
      artifactId,
      objectKey,
      kind: "audit",
      body,
      contentType: "application/x-ndjson",
      sessionId,
    });
    const artifact: ArtifactRecord = { ...prepared, createdAt };
    const committed = await this.repository.commitAuditExport({
      sessionId,
      expectedNextSeq: checkpoint.nextSeq,
      nextSeq,
      artifact,
      updatedAt: createdAt,
      exportId,
      fromSeq,
      toSeq,
      eventCount: included.length,
      sha256: digest,
    });
    // A bookkeeping-only page advances through an immutable empty artifact,
    // but emits no new bookkeeping events. This makes the recursion drain in
    // one pass while retaining object+metadata-before-checkpoint ordering.
    this.outbox?.kick();
    return {
      exportId,
      artifact: committed.artifact.record,
      fromSeq,
      toSeq,
      eventCount: included.length,
      sha256: digest,
      checkpointNextSeq: committed.checkpoint.nextSeq,
    };
  }

  async drainAvailable(
    sessionIdInput: string,
    maxPages = 10,
  ): Promise<AuditExportResult[]> {
    const sessionId = requireId(sessionIdInput, "sessionId");
    const limit = requireInteger(maxPages, "maxPages", 1, 1_000);
    const results: AuditExportResult[] = [];
    for (let page = 0; page < limit; page++) {
      const exported = await this.exportNext(sessionId);
      if (!exported) break;
      results.push(exported);
    }
    return results;
  }
}

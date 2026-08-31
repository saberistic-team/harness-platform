import type { AnyHarnessEvent } from "@harness/events";
import type { TaskManifest } from "@harness/sdk";

export type RunState =
  | "queued"
  | "leased"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "canceled"
  | "indeterminate";

export type TerminalRunState = Extract<
  RunState,
  "passed" | "failed" | "blocked" | "canceled"
>;

export interface TaskRecord {
  taskId: string;
  manifest: TaskManifest;
  manifestDigest: string;
  admissionKey: string;
  admittedAt: string;
  version: number;
}

export interface RunRecord {
  runId: string;
  taskId: string;
  manifestDigest: string;
  admissionKey: string;
  status: RunState;
  priority: number;
  attempt: number;
  workerId?: string;
  leaseId?: string;
  fencingToken: number;
  leaseExpiresAt?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  completionKey?: string;
  reportPath?: string;
  version: number;
}

export type ArtifactKind = "run_report" | "output" | "audit";

export interface ArtifactRecord {
  artifactId: string;
  kind: ArtifactKind;
  bucket: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  createdAt: string;
}

export interface AuditCheckpoint {
  sessionId: string;
  nextSeq: number;
  artifactId?: string;
  updatedAt: string;
}

export interface SequencedEvent {
  seq: number;
  event: AnyHarnessEvent;
}

export interface AuditEventPage {
  events: SequencedEvent[];
  /** Opaque durable cursor returned by the source; never synthesize it. */
  nextCursor: number;
}

export interface AdmitTaskInput {
  manifest: TaskManifest;
  manifestDigest: string;
  admissionKey: string;
  admittedAt: string;
}

export interface EnqueueRunInput {
  runId: string;
  taskId: string;
  manifestDigest: string;
  admissionKey: string;
  priority: number;
  queuedAt: string;
}

export interface ClaimRunInput {
  workerId: string;
  leaseId: string;
  leaseMs: number;
  now: string;
  expiresAt: string;
}

export interface LeaseMutationInput {
  runId: string;
  workerId: string;
  leaseId: string;
  fencingToken: number;
  now: string;
}

export interface HeartbeatRunInput extends LeaseMutationInput {
  leaseMs: number;
  expiresAt: string;
}

export interface CancelRunInput {
  runId: string;
  expectedVersion: number;
  now: string;
  note?: string;
}

export interface ReconcileRunInput extends CancelRunInput {
  action: "retry" | "cancel";
}

export interface CompleteRunInput extends LeaseMutationInput {
  status: TerminalRunState;
  completionKey: string;
  reportPath?: string;
}

export interface LeaseExpiryResult {
  requeued: RunRecord[];
  indeterminate: RunRecord[];
}

export interface AuditExportCommitInput {
  sessionId: string;
  expectedNextSeq: number;
  nextSeq: number;
  artifact: ArtifactRecord;
  updatedAt: string;
  /** Inclusive source range represented by the immutable object. */
  fromSeq: number;
  toSeq: number;
  exportId: string;
  eventCount: number;
  sha256: string;
}

export interface OutboxEventRecord {
  sequence: number;
  event: AnyHarnessEvent;
  attempts: number;
  fencingToken: number;
}

export interface ClaimOutboxInput {
  publisherId: string;
  now: string;
  expiresAt: string;
  leaseMs: number;
}

export interface OutboxMutationInput {
  eventId: string;
  publisherId: string;
  fencingToken: number;
  now: string;
}

export interface ReleaseOutboxInput extends OutboxMutationInput {
  availableAt: string;
  retryDelayMs: number;
  error: string;
}

export interface OutboxKick {
  /** Schedule a best-effort publish pass without joining the API mutation. */
  kick(): void;
}

export interface AdmissionResult<T> {
  record: T;
  created: boolean;
}

export interface ListOptions {
  limit: number;
}

export interface ControlPlaneRepository {
  ready(): Promise<void>;
  admitTask(input: AdmitTaskInput): Promise<AdmissionResult<TaskRecord>>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  listTasks(options: ListOptions): Promise<TaskRecord[]>;
  enqueueRun(input: EnqueueRunInput): Promise<AdmissionResult<RunRecord>>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  listRuns(options: ListOptions & { taskId?: string }): Promise<RunRecord[]>;
  reapExpiredLeases(now: string): Promise<LeaseExpiryResult>;
  claimRun(input: ClaimRunInput): Promise<RunRecord | undefined>;
  startRun(input: LeaseMutationInput): Promise<RunRecord>;
  heartbeatRun(input: HeartbeatRunInput): Promise<RunRecord>;
  completeRun(input: CompleteRunInput): Promise<RunRecord>;
  cancelRun(input: CancelRunInput): Promise<RunRecord>;
  reconcileRun(input: ReconcileRunInput): Promise<RunRecord>;
  registerArtifact(record: ArtifactRecord): Promise<AdmissionResult<ArtifactRecord>>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | undefined>;
  getAuditCheckpoint(sessionId: string, now: string): Promise<AuditCheckpoint>;
  commitAuditExport(input: AuditExportCommitInput): Promise<{
    checkpoint: AuditCheckpoint;
    artifact: AdmissionResult<ArtifactRecord>;
    /** False only for an idempotent retry after another caller committed. */
    committed: boolean;
  }>;
  claimOutbox(input: ClaimOutboxInput): Promise<OutboxEventRecord | undefined>;
  markOutboxPublished(input: OutboxMutationInput): Promise<void>;
  releaseOutbox(input: ReleaseOutboxInput): Promise<void>;
}

export interface ObjectPutInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  sha256: string;
  ifAbsent?: boolean;
}

export interface ObjectPutResult {
  etag?: string;
  alreadyExisted: boolean;
}

export interface ObjectStore {
  readonly bucket: string;
  ready(): Promise<void>;
  putObject(input: ObjectPutInput): Promise<ObjectPutResult>;
  signedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface AuditEventSource {
  read(streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage>;
}

/** A sink must treat a repeated eventId as an idempotent delivery retry. */
export type EventSink = (event: AnyHarnessEvent) => void | Promise<void>;

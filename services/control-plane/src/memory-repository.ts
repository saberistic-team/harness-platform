import { ControlPlaneError } from "./errors";
import {
  artifactRegisteredEvent,
  auditExportedEvent,
  runLeasedEvent,
  runScheduledEvent,
  runUpdatedEvent,
  sameEvent,
  taskAdmittedEvent,
} from "./outbox-events";
import { assertRunTransition, isTerminalRunState } from "./state";
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
  TaskRecord,
} from "./types";
import type { AnyHarnessEvent } from "@harness/events";
import { canonicalJson, clone, requireIso } from "./util";

function same<T>(left: T, right: T): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameArtifact(left: ArtifactRecord, right: ArtifactRecord): boolean {
  const { createdAt: _leftCreatedAt, ...leftIdentity } = left;
  const { createdAt: _rightCreatedAt, ...rightIdentity } = right;
  return same(leftIdentity, rightIdentity);
}

function expired(expiresAt: string | undefined, now: string): boolean {
  return expiresAt === undefined || Date.parse(expiresAt) <= Date.parse(now);
}

function withoutLease(run: RunRecord): RunRecord {
  const copy = { ...run };
  delete copy.workerId;
  delete copy.leaseId;
  delete copy.leaseExpiresAt;
  return copy;
}

interface MemoryOutboxRecord extends OutboxEventRecord {
  availableAt: string;
  publisherId?: string;
  claimExpiresAt?: string;
  publishedAt?: string;
  lastError?: string;
}

/**
 * Deterministic repository used by tests and explicit single-process dev mode.
 * Mutations contain no `await`, so each method is atomic within a Node process.
 * Returned values are deep copies: callers cannot mutate repository state.
 */
export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly taskAdmissionKeys = new Map<string, string>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly runAdmissionKeys = new Map<string, string>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly artifactObjects = new Map<string, string>();
  private readonly auditCheckpoints = new Map<string, AuditCheckpoint>();
  private readonly outbox = new Map<string, MemoryOutboxRecord>();
  private nextOutboxSequence = 1;

  private enqueueOutbox(event: AnyHarnessEvent): void {
    const existing = this.outbox.get(event.eventId);
    if (existing) {
      if (!sameEvent(existing.event, event)) {
        throw new ControlPlaneError("CP_CONFLICT", `outbox event ${event.eventId} conflicts with existing payload`);
      }
      return;
    }
    this.outbox.set(event.eventId, {
      sequence: this.nextOutboxSequence++,
      event: clone(event),
      attempts: 0,
      fencingToken: 0,
      availableAt: event.at,
    });
  }

  async ready(): Promise<void> {}

  async admitTask(input: AdmitTaskInput): Promise<AdmissionResult<TaskRecord>> {
    const keyedTask = this.taskAdmissionKeys.get(input.admissionKey);
    if (keyedTask !== undefined && keyedTask !== input.manifest.id) {
      throw new ControlPlaneError("CP_CONFLICT", "task idempotency key was already used");
    }
    const existing = this.tasks.get(input.manifest.id);
    if (existing) {
      if (
        existing.manifestDigest !== input.manifestDigest ||
        existing.admissionKey !== input.admissionKey
      ) {
        throw new ControlPlaneError(
          "CP_CONFLICT",
          `task ${input.manifest.id} was already admitted with another manifest or idempotency key`,
        );
      }
      return { record: clone(existing), created: false };
    }
    const record: TaskRecord = {
      taskId: input.manifest.id,
      manifest: clone(input.manifest),
      manifestDigest: input.manifestDigest,
      admissionKey: input.admissionKey,
      admittedAt: input.admittedAt,
      version: 1,
    };
    this.tasks.set(record.taskId, record);
    this.taskAdmissionKeys.set(input.admissionKey, record.taskId);
    this.enqueueOutbox(taskAdmittedEvent(record));
    return { record: clone(record), created: true };
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const record = this.tasks.get(taskId);
    return record ? clone(record) : undefined;
  }

  async listTasks(options: ListOptions): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .slice(0, options.limit)
      .map(clone);
  }

  async enqueueRun(input: EnqueueRunInput): Promise<AdmissionResult<RunRecord>> {
    const task = this.tasks.get(input.taskId);
    if (!task) {
      throw new ControlPlaneError("CP_NOT_FOUND", `task ${input.taskId} was not admitted`);
    }
    if (task.manifestDigest !== input.manifestDigest) {
      throw new ControlPlaneError("CP_CONFLICT", "scheduled manifest does not match admitted task");
    }
    const keyedRunId = this.runAdmissionKeys.get(input.admissionKey);
    if (keyedRunId !== undefined) {
      const keyed = this.runs.get(keyedRunId)!;
      if (
        keyed.taskId !== input.taskId ||
        keyed.manifestDigest !== input.manifestDigest ||
        keyed.priority !== input.priority
      ) {
        throw new ControlPlaneError("CP_CONFLICT", "run idempotency key was already used");
      }
      return { record: clone(keyed), created: false };
    }
    const byId = this.runs.get(input.runId);
    if (byId) {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} already exists`);
    }
    const record: RunRecord = {
      runId: input.runId,
      taskId: input.taskId,
      manifestDigest: input.manifestDigest,
      admissionKey: input.admissionKey,
      status: "queued",
      priority: input.priority,
      attempt: 1,
      fencingToken: 0,
      queuedAt: input.queuedAt,
      version: 1,
    };
    this.runs.set(record.runId, record);
    this.runAdmissionKeys.set(record.admissionKey, record.runId);
    this.enqueueOutbox(runScheduledEvent(record));
    return { record: clone(record), created: true };
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const record = this.runs.get(runId);
    return record ? clone(record) : undefined;
  }

  async listRuns(options: ListOptions & { taskId?: string }): Promise<RunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => options.taskId === undefined || run.taskId === options.taskId)
      .sort((a, b) => b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt) || a.runId.localeCompare(b.runId))
      .slice(0, options.limit)
      .map(clone);
  }

  private reap(now: string): LeaseExpiryResult {
    requireIso(now, "now");
    const requeued: RunRecord[] = [];
    const indeterminate: RunRecord[] = [];
    for (const [runId, current] of this.runs) {
      if ((current.status !== "leased" && current.status !== "running") || !expired(current.leaseExpiresAt, now)) {
        continue;
      }
      if (current.status === "leased") {
        assertRunTransition(current.status, "queued");
        const next: RunRecord = {
          ...withoutLease(current),
          status: "queued",
          attempt: current.attempt + 1,
          queuedAt: now,
          version: current.version + 1,
        };
        this.runs.set(runId, next);
        this.enqueueOutbox(runUpdatedEvent(next, "lease_expired_requeued", "leased", now));
        requeued.push(clone(next));
      } else {
        assertRunTransition(current.status, "indeterminate");
        const next: RunRecord = {
          ...withoutLease(current),
          status: "indeterminate",
          version: current.version + 1,
        };
        this.runs.set(runId, next);
        this.enqueueOutbox(runUpdatedEvent(next, "lease_expired_indeterminate", "running", now));
        indeterminate.push(clone(next));
      }
    }
    return { requeued, indeterminate };
  }

  async reapExpiredLeases(now: string): Promise<LeaseExpiryResult> {
    return this.reap(now);
  }

  async claimRun(input: ClaimRunInput): Promise<RunRecord | undefined> {
    this.reap(input.now);
    requireIso(input.expiresAt, "expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "lease expiry must be in the future");
    }
    const candidate = [...this.runs.values()]
      .filter((run) => run.status === "queued")
      .sort((a, b) => b.priority - a.priority || a.queuedAt.localeCompare(b.queuedAt) || a.runId.localeCompare(b.runId))[0];
    if (!candidate) return undefined;
    assertRunTransition(candidate.status, "leased");
    const next: RunRecord = {
      ...candidate,
      status: "leased",
      workerId: input.workerId,
      leaseId: input.leaseId,
      fencingToken: candidate.fencingToken + 1,
      leaseExpiresAt: input.expiresAt,
      version: candidate.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runLeasedEvent(next, input.now));
    return clone(next);
  }

  private activeLease(input: LeaseMutationInput): RunRecord {
    requireIso(input.now, "now");
    const run = this.runs.get(input.runId);
    if (!run) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
    if (
      run.workerId !== input.workerId ||
      run.leaseId !== input.leaseId ||
      run.fencingToken !== input.fencingToken
    ) {
      throw new ControlPlaneError("CP_STALE_LEASE", `run ${input.runId} lease is stale`);
    }
    if (expired(run.leaseExpiresAt, input.now)) {
      this.reap(input.now);
      throw new ControlPlaneError("CP_LEASE_EXPIRED", `run ${input.runId} lease expired`);
    }
    return run;
  }

  async startRun(input: LeaseMutationInput): Promise<RunRecord> {
    const current = this.activeLease(input);
    if (current.status === "running") return clone(current);
    assertRunTransition(current.status, "running");
    const next: RunRecord = {
      ...current,
      status: "running",
      startedAt: current.startedAt ?? input.now,
      version: current.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runUpdatedEvent(next, "started", current.status, next.startedAt!));
    return clone(next);
  }

  async heartbeatRun(input: HeartbeatRunInput): Promise<RunRecord> {
    const current = this.activeLease(input);
    if (current.status !== "leased" && current.status !== "running") {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is not active`);
    }
    requireIso(input.expiresAt, "expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "heartbeat expiry must be in the future");
    }
    const next = {
      ...current,
      leaseExpiresAt: input.expiresAt,
      version: current.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runUpdatedEvent(next, "heartbeat", current.status, input.now));
    return clone(next);
  }

  async completeRun(input: CompleteRunInput): Promise<RunRecord> {
    const existing = this.runs.get(input.runId);
    if (!existing) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
    if (isTerminalRunState(existing.status)) {
      if (
        existing.completionKey === input.completionKey &&
        existing.status === input.status &&
        existing.reportPath === input.reportPath
      ) return clone(existing);
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is already complete`);
    }
    const current = this.activeLease(input);
    const completionOwner = [...this.runs.values()].find(
      (run) => run.completionKey === input.completionKey,
    );
    if (completionOwner && completionOwner.runId !== input.runId) {
      throw new ControlPlaneError("CP_CONFLICT", "completion idempotency key was already used");
    }
    assertRunTransition(current.status, input.status);
    const next: RunRecord = {
      ...withoutLease(current),
      status: input.status,
      completionKey: input.completionKey,
      ...(input.reportPath === undefined ? {} : { reportPath: input.reportPath }),
      finishedAt: input.now,
      version: current.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runUpdatedEvent(
      next,
      next.status === "canceled" ? "canceled" : "completed",
      current.status,
      input.now,
    ));
    return clone(next);
  }

  async cancelRun(input: CancelRunInput): Promise<RunRecord> {
    requireIso(input.now, "now");
    const current = this.runs.get(input.runId);
    if (!current) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
    if (current.version !== input.expectedVersion) {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
    }
    if (isTerminalRunState(current.status)) {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is already complete`);
    }
    assertRunTransition(current.status, "canceled");
    const next: RunRecord = {
      ...withoutLease(current),
      status: "canceled",
      finishedAt: input.now,
      version: current.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runUpdatedEvent(next, "canceled", current.status, input.now, input.note));
    return clone(next);
  }

  async reconcileRun(input: ReconcileRunInput): Promise<RunRecord> {
    requireIso(input.now, "now");
    if (input.action !== "retry" && input.action !== "cancel") {
      throw new ControlPlaneError("CP_INVALID_INPUT", "invalid reconciliation action");
    }
    const current = this.runs.get(input.runId);
    if (!current) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
    if (current.version !== input.expectedVersion) {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} version changed`);
    }
    if (current.status !== "indeterminate") {
      throw new ControlPlaneError("CP_CONFLICT", `run ${input.runId} is not indeterminate`);
    }
    let next: RunRecord;
    if (input.action === "retry") {
      next = {
        ...withoutLease(current),
        status: "queued",
        attempt: current.attempt + 1,
        queuedAt: input.now,
        version: current.version + 1,
      };
      delete next.startedAt;
      delete next.finishedAt;
      delete next.completionKey;
      delete next.reportPath;
    } else next = {
      ...withoutLease(current),
      status: "canceled",
      finishedAt: input.now,
      version: current.version + 1,
    };
    this.runs.set(next.runId, next);
    this.enqueueOutbox(runUpdatedEvent(next, "reconciled", current.status, input.now, input.note));
    return clone(next);
  }

  private artifactAdmission(
    record: ArtifactRecord,
    emitEvent = true,
  ): AdmissionResult<ArtifactRecord> {
    const existing = this.artifacts.get(record.artifactId);
    if (existing) {
      if (!sameArtifact(existing, record)) {
        throw new ControlPlaneError("CP_CONFLICT", `artifact ${record.artifactId} already exists`);
      }
      return { record: clone(existing), created: false };
    }
    const objectIdentity = `${record.bucket}\n${record.key}`;
    const objectArtifact = this.artifactObjects.get(objectIdentity);
    if (objectArtifact !== undefined && objectArtifact !== record.artifactId) {
      throw new ControlPlaneError("CP_CONFLICT", "artifact object key is already registered");
    }
    const stored = clone(record);
    this.artifacts.set(stored.artifactId, stored);
    this.artifactObjects.set(objectIdentity, stored.artifactId);
    if (emitEvent) this.enqueueOutbox(artifactRegisteredEvent(stored));
    return { record: clone(stored), created: true };
  }

  async registerArtifact(record: ArtifactRecord): Promise<AdmissionResult<ArtifactRecord>> {
    return this.artifactAdmission(record);
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    const record = this.artifacts.get(artifactId);
    return record ? clone(record) : undefined;
  }

  async getAuditCheckpoint(sessionId: string, now: string): Promise<AuditCheckpoint> {
    return clone(this.auditCheckpoints.get(sessionId) ?? {
      sessionId,
      nextSeq: -1,
      updatedAt: now,
    });
  }

  async commitAuditExport(input: AuditExportCommitInput): Promise<{ checkpoint: AuditCheckpoint; artifact: AdmissionResult<ArtifactRecord>; committed: boolean }> {
    if (input.artifact.kind !== "audit" || input.artifact.sessionId !== input.sessionId) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "audit artifact session does not match checkpoint");
    }
    const current = this.auditCheckpoints.get(input.sessionId) ?? {
      sessionId: input.sessionId,
      nextSeq: -1,
      updatedAt: input.updatedAt,
    };
    if (current.nextSeq !== input.expectedNextSeq) {
      if (current.nextSeq === input.nextSeq && current.artifactId === input.artifact.artifactId) {
        const existing = this.artifacts.get(input.artifact.artifactId);
        if (!existing || !sameArtifact(existing, input.artifact)) {
          throw new ControlPlaneError("CP_CONFLICT", "audit retry does not match committed artifact");
        }
        return { checkpoint: clone(current), artifact: { record: clone(existing), created: false }, committed: false };
      }
      throw new ControlPlaneError("CP_CONFLICT", "audit checkpoint advanced concurrently");
    }
    if (input.nextSeq <= input.expectedNextSeq) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "audit checkpoint must advance");
    }
    // Validate both mutations before changing either map.
    const existingArtifact = this.artifacts.get(input.artifact.artifactId);
    if (existingArtifact && !sameArtifact(existingArtifact, input.artifact)) {
      throw new ControlPlaneError("CP_CONFLICT", `artifact ${input.artifact.artifactId} already exists`);
    }
    const objectIdentity = `${input.artifact.bucket}\n${input.artifact.key}`;
    const objectArtifact = this.artifactObjects.get(objectIdentity);
    if (objectArtifact !== undefined && objectArtifact !== input.artifact.artifactId) {
      throw new ControlPlaneError("CP_CONFLICT", "artifact object key is already registered");
    }
    const artifact = this.artifactAdmission(input.artifact, false);
    const checkpoint: AuditCheckpoint = {
      sessionId: input.sessionId,
      nextSeq: input.nextSeq,
      artifactId: artifact.record.artifactId,
      updatedAt: input.updatedAt,
    };
    this.auditCheckpoints.set(input.sessionId, checkpoint);
    if (input.eventCount > 0) {
      this.enqueueOutbox(artifactRegisteredEvent(artifact.record));
      this.enqueueOutbox(auditExportedEvent(input));
    }
    return { checkpoint: clone(checkpoint), artifact, committed: true };
  }

  async claimOutbox(input: ClaimOutboxInput): Promise<OutboxEventRecord | undefined> {
    requireIso(input.now, "now");
    requireIso(input.expiresAt, "expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "outbox claim expiry must be in the future");
    }
    const candidate = [...this.outbox.values()]
      .filter((item) => item.publishedAt === undefined)
      .sort((left, right) => left.sequence - right.sequence)[0];
    if (!candidate) return undefined;
    if (Date.parse(candidate.availableAt) > Date.parse(input.now)) return undefined;
    if (candidate.publisherId !== undefined && Date.parse(candidate.claimExpiresAt!) > Date.parse(input.now)) {
      return undefined;
    }
    candidate.publisherId = input.publisherId;
    candidate.claimExpiresAt = input.expiresAt;
    candidate.attempts += 1;
    candidate.fencingToken += 1;
    delete candidate.lastError;
    return clone({
      sequence: candidate.sequence,
      event: candidate.event,
      attempts: candidate.attempts,
      fencingToken: candidate.fencingToken,
    });
  }

  private activeOutboxClaim(input: OutboxMutationInput): MemoryOutboxRecord {
    const record = this.outbox.get(input.eventId);
    if (!record) throw new ControlPlaneError("CP_NOT_FOUND", `outbox event ${input.eventId} was not found`);
    if (record.publisherId !== input.publisherId || record.fencingToken !== input.fencingToken) {
      throw new ControlPlaneError("CP_STALE_LEASE", `outbox event ${input.eventId} claim is stale`);
    }
    return record;
  }

  async markOutboxPublished(input: OutboxMutationInput): Promise<void> {
    const record = this.activeOutboxClaim(input);
    record.publishedAt = requireIso(input.now, "now");
    delete record.publisherId;
    delete record.claimExpiresAt;
  }

  async releaseOutbox(input: ReleaseOutboxInput): Promise<void> {
    const record = this.activeOutboxClaim(input);
    requireIso(input.now, "now");
    record.availableAt = requireIso(input.availableAt, "availableAt");
    record.lastError = input.error;
    delete record.publisherId;
    delete record.claimExpiresAt;
  }
}

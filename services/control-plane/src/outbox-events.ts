import { createEvent, serializeEvent, type AnyHarnessEvent } from "@harness/events";
import type {
  ArtifactRecord,
  AuditExportCommitInput,
  RunRecord,
  RunState,
  TaskRecord,
} from "./types";
import { canonicalJson, sha256Hex } from "./util";

export type RunUpdateChange =
  | "started"
  | "heartbeat"
  | "completed"
  | "canceled"
  | "lease_expired_requeued"
  | "lease_expired_indeterminate"
  | "reconciled";

function eventId(domain: string, identity: unknown): string {
  return `cp-${sha256Hex(canonicalJson(["control-plane-event/v1", domain, identity]))}`;
}

export function sameEvent(left: AnyHarnessEvent, right: AnyHarnessEvent): boolean {
  return serializeEvent(left) === serializeEvent(right);
}

export function taskAdmittedEvent(record: TaskRecord): AnyHarnessEvent {
  return createEvent("task.updated", {
    taskId: record.taskId,
    phase: "planned",
    note: `admitted manifest ${record.manifestDigest}`,
  }, {
    actor: "control-plane",
    at: record.admittedAt,
    eventId: eventId("task.admitted", [record.taskId, record.version, record.manifestDigest]),
  });
}

export function runScheduledEvent(record: RunRecord): AnyHarnessEvent {
  return createEvent("run.scheduled", {
    runId: record.runId,
    taskId: record.taskId,
    attempt: record.attempt,
    manifestDigest: record.manifestDigest,
  }, {
    actor: "control-plane",
    at: record.queuedAt,
    eventId: eventId("run.scheduled", [record.runId, record.version]),
  });
}

export function runLeasedEvent(record: RunRecord, at: string): AnyHarnessEvent {
  return createEvent("run.leased", {
    runId: record.runId,
    taskId: record.taskId,
    workerId: record.workerId!,
    fencingToken: record.fencingToken,
    expiresAt: record.leaseExpiresAt!,
  }, {
    actor: "control-plane",
    at,
    eventId: eventId("run.leased", [record.runId, record.version, record.fencingToken]),
  });
}

export function runUpdatedEvent(
  record: RunRecord,
  change: RunUpdateChange,
  previousStatus: RunState,
  at: string,
  note?: string,
): AnyHarnessEvent {
  return createEvent("run.updated", {
    runId: record.runId,
    taskId: record.taskId,
    change,
    status: record.status,
    previousStatus,
    version: record.version,
    attempt: record.attempt,
    workerId: record.workerId,
    fencingToken: record.fencingToken,
    leaseExpiresAt: record.leaseExpiresAt,
    reportPath: record.reportPath,
    note,
  }, {
    actor: "control-plane",
    at,
    eventId: eventId("run.updated", [record.runId, record.version, change]),
  });
}

export function artifactRegisteredEvent(record: ArtifactRecord): AnyHarnessEvent {
  return createEvent("artifact.registered", {
    artifactId: record.artifactId,
    kind: record.kind,
    bucket: record.bucket,
    key: record.key,
    sha256: record.sha256,
    bytes: record.bytes,
    contentType: record.contentType,
    taskId: record.taskId,
    runId: record.runId,
    sessionId: record.sessionId,
  }, {
    actor: "control-plane",
    at: record.createdAt,
    eventId: eventId("artifact.registered", record.artifactId),
  });
}

export function auditExportedEvent(input: AuditExportCommitInput): AnyHarnessEvent {
  return createEvent("audit.exported", {
    exportId: input.exportId,
    artifactId: input.artifact.artifactId,
    fromSeq: input.fromSeq,
    toSeq: input.toSeq,
    eventCount: input.eventCount,
    sha256: input.sha256,
  }, {
    actor: "control-plane",
    at: input.updatedAt,
    eventId: eventId("audit.exported", input.exportId),
  });
}

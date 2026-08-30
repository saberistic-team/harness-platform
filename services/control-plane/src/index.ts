/**
 * @harness/control-plane — scheduling, task state, artifact registry.
 *
 * M0: placeholder service. Responsibilities (M4):
 *   - task queue: accepts task manifests, schedules runs
 *   - state store: SQLite locally / Postgres in deployed form
 *   - artifact registry: S3/MinIO object store for reports & outputs
 *   - audit log: every policy.decision + run.recorded event, append-only
 *
 * Everything the control-plane emits is a harness event (packages/events),
 * so the UIs render state rather than parsing service-specific payloads.
 */

export interface ControlPlaneStatus {
  service: "control-plane";
  version: "0.0.0";
  ready: false;
}

export function status(): ControlPlaneStatus {
  return { service: "control-plane", version: "0.0.0", ready: false };
}

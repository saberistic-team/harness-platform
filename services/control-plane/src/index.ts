/** @harness/control-plane — M4 scheduling, state, artifacts, and audit. */

export * from "./artifacts";
export * from "./audit";
export * from "./config";
export * from "./errors";
export * from "./memory-repository";
export * from "./outbox";
export * from "./outbox-events";
export * from "./pg-wire";
export * from "./postgres";
export * from "./scheduler";
export * from "./server";
export * from "./s3";
export * from "./state";
export * from "./types";

export interface ControlPlaneStatus {
  service: "control-plane";
  version: "0.4.0";
  ready: true;
}

export function status(): ControlPlaneStatus {
  return { service: "control-plane", version: "0.4.0", ready: true };
}

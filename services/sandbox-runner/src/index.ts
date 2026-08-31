/**
 * Docker-per-run sandbox boundary.
 *
 * Policy remains pure in @harness/policy. This package compiles the manifest,
 * resolves explicit `ask` decisions, creates a fail-closed Docker plan, and
 * executes that plan through an injectable argv-only process boundary.
 */

export * from "./errors";
export * from "./executor";
export * from "./mounts";
export * from "./plan";
export * from "./runner";
export * from "./types";

export interface SandboxRunnerStatus {
  service: "sandbox-runner";
  version: "0.1.0";
  ready: true;
}

export function status(): SandboxRunnerStatus {
  return { service: "sandbox-runner", version: "0.1.0", ready: true };
}

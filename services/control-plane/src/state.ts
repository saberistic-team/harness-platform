import { ControlPlaneError } from "./errors";
import type { RunState } from "./types";

const TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  queued: new Set(["leased", "canceled"]),
  leased: new Set(["queued", "running", "canceled"]),
  running: new Set(["passed", "failed", "blocked", "canceled", "indeterminate"]),
  indeterminate: new Set(["queued", "canceled"]),
  passed: new Set(),
  failed: new Set(),
  blocked: new Set(),
  canceled: new Set(),
};

export function isTerminalRunState(state: RunState): boolean {
  return state === "passed" || state === "failed" || state === "blocked" || state === "canceled";
}

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return from === to || TRANSITIONS[from].has(to);
}

/** Pure state gate shared by all repositories. */
export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new ControlPlaneError(
      "CP_CONFLICT",
      `run cannot transition from ${from} to ${to}`,
    );
  }
}

export function runStateValues(): readonly RunState[] {
  return [
    "queued",
    "leased",
    "running",
    "passed",
    "failed",
    "blocked",
    "canceled",
    "indeterminate",
  ] as const;
}

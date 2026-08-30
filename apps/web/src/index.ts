/**
 * @harness/web — the minimal task board (ROADMAP M2).
 *
 * M2 scope: read-only board of task manifests + run reports, served
 * by `node:http` (no framework — explicit non-goal), static page +
 * JSON API. No real-time: refresh is a manual pull.
 *
 *   harness-web [--root <dir>] [--port <n>]   launch the board
 */
export * from "./board";
export * from "./serve";

export interface WebStatus {
  app: "harness-web";
  version: "0.1.0";
  ready: true;
  note: "M2 minimal task board: manifests + reports, no real-time";
}

export function status(): WebStatus {
  return {
    app: "harness-web",
    version: "0.1.0",
    ready: true,
    note: "M2 minimal task board: manifests + reports, no real-time",
  };
}

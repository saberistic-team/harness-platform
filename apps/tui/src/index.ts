/**
 * @harness/tui — terminal client for the harness platform.
 *
 * M1: read-only session/event viewer over the SQLite session store
 * and run reports (see ./view.ts, ./render.ts). Interactive driving
 * and permission `ask` flows arrive with the ACP server in M3.
 */

export * from "./render";
export * from "./view";

export function status(): {
  app: string;
  version: string;
  ready: boolean;
  viewer: string;
} {
  return {
    app: "harness-tui",
    version: "0.1.0",
    ready: true,
    viewer: "read-only (M1); interactive in M3 (ACP client)",
  };
}

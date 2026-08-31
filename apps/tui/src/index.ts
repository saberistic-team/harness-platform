/**
 * @harness/tui — terminal client for the harness platform.
 *
 * Read-only session/report viewing plus an interactive M3 ACP client that
 * streams events and resolves permission `ask` requests explicitly.
 */

export * from "./interactive";
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
    version: "0.2.0",
    ready: true,
    viewer: "read-only history + interactive ACP permission client",
  };
}

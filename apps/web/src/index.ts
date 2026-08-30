/**
 * @harness/web — web UI for tasks, run reports, and session inspection.
 *
 * M0: placeholder. The web app speaks ACP over HTTP/WebSocket against
 * the control plane (services/control-plane) and renders the same
 * harness event stream the TUI and tests do.
 */

export interface WebStatus {
  app: "harness-web";
  version: "0.0.0";
  ready: false as const;
  note: "M1 placeholder — build toolchain (Vite) lands in M2";
}

export function status(): WebStatus {
  return {
    app: "harness-web",
    version: "0.0.0",
    ready: false,
    note: "M1 placeholder — build toolchain (Vite) lands in M2",
  };
}

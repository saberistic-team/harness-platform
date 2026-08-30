/**
 * @harness/tui — terminal UI for observing and driving harness runs.
 *
 * M0: placeholder. The TUI is an ACP client (see packages/acp) that
 * renders the session event stream. No dependency on TUI frameworks
 * until the event stream is real.
 */

export interface TuiStatus {
  app: "harness-tui";
  version: "0.0.0";
  ready: false;
  note: "M1 placeholder — ACP client lands in M3";
}

export function status(): TuiStatus {
  return {
    app: "harness-tui",
    version: "0.0.0",
    ready: false,
    note: "M1 placeholder — ACP client lands in M3",
  };
}

import type { AnyHarnessEvent } from "@harness/events";

/**
 * TUI rendering (M1) — a read-only session/event viewer.
 *
 * `render.ts` holds the PURE format functions (no I/O, no TTY): they
 * are unit-testable, golden-diffable, and the single source of the
 * column layout and per-type color hints. `index.ts` does the IO:
 * load a SQLite session store or a run report and feed this layer.
 *
 * Read-only is load-bearing: the viewer never mutates the store, never
 * drives an agent, and never writes files. Interactive operation and
 * permission `ask` flows are M3.
 */

export interface RenderOptions {
  /** Emit ANSI colors. Off when stdout is not a TTY or NO_COLOR is set. */
  color?: boolean;
}

function esc(code: string, s: string, color: boolean): string {
  if (!color || code === "") return s;
  return `\u001b[${code}m${s}\u001b[0m`;
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "·";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/** Tone → foreground color code. */
const TONE_CODE: Record<string, string> = {
  ok: "32",
  fail: "31",
  warn: "33",
  neutral: "",
  dim: "90",
};

function eventToneCode(event: AnyHarnessEvent): string {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case "agent.stopped":
      return d.status === "completed" ? "ok" : "fail";
    case "tool.result":
      return d.ok ? "ok" : "fail";
    case "budget.warning":
      return "warn";
    case "policy.decision":
      return d.effect === "deny" ? "fail" : d.effect === "ask" ? "warn" : "ok";
    case "error":
      return "fail";
    case "run.recorded":
      return d.status === "passed" ? "ok" : "fail";
    default:
      return "dim";
  }
}

/** A one-line human summary of an event payload, keyed by type. */
export function eventSummary(event: AnyHarnessEvent): string {
  const d = event.data as Record<string, unknown>;
  const g = (k: string) => d[k];
  switch (event.type) {
    case "session.created":
      return `session=${str(g("sessionId"))}`;
    case "agent.started":
      return `task=${str(g("taskId"))} model=${str(g("model"))}`;
    case "agent.stopped": {
      const status = str(g("status"));
      const steps = str(g("steps"));
      const calls = str(g("toolCalls"));
      const note = g("note") ? `  ${truncate(String(g("note")), 48)}` : "";
      return `${status} steps=${steps} calls=${calls}${note}`;
    }
    case "model.request":
      return `model=${str(g("model"))} msgs=${str(g("messageCount"))}`;
    case "model.response": {
      const usage = g("usage") as { totalTokens?: number } | undefined;
      return `finish=${str(g("finishReason"))} tokens=${str(usage?.totalTokens)}`;
    }
    case "tool.call":
      return `tool=${str(g("tool"))} input=${truncate(JSON.stringify(g("input") ?? null), 40)}`;
    case "tool.result": {
      const ok = Boolean(g("ok"));
      const err = g("error") as { code?: string; message?: string } | undefined;
      const ms = g("durationMs") !== undefined ? `${str(g("durationMs"))}ms` : "";
      return ok
        ? `ok ${ms ? ms + " " : ""}output=${truncate(JSON.stringify(g("output") ?? null), 40)}`
        : `ERROR ${err?.code ?? "?"}: ${truncate(err?.message ?? "", 60)}${ms ? " " + ms : ""}`;
    }
    case "task.updated":
      return `task=${str(g("taskId"))} phase=${str(g("phase"))}`;
    case "budget.warning":
      return `${str(g("metric"))} at ${str(g("pct"))}% (${str(g("used"))}/${str(g("limit"))})`;
    case "policy.decision":
      return `${str(g("action"))} → ${str(g("effect"))}${g("reason") ? `  ${truncate(String(g("reason")), 60)}` : ""}`;
    case "run.recorded":
      return `run=${str(g("runId"))} status=${str(g("status"))}`;
    case "error":
      return `${str(g("code"))} ${truncate(String(g("message") ?? ""), 80)}`;
    default:
      return "";
  }
}

function padTo(s: string, width: number): string {
  const bare = stripAnsi(s);
  return s + " ".repeat(Math.max(0, width - bare.length));
}

/** Format one event row: `<seq>  <at>  <type>  <summary>`. */
export function renderEventLine(
  seq: number,
  event: AnyHarnessEvent,
  opts: RenderOptions = {},
): string {
  const color = opts.color ?? false;
  const at = event.at.replace("T", " ").replace(/Z$/, "");
  const tone = eventToneCode(event);
  return [
    esc("90", padTo(String(seq), 3), color),
    esc("90", padTo(at, 19), color),
    esc(TONE_CODE[tone] ?? "", padTo(String(event.type), 16), color),
    eventSummary(event),
  ]
    .join("  ")
    .trimEnd();
}

/** Header + rows for a whole session. */
export function renderSession(
  header: string,
  events: AnyHarnessEvent[],
  opts: RenderOptions = {},
): string {
  const color = opts.color ?? false;
  const rule = "─".repeat(72);
  const lines: string[] = [
    esc("1", header, color),
    esc("90", rule, color),
  ];
  events.forEach((e, i) => lines.push(renderEventLine(i, e, opts)));
  lines.push(esc("90", `── ${events.length} event${events.length === 1 ? "" : "s"}`, color));
  return lines.join("\n");
}

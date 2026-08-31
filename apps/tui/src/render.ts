import type { AnyHarnessEvent } from "@harness/events";

/**
 * TUI rendering (M1) — a read-only session/event viewer.
 *
 * `render.ts` holds the PURE format functions (no I/O, no TTY): they
 * are unit-testable, golden-diffable, and the single source of the
 * column layout and per-type color hints. `index.ts` does the IO:
 * load a SQLite session store or a run report and feed this layer.
 *
 * The stored-history viewer remains read-only. M3's interactive client also
 * feeds its streamed events through these same pure formatters.
 */

export interface RenderOptions {
  /** Emit ANSI colors. Off when stdout is not a TTY or NO_COLOR is set. */
  color?: boolean;
}

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** Make untrusted text inert and single-line before it reaches a terminal. */
export function sanitizeTerminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL, (character) => {
    const codePoint = character.codePointAt(0)!;
    return `\\u{${codePoint.toString(16).toUpperCase()}}`;
  });
}

/** Preserve valid JSON while escaping terminal-significant Unicode controls. */
export function terminalSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json.replace(TERMINAL_CONTROL, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0xffff) {
      return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    }
    const adjusted = codePoint - 0x10000;
    const high = 0xd800 + (adjusted >> 10);
    const low = 0xdc00 + (adjusted & 0x3ff);
    return `\\u${high.toString(16).toUpperCase()}\\u${low.toString(16).toUpperCase()}`;
  });
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
  if (typeof v === "object") {
    try {
      return sanitizeTerminalText(JSON.stringify(v) ?? "·");
    } catch {
      return "[unserializable]";
    }
  }
  return sanitizeTerminalText(String(v));
}

function jsonSummary(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function truncate(s: string, max: number): string {
  const safe = sanitizeTerminalText(s);
  return safe.length > max ? `${safe.slice(0, Math.max(0, max - 1))}…` : safe;
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
    case "permission.requested":
      return "warn";
    case "permission.resolved":
      return d.decision === "allow" ? "ok" : "fail";
    case "sandbox.started":
      return d.network === "none" ? "ok" : "warn";
    case "sandbox.stopped":
      return d.status === "completed" ? "ok" : "fail";
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
      return `tool=${str(g("tool"))} input=${truncate(jsonSummary(g("input") ?? null), 40)}`;
    case "tool.result": {
      const ok = Boolean(g("ok"));
      const err = g("error") as { code?: string; message?: string } | undefined;
      const ms = g("durationMs") !== undefined ? `${str(g("durationMs"))}ms` : "";
      return ok
        ? `ok ${ms ? ms + " " : ""}output=${truncate(jsonSummary(g("output") ?? null), 40)}`
        : `ERROR ${sanitizeTerminalText(err?.code ?? "?")}: ${truncate(err?.message ?? "", 60)}${ms ? " " + ms : ""}`;
    }
    case "task.updated":
      return `task=${str(g("taskId"))} phase=${str(g("phase"))}`;
    case "budget.warning":
      return `${str(g("metric"))} at ${str(g("pct"))}% (${str(g("used"))}/${str(g("limit"))})`;
    case "policy.decision":
      return `${str(g("action"))} → ${str(g("effect"))}${g("reason") ? `  ${truncate(String(g("reason")), 60)}` : ""}`;
    case "permission.requested":
      return `${str(g("action"))} → ask  permission=${str(g("permissionId"))} scope=${str(g("scope"))}${g("subject") ? `  ${truncate(String(g("subject")), 48)}` : ""}`;
    case "permission.resolved":
      return `${str(g("action"))} → ${str(g("decision"))}  permission=${str(g("permissionId"))} scope=${str(g("scope"))}`;
    case "sandbox.started":
      return `run=${str(g("runId"))} container=${str(g("containerName"))} network=${str(g("network"))} rw-mounts=${str(g("mounts"))}`;
    case "sandbox.stopped":
      return `run=${str(g("runId"))} status=${str(g("status"))} exit=${str(g("exitCode"))}`;
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
  const at = sanitizeTerminalText(event.at).replace("T", " ").replace(/Z$/, "");
  const tone = eventToneCode(event);
  return [
    esc("90", padTo(String(seq), 3), color),
    esc("90", padTo(at, 19), color),
    esc(TONE_CODE[tone] ?? "", padTo(sanitizeTerminalText(String(event.type)), 16), color),
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
    esc("1", sanitizeTerminalText(header), color),
    esc("90", rule, color),
  ];
  events.forEach((e, i) => lines.push(renderEventLine(i, e, opts)));
  lines.push(esc("90", `── ${events.length} event${events.length === 1 ? "" : "s"}`, color));
  return lines.join("\n");
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deserializeEvent, type AnyHarnessEvent } from "@harness/events";
import {
  getSessionRecord,
  listSessions,
  openSqliteSession,
  SessionStoreError,
} from "@harness/sessions";
import { validateRunReport, type RunReport } from "@harness/sdk";
import {
  renderSession,
  sanitizeTerminalText,
  terminalSafeJson,
} from "./render";

/**
 * The read-only session/event viewer (M1). Loads from the SQLite
 * session store or a run report and renders the event stream. It
 * never mutates, never executes, never writes.
 */

const DEFAULT_DB = "tasks/runs/sessions.sqlite";

export interface ViewContext {
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

interface Flags {
  color?: boolean;
  from?: number;
  limit?: number;
  session?: string;
  raw?: boolean;
}

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--color") flags.color = true;
    else if (a === "--no-color") flags.color = false;
    else if (a === "--raw") flags.raw = true;
    else if (a === "--session") flags.session = argv[++i];
    else if (a === "--from") flags.from = Number(argv[++i]);
    else if (a === "--limit") flags.limit = Number(argv[++i]);
    else positional.push(a);
  }
  return { positional, flags };
}

function colorDefault(out: (s: string) => void): boolean {
  const tty =
    (out as { isTTY?: boolean }).isTTY ??
    (typeof process === "undefined" ? false : Boolean(process.stdout.isTTY));
  const noColor = typeof process !== "undefined" && process.env?.NO_COLOR !== undefined;
  return Boolean(tty) && !noColor;
}

function requireDb(cwd: string, dbPath: string): string {
  const p = resolve(cwd ?? process.cwd(), dbPath);
  if (!existsSync(p)) {
    throw new SessionStoreError(
      "SESS_NOT_FOUND",
      `no session store at ${p} (run "harness run <manifest>" first — it persists sessions there)`,
    );
  }
  return p;
}

async function cmdList(ctx: ViewContext, dbArg?: string, flags?: Flags): Promise<number> {
  const cwd = ctx.cwd ?? process.cwd();
  const out = ctx.out ?? console.log;
  const dbPath = requireDb(cwd, dbArg ?? DEFAULT_DB);
  const sessions = listSessions(dbPath);
  if (sessions.length === 0) {
    out(sanitizeTerminalText(`(no sessions in ${dbPath})`));
    return 0;
  }
  const color = flags?.color ?? colorDefault(out);
  out(renderHeaderLine("SESSIONS", dbPath, color));
  for (const s of sessions) {
    out(
      sanitizeTerminalText(
        `${s.sessionId}  task=${s.taskId ?? "·"}  ${s.status}  ` +
          `${s.eventCount} events  ${s.createdAt}${s.closedAt ? `  closed ${s.closedAt}` : ""}`,
      ),
    );
  }
  return 0;
}

function renderHeaderLine(title: string, sub: string, color: boolean): string {
  const safeTitle = sanitizeTerminalText(title);
  const safeSub = sanitizeTerminalText(sub);
  const t = color ? `\u001b[1m${safeTitle}\u001b[0m` : safeTitle;
  const s = color ? `\u001b[90m ${safeSub}\u001b[0m` : ` — ${safeSub}`;
  return `${t}${s}`;
}

async function cmdShow(ctx: ViewContext, dbArg: string | undefined, flags: Flags): Promise<number> {
  const cwd = ctx.cwd ?? process.cwd();
  const out = ctx.out ?? console.log;
  const dbPath = requireDb(cwd, dbArg ?? DEFAULT_DB);

  let sessionId = flags.session;
  if (!sessionId) {
    const latest = listSessions(dbPath)[0];
    if (!latest) {
      out(sanitizeTerminalText(`(no sessions in ${dbPath})`));
      return 1;
    }
    sessionId = latest.sessionId;
  }
  const record = getSessionRecord(dbPath, sessionId);

  const store = openSqliteSession(dbPath, { sessionId });
  try {
    const total = await store.log.size();
    const from = Math.max(0, flags.from ?? 0);
    const limit = flags.limit ?? total - from;
    const events = await store.log.slice(from, from + limit);

    if (flags.raw) {
      for (const e of events) out(terminalSafeJson(e));
    } else {
      const header = `SESSION ${record.sessionId}  task=${record.taskId ?? "·"}  status=${record.status}  ${total} events (showing ${events.length})`;
      out(renderSession(header, events, { color: flags.color ?? colorDefault(out) }));
    }
  } finally {
    store.close();
  }
  return 0;
}

function cmdReport(ctx: ViewContext, reportArg: string, flags: Flags): number {
  const cwd = ctx.cwd ?? process.cwd();
  const out = ctx.out ?? console.log;
  const err = ctx.err ?? console.error;
  const p = resolve(cwd, reportArg);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    err(`harness-view: cannot read report: ${sanitizeTerminalText((e as Error).message)}`);
    return 2;
  }
  let report: RunReport;
  try {
    report = validateRunReport(doc);
  } catch (e) {
    err(sanitizeTerminalText((e as Error).message));
    return 2;
  }

  const color = flags.color ?? colorDefault(out);
  const kv = (k: string, v: string) => out(sanitizeTerminalText(`${k.padEnd(12)} ${v}`));
  out(renderHeaderLine("RUN REPORT", p, color));
  kv("task", `${report.task.id} — ${report.task.title}`);
  kv("status", report.status);
  kv("branch", report.branch);
  kv("window", `${report.startedAt} → ${report.finishedAt}`);
  kv(
    "policy",
    report.policy.changedPathsOk
      ? `${report.policy.changedPaths.length} changed paths, all inside allowed_paths`
      : `VIOLATIONS: ${report.policy.violations.join(", ")}`,
  );
  if (report.tests) {
    const t = report.tests;
    kv("tests", `${t.ok ? "ok" : "FAILED"} (${t.passed ?? "?"} passed, ${t.failed ?? "?"} failed of ${t.total ?? "?"} total, ${t.command})`);
  }
  kv("deliverables", [
    report.deliverables.pullRequest ? `PR ${report.deliverables.pullRequest}` : null,
    report.deliverables.sessionId ? `session ${report.deliverables.sessionId}` : null,
    ...report.deliverables.artifacts,
  ]
    .filter(Boolean)
    .join("  ") || "·");

  // Event stream (the evidence), read-only.
  const events: AnyHarnessEvent[] = report.events.map((wire) => deserializeEvent(wire));
  out("");
  out(renderSession(`EVENT STREAM (${events.length})`, events, { color }));
  return 0;
}

export const HELP = `harness-view — harness session viewer and interactive ACP client

Usage:
  harness-view connect <ws-url> --workspace <path> [--task id]
                       [--model name] [--token value] [prompt words...]
  harness-view list [db]                 list stored sessions
  harness-view show [db] [--session id]  show a session's event stream
                                        [--from N] [--limit N] [--raw]
  harness-view report <report.json>      show a run report + its events
  harness-view help

Defaults:
  db      tasks/runs/sessions.sqlite (relative to cwd)
  session the most recently created one

Set HARNESS_AGENT_TOKEN instead of --token to keep credentials out of shell
history. Non-loopback connections require wss://.`;

export async function runView(argv: string[], ctx: ViewContext = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "help" || cmd === "--help" || cmd === undefined) {
    (ctx.out ?? console.log)(HELP);
    return cmd === undefined ? 1 : 0;
  }
  const { positional, flags } = parseFlags(rest);
  try {
    if (cmd === "list") return await cmdList(ctx, positional[0], flags);
    if (cmd === "show") return await cmdShow(ctx, positional[0], flags);
    if (cmd === "report") {
      const target = positional[0];
      if (!target) {
        (ctx.err ?? console.error)("harness-view: report needs a path");
        return 1;
      }
      return cmdReport(ctx, target, flags);
    }
  } catch (e) {
    if (e instanceof SessionStoreError) {
      (ctx.err ?? console.error)(`harness-view: ${sanitizeTerminalText(e.message)}`);
      return 2;
    }
    throw e;
  }
  (ctx.err ?? console.error)(`harness-view: unknown command "${sanitizeTerminalText(cmd)}"\n`);
  (ctx.out ?? console.log)(HELP);
  return 1;
}

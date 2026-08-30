import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent } from "@harness/events";
import { openSqliteSession } from "@harness/sessions";
import { RUN_REPORT_SCHEMA } from "@harness/sdk";
import { eventSummary, renderEventLine, renderSession } from "../src/render";
import { runView } from "../src/view";

const EVTS = [
  createEvent("session.created", { sessionId: "sess-1" }, {
    at: "2026-01-01T00:00:00.000Z",
    actor: "kernel",
  }),
  createEvent("agent.started", { agentId: "a", sessionId: "sess-1", taskId: "kernel-0001", model: "fake-model/v1" }, {
    at: "2026-01-01T00:00:01.000Z",
    actor: "kernel",
  }),
  createEvent("model.response", { requestId: "r", model: "fake-model/v1", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }, {
    at: "2026-01-01T00:00:02.000Z",
    actor: "kernel",
  }),
  createEvent("agent.stopped", { agentId: "a", status: "completed", steps: 1, toolCalls: 0 }, {
    at: "2026-01-01T00:00:03.000Z",
    actor: "kernel",
  }),
];

describe("render (pure)", () => {
  it("summarizes each event type", () => {
    expect(eventSummary(EVTS[0]!)).toContain("session=sess-1");
    expect(eventSummary(EVTS[1]!)).toContain("task=kernel-0001");
    expect(eventSummary(EVTS[2]!)).toContain("finish=stop");
    expect(eventSummary(EVTS[3]!)).toContain("completed");
  });

  it("renders a stable 4-column row without color", () => {
    const out = renderEventLine(0, EVTS[0]!, { color: false });
    expect(out).toBe("0    2026-01-01 00:00:00.000  session.created   session=sess-1");
  });

  it("renders a session with header, rows in order, and a footer", () => {
    const out = renderSession("SESSION sess-1", EVTS, { color: false });
    const lines = out.split("\n");
    expect(lines[0]).toBe("SESSION sess-1");
    for (let i = 0; i < EVTS.length; i++) {
      expect(lines[i + 2]).toContain(String(i) + " ");
      expect(lines[i + 2]).toContain(EVTS[i]!.type);
    }
    expect(lines[lines.length - 1]).toBe("── 4 events");
  });

  it("applies ANSI color only when asked", () => {
    const colored = renderEventLine(0, EVTS[3]!, { color: true });
    expect(colored).toContain("\u001b[");
    expect(renderEventLine(0, EVTS[3]!, { color: false })).not.toContain("\u001b[");
  });
});

async function seededDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-tui-"));
  const dbPath = join(dir, "runs", "sessions.sqlite");
  const s = openSqliteSession(dbPath, { taskId: "kernel-0001" });
  for (const e of EVTS) await s.log.append(e);
  s.close();
  return dbPath;
}

function capture(): {
  lines: string[];
  errs: string[];
  ctx: { cwd: string; out: (s: string) => void; err: (s: string) => void };
} {
  const lines: string[] = [];
  const errs: string[] = [];
  const ctx = {
    cwd: process.cwd(),
    out: (l: string) => lines.push(l),
    err: (l: string) => errs.push(l),
  };
  return { lines, errs, ctx };
}

describe("view commands", () => {
  it("lists sessions with their metadata", async () => {
    const dbPath = await seededDb();
    try {
      const { lines, ctx } = capture();
      const code = await runView(["list", dbPath, "--no-color"], ctx);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("task=kernel-0001");
      expect(lines.join("\n")).toContain("4 events");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("shows the newest session's event stream in order", async () => {
    const dbPath = await seededDb();
    try {
      const { lines, ctx } = capture();
      const code = await runView(["show", dbPath, "--no-color"], ctx);
      expect(code).toBe(0);
      const joined = lines.join("\n");
      const first = joined.indexOf("session.created");
      const last = joined.indexOf("agent.stopped");
      expect(first).toBeGreaterThan(-1);
      expect(last).toBeGreaterThan(first);
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("honors --from and --limit", async () => {
    const dbPath = await seededDb();
    try {
      const { lines, ctx } = capture();
      const code = await runView(
        ["show", dbPath, "--from", "1", "--limit", "1", "--no-color"],
        ctx,
      );
      expect(code).toBe(0);
      const joined = lines.join("\n");
      expect(joined).toContain("agent.started");
      expect(joined).not.toContain("session.created");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("--raw prints one JSON event per line", async () => {
    const dbPath = await seededDb();
    try {
      const { lines, ctx } = capture();
      const code = await runView(["show", dbPath, "--raw", "--limit", "2"], ctx);
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).type).toBe("session.created");
      expect(JSON.parse(lines[1]!).type).toBe("agent.started");
    } finally {
      rmSync(dbPath, { recursive: true, force: true });
    }
  });

  it("exits 2 with a typed message when the store is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-tui-"));
    try {
      const { ctx, errs } = capture();
      ctx.cwd = dir;
      const code = await runView(["list"], ctx);
      expect(code).toBe(2);
      expect(errs.join("\n")).toMatch(/no session store/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report view", () => {
  function fixture(status = "passed", extra = ""): [string, string] {
    const dir = mkdtempSync(join(tmpdir(), "harness-tui-"));
    const p = join(dir, "report.json");
    const events = [
      createEvent("task.updated", { taskId: "kernel-0001", phase: "running" }, { at: "2026-01-01T00:00:00.000Z" }),
      createEvent("run.recorded", { runId: "run-1", taskId: "kernel-0001", status: status as never, reportPath: p }, { at: "2026-01-01T00:00:01.000Z" }),
    ].map((e) => JSON.stringify(e));
    const doc = {
      schema: RUN_REPORT_SCHEMA,
      task: { id: "kernel-0001", title: "Add agent event serialization", path: "tasks/kernel-0001.yaml" },
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
      branch: "tasks/kernel-0001",
      policy: { changedPathsOk: status === "passed", changedPaths: ["packages/events/src/serialize.ts"], violations: status === "passed" ? [] : ["rogue.md"] },
      tests: { command: "pnpm test", exitCode: 0, ok: true, durationMs: 900, total: 12, passed: 12, failed: 0, outputTail: "" },
      events,
      deliverables: {
        pullRequest: "https://github.com/x/y/pull/1",
        artifacts: ["tasks/runs/sessions.sqlite"],
        reportPath: p,
        sessionId: "sess-9",
      },
    };
    writeFileSync(p, JSON.stringify(doc) + extra);
    return [dir, p];
  }

  it("renders report metadata and the decoded event stream", async () => {
    const [dir, p] = fixture();
    try {
      const { lines, ctx } = capture();
      ctx.cwd = dir;
      const code = await runView(["report", p, "--no-color"], ctx);
      expect(code).toBe(0);
      const joined = lines.join("\n");
      expect(joined).toContain("RUN REPORT");
      expect(joined).toContain("kernel-0001 — Add agent event serialization");
      expect(joined).toContain("passed");
      expect(joined).toContain("12 passed, 0 failed");
      expect(joined).toContain("PR https://github.com/x/y/pull/1");
      expect(joined).toContain("session sess-9");
      expect(joined).toContain("task.updated");
      expect(joined).toContain("run.recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 with a typed error on an invalid report", async () => {
    const [dir, p] = fixture("passed", " <-- not json");
    try {
      const { ctx, errs } = capture();
      ctx.cwd = dir;
      const code = await runView(["report", p], ctx);
      expect(code).toBe(2);
      expect(errs.join("\n")).toMatch(/cannot read report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("help/usage", () => {
  it("no command → help + exit 1; help → exit 0", async () => {
    const { lines, ctx } = capture();
    expect(await runView([], ctx)).toBe(1);
    expect(lines.join("\n")).toContain("harness-view");
    const c2 = capture();
    expect(await runView(["help"], c2.ctx)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RUN_REPORT_SCHEMA } from "@harness/sdk";
import { eventSatisfies, streamSatisfies, assertKnownEventTypes } from "./expect";
import { decodeScenario, ScenarioParseError } from "./scenario";
import { executeScenario } from "./execute";

const repoRoot = resolve(__dirname, "../..");

const GOLDEN = {
  id: "t-golden",
  uses_tasks: ["kernel-0001"],
  script: [{ content: "round-trips cleanly" }],
  expect: {
    run: { status: "completed", steps: 1, toolCalls: 0 },
    events: [
      { type: "session.created" },
      { type: "agent.started", "data.taskId": "kernel-0001" },
      { type: "agent.stopped", "data.status": "completed" },
    ],
  },
};

describe("scenario DSL", () => {
  it("accepts a well-formed scenario", () => {
    const s = decodeScenario(GOLDEN);
    expect(s.id).toBe("t-golden");
    expect(s.expect.events).toHaveLength(3);
  });

  it("rejects an unknown event type in an invariant with a typed error", () => {
    expect(() =>
      decodeScenario({
        ...GOLDEN,
        expect: { events: [{ type: "payload.exfiltrated" }] },
      }),
    ).toThrow(ScenarioParseError);
    expect(assertKnownEventTypes([{ type: "payload.exfiltrated" }])).toHaveLength(1);
  });

  it("rejects event-invariant keys that are not type or data.*", () => {
    expect(() =>
      decodeScenario({
        ...GOLDEN,
        expect: { events: [{ type: "agent.stopped", payload: "x" }] },
      }),
    ).toThrow(ScenarioParseError);
  });

  it("rejects a scenario with no invariants", () => {
    expect(() => decodeScenario({ ...GOLDEN, expect: {} })).toThrow(
      ScenarioParseError,
    );
  });
});

describe("event stream matching", () => {
  const stream = [
    { v: 1, type: "session.created", eventId: "1", at: "t", data: { sessionId: "s" } },
    {
      v: 1,
      type: "agent.stopped",
      eventId: "2",
      at: "t",
      data: { agentId: "a", status: "completed", steps: 3, toolCalls: 1 },
    },
  ] as unknown as Parameters<typeof eventSatisfies>[0][];

  it("matches type + dotted data paths", () => {
    expect(
      eventSatisfies(stream[0]!, { type: "session.created", "data.sessionId": "s" }),
    ).toBe(true);
    expect(
      eventSatisfies(stream[1]!, {
        type: "agent.stopped",
        "data.status": "completed",
        "data.steps": 3,
      }),
    ).toBe(true);
  });

  it("fails on a wrong data value and reports which invariant", () => {
    expect(eventSatisfies(stream[1]!, { type: "agent.stopped", "data.steps": 9 })).toBe(false);
    const failures = streamSatisfies(stream, [
      { type: "agent.stopped", "data.steps": 9 },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/steps/);
  });

  it("enforces ordering (subsequence, not bag)", () => {
    // agent.stopped before session.created is impossible in-order.
    const failures = streamSatisfies(stream, [
      { type: "agent.stopped" },
      { type: "session.created" },
    ]);
    expect(failures).toHaveLength(1);
  });
});

describe("golden kernel scenario (offline, deterministic)", () => {
  it("passes for kernel-0001 with a clean script", async () => {
    const scenario = decodeScenario(GOLDEN);
    const out = await executeScenario(
      { repoRoot },
      scenario,
      [join(repoRoot, "tasks", "kernel-0001.yaml")],
    );
    expect(out.ok).toBe(true);
    expect(out.goldenRun.status).toBe("completed");
    expect(out.goldenRun.toolCalls).toBe(0);
  });

  it("fails the run when invariants are not met (tool-call budget)", async () => {
    const scenario = decodeScenario({
      ...GOLDEN,
      expect: { run: { toolCalls: 5 } },
    });
    const out = await executeScenario(
      { repoRoot },
      scenario,
      [join(repoRoot, "tasks", "kernel-0001.yaml")],
    );
    expect(out.ok).toBe(false);
    expect(out.failures.some((f) => f.includes("toolCalls"))).toBe(true);
  });

  it("checks expect.report against a supplied run report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
    try {
      const reportPath = join(dir, "report.json");
      writeFileSync(
        reportPath,
        JSON.stringify({
          schema: RUN_REPORT_SCHEMA,
          task: { id: "kernel-0001", title: "x", path: "tasks/kernel-0001.yaml" },
          status: "passed",
          startedAt: "t",
          finishedAt: "t",
          branch: "tasks/kernel-0001",
          policy: { changedPathsOk: true, changedPaths: [], violations: [] },
          events: [],
          deliverables: { artifacts: [], reportPath: join(dir, "report.json") },
        }),
      );
      const scenario = decodeScenario({
        ...GOLDEN,
        expect: { ...GOLDEN.expect, report: { status: "passed" } },
      });
      const ok = await executeScenario(
        { repoRoot, reportPath },
        scenario,
        [join(repoRoot, "tasks", "kernel-0001.yaml")],
      );
      expect(ok.ok).toBe(true);

      // A failed report must fail the scenario:
      writeFileSync(
        reportPath,
        JSON.stringify({
          schema: RUN_REPORT_SCHEMA,
          task: { id: "kernel-0001", title: "x", path: "tasks/kernel-0001.yaml" },
          status: "failed",
          startedAt: "t",
          finishedAt: "t",
          branch: "tasks/kernel-0001",
          policy: { changedPathsOk: false, changedPaths: [], violations: ["x"] },
          events: [],
          deliverables: { artifacts: [], reportPath: join(dir, "report.json") },
        }),
      );
      const bad = await executeScenario(
        { repoRoot, reportPath },
        scenario,
        [join(repoRoot, "tasks", "kernel-0001.yaml")],
      );
      expect(bad.ok).toBe(false);
      expect(bad.failures[0]).toMatch(/report.status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

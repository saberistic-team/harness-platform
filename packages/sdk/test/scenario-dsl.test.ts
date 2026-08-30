import { describe, it, expect } from "vitest";
import {
  decodeScenario,
  loadScenario,
  toEventInvariant,
  ScenarioParseError,
  type Scenario,
} from "../src/index";

const GOLDEN_YAML = `
id: kernel-0001-golden
uses_tasks:
  - kernel-0001
script:
  - content: "round-trips cleanly"
expect:
  run:
    status: completed
    steps: 1
    toolCalls: 0
    textContains: round-trips
  events:
    - type: session.created
    - type: agent.started
      data.taskId: kernel-0001
      data.model: fake-model/v1
    - type: agent.stopped
      data.status: completed
      data.steps: 1
`;

describe("scenario DSL in @harness/sdk (M2: YAML -> invariants)", () => {
  it("decodes a well-formed YAML scenario into typed invariants", () => {
    const s: Scenario = loadScenario(GOLDEN_YAML);
    expect(s.id).toBe("kernel-0001-golden");
    expect(s.uses_tasks).toEqual(["kernel-0001"]);
    expect(s.script).toHaveLength(1);
    expect(s.expect.run?.status).toBe("completed");
    const invariants = (s.expect.events ?? []).map(toEventInvariant);
    expect(invariants[0]).toEqual({ type: "session.created", data: {} });
    expect(invariants[1]).toEqual({
      type: "agent.started",
      data: { taskId: "kernel-0001", model: "fake-model/v1" },
    });
  });

  it("decodes identical results from YAML text and pre-parsed docs", () => {
    const doc = {
      id: "kernel-0001-golden",
      uses_tasks: ["kernel-0001"],
      script: [{ content: "round-trips cleanly" }],
      expect: {
        run: {
          status: "completed",
          steps: 1,
          toolCalls: 0,
          textContains: "round-trips",
        },
        events: [
          { type: "session.created" },
          { type: "agent.started", "data.taskId": "kernel-0001", "data.model": "fake-model/v1" },
          { type: "agent.stopped", "data.status": "completed", "data.steps": 1 },
        ],
      },
    };
    expect(loadScenario(GOLDEN_YAML)).toEqual(decodeScenario(doc));
  });

  it("throws a typed ScenarioParseError for unknown event types", () => {
    const s = () =>
      loadScenario(
        [
          "id: bad",
          "uses_tasks: [kernel-0001]",
          "expect:",
          "  events:",
          "    - type: bogus.event",
        ].join("\n"),
      );
    expect(s).toThrowError(ScenarioParseError);
    try {
      s();
    } catch (err) {
      const e = err as ScenarioParseError;
      expect(e.issues.some((i) => i.path === "expect.events.0.type")).toBe(true);
      expect(e.message).toContain("unknown event type");
    }
  });

  it("throws a typed error for non data.* invariant keys", () => {
    expect(() =>
      loadScenario(
        [
          "id: bad",
          "uses_tasks: [t]",
          "expect:",
          "  events:",
          "    - type: agent.stopped",
          "      status: completed",
        ].join("\n"),
      ),
    ).toThrowError(/event invariant key must be "type" or "data\.<path>"/);
  });

  it("throws a typed error when expect declares no invariants", () => {
    expect(() =>
      loadScenario(["id: bad", "uses_tasks: [t]", "expect: {}"].join("\n")),
    ).toThrowError(/at least one invariant/);
  });

  it("throws a typed error for invalid YAML (not a silent fallback)", () => {
    expect(() => loadScenario("id: [unclosed")).toThrowError(
      ScenarioParseError,
    );
  });

  it("accepts the report invariant (exit-gate status)", () => {
    const s = loadScenario(
      ["id: gate", "uses_tasks: [t]", "expect:", "  report:", "    status: passed"].join(
        "\n",
      ),
    );
    expect(s.expect.report).toEqual({ status: "passed" });
  });
});

import { describe, expect, it } from "vitest";
import { FakeModel } from "@harness/models";
import { ToolRegistry, createEchoTool } from "@harness/tools";
import { runAgent, BudgetExceededError } from "../src";

const FIXED_AT = "2026-01-02T03:04:05.000Z";
const base = {
  goal: "do the thing",
  tools: new ToolRegistry([createEchoTool("echo", "echoed")]),
  now: () => FIXED_AT,
  newId: (p: string) => `${p}-${++idCounter}`,
  sessionId: "sess-fixed",
  taskId: "kernel-0001",
};

describe("runAgent", () => {
  it("runs a single turn to a final answer", async () => {
    const model = new FakeModel([{ content: "done" }]);
    const result = await runAgent({ ...base, model });

    expect(result.text).toBe("done");
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.events.map((e) => (e as any).type)).toEqual([
      "session.created",
      "agent.started",
      "model.request",
      "model.response",
      "agent.stopped",
    ]);
    // All events must be well-formed (schema-valid) at construction time;
    // round-trip through the wire format to be sure.
    for (const evt of result.events) {
      expect(evt.v).toBe(1);
      expect(typeof evt.eventId).toBe("string");
      expect(evt.at).toBe(FIXED_AT);
    }
  });

  it("executes a tool call, feeds the result back, then finalizes", async () => {
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { x: 1 } }],
      },
      { content: "final answer" },
    ]);
    const result = await runAgent({ ...base, model });

    expect(result.toolCalls).toBe(1);
    expect(result.text).toBe("final answer");
    const types = result.events.map((e) => (e as any).type);
    expect(types).toEqual([
      "session.created",
      "agent.started",
      "model.request",
      "model.response",
      "tool.call",
      "tool.result",
      "model.request",
      "model.response",
      "agent.stopped",
    ]);
    const toolResult = result.events.find(
      (e) => (e as any).type === "tool.result",
    ) as any;
    expect(toolResult.data.ok).toBe(true);
    expect(toolResult.data.output).toEqual({ echo: "echoed", received: { x: 1 } });

    // The result was fed back as a `tool` message:
    expect(model.requests[1]?.messages.at(-1)?.role).toBe("tool");
  });

  it("reports unknown tools as typed tool failures without crashing the run", async () => {
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "nope", arguments: {} }],
      },
      { content: "recovered" },
    ]);
    const result = await runAgent({ ...base, model, maxSteps: 4 });
    const toolResult = result.events.find((e) => (e as any).type === "tool.result") as any;
    expect(toolResult.data.ok).toBe(false);
    expect(toolResult.data.error.code).toBe("TOOL_NOT_FOUND");
    expect(result.text).toBe("recovered");
  });

  it("enforces the token budget: warns at 50%, hard-stops over limit", async () => {
    const usage = { promptTokens: 10, completionTokens: 0, totalTokens: 10 };
    const model = new FakeModel([
      { content: "a", usage: { ...usage } },
      { content: "b", usage: { ...usage } },
      { content: "c", usage: { ...usage } },
    ]);

    let caught: unknown;
    let emitted: string[] = [];
    try {
      await runAgent({
        ...base,
        model,
        budget: { maxModelTokens: 15 },
        onEvent: (e) => emitted.push((e as any).type),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BudgetExceededError);
    const budget = (caught as BudgetExceededError);
    expect(budget.metric).toBe("tokens");
    expect(budget.used).toBe(20);
    expect(budget.limit).toBe(15);

    // one at the 50% threshold (turn 1), and one at hard-stop (turn 2).
    // The run stopped before turn 3.
    const warnings = emitted.filter((t: string) => t === "budget.warning");
    expect(warnings).toHaveLength(2);
    expect(emitted).toContain("agent.stopped");
    expect(model.requests).toHaveLength(2);
  });

  it("enforces the tool-call budget", async () => {
    const model = new FakeModel([
      { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "echo", arguments: {} }] },
      { content: "" , toolCalls: [{ id: "c3", name: "echo", arguments: {} }] },
    ]);

    let caught: unknown;
    try {
      await runAgent({
        ...base,
        model,
        budget: { maxToolCalls: 2 },
        maxSteps: 6,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect((caught as BudgetExceededError).metric).toBe("tool_calls");
    expect((caught as BudgetExceededError).used).toBe(2);
  });

  it("stops at maxSteps without a final answer and records it", async () => {
    const toolLoop = [
      { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "echo", arguments: {} }] },
    ];
    const model = new FakeModel(toolLoop);
    const result = await runAgent({
      ...base,
      model,
      maxSteps: 2,
      sessionId: "sess-fixed",
    });
    expect(result.steps).toBe(2);
    const stopped = result.events.at(-1) as any;
    expect(stopped.type).toBe("agent.stopped");
    expect(stopped.data.status).toBe("failed");
    expect(stopped.data.note).toContain("max_steps=2");
  });
});

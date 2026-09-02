import { describe, expect, it } from "vitest";
import { FakeModel } from "@harness/models";
import {
  ToolRegistry,
  createBoundedTool,
  createEchoTool,
  createTool,
} from "@harness/tools";
import { z } from "zod";
import {
  runAgent,
  BudgetExceededError,
  RunCanceledError,
  type Workspace,
} from "../src";

const FIXED_AT = "2026-01-02T03:04:05.000Z";
let idCounter = 0;
const base = {
  goal: "do the thing",
  tools: new ToolRegistry([createEchoTool("echo", "echoed")]),
  now: () => FIXED_AT,
  newId: (p: string) => `${p}-${++idCounter}`,
  sessionId: "sess-fixed",
  taskId: "kernel-0001",
};

function fakeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    readFile: async () => "",
    writeFile: async () => undefined,
    listFiles: async () => [],
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    diff: async () => "",
    snapshot: async () => ({ id: "snapshot-1", createdAt: FIXED_AT }),
    dispose: async () => undefined,
    ...overrides,
  };
}

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
    expect(model.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "c1", name: "echo" }],
    });
  });

  it("accepts adapter-guarded arrays as plain bounded tool JSON", async () => {
    const argv = ["sed", "-n", "1,20p", "README.md"];
    Object.defineProperty(argv, "toJSON", {
      configurable: true,
      value: undefined,
    });
    const model = new FakeModel([
      {
        toolCalls: [{ id: "c1", name: "echo", arguments: { argv } }],
      },
      { content: "inspected" },
    ]);

    const result = await runAgent({ ...base, model });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(1);
    const call = result.events.find((event) => event.type === "tool.call");
    expect(call?.data.input).toEqual({ argv: ["sed", "-n", "1,20p", "README.md"] });
    const normalizedArgv = (call?.data.input as { argv: string[] }).argv;
    expect(Object.hasOwn(normalizedArgv, "toJSON")).toBe(false);
  });

  it("rejects executable or enumerable toJSON array properties", async () => {
    for (const enumerable of [false, true]) {
      let sideEffects = 0;
      const guarded = ["README.md"];
      Object.defineProperty(guarded, "toJSON", {
        configurable: true,
        enumerable,
        value: () => ["rewritten"],
      });
      const tools = new ToolRegistry([
        createTool({
          name: "danger",
          description: "must not run",
          parameters: z.any(),
          execute: () => { sideEffects++; return null; },
        }),
      ]);

      await expect(runAgent({
        ...base,
        tools,
        model: new FakeModel([{
          toolCalls: [{ id: "c1", name: "danger", arguments: { guarded } }],
        }]),
      })).rejects.toMatchObject({ name: "InvalidModelResponseError" });
      expect(sideEffects).toBe(0);
    }
  });

  it("keeps legacy workspace identity separate from its bound capability", async () => {
    let originalReads = 0;
    let redirectedReads = 0;
    let receivedWorkspace: Workspace | undefined;
    const workspaceCapability = fakeWorkspace({
      readFile: async (path) => {
        originalReads++;
        return `legacy:${path}`;
      },
    });
    const tools = new ToolRegistry([
      createBoundedTool({
        name: "workspace_read",
        description: "Read through the legacy run's injected capability",
        parameters: z.object({ path: z.string() }).strict(),
        authorization: (input) => ({
          action: "fs.read",
          subject: (input as { path: string }).path,
        }),
        execute: async ({ path }, context) => {
          receivedWorkspace = context?.workspace;
          if (!context?.workspace) throw new Error("workspace was not injected");
          return { content: await context.workspace.readFile(path) };
        },
      }, {
        kind: "workspace",
        access: "read",
        capability: "readFile",
        root: "/legacy/workspace",
      }),
    ]);
    const model = new FakeModel([
      {
        toolCalls: [{
          id: "legacy-workspace-call",
          name: "workspace_read",
          arguments: { path: "README.md" },
        }],
      },
      { content: "done" },
    ]);
    const running = runAgent({
      ...base,
      model,
      tools,
      workspace: "/legacy/workspace",
      workspaceCapability,
      permission: {
        decide: () => ({ effect: "allow", reason: "fixture allows read" }),
      },
    });

    workspaceCapability.readFile = async () => {
      redirectedReads++;
      return "redirected";
    };
    const result = await running;

    expect(result.events[0]).toMatchObject({
      type: "session.created",
      data: { workspace: "/legacy/workspace" },
    });
    expect(originalReads).toBe(1);
    expect(redirectedReads).toBe(0);
    expect(receivedWorkspace).toBeDefined();
    expect(receivedWorkspace).not.toBe(workspaceCapability);
    expect(result.events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: true, output: { content: "legacy:README.md" } });
  });

  it("does not leak the legacy workspace capability to a pure tool", async () => {
    let receivedWorkspace: Workspace | undefined;
    const tools = new ToolRegistry([
      createBoundedTool({
        name: "pure_probe",
        description: "Observe the pure execution context",
        parameters: z.object({}).strict(),
        execute: (_input, context) => {
          receivedWorkspace = context?.workspace;
          return { hasWorkspace: context?.workspace !== undefined };
        },
      }, { kind: "pure" }),
    ]);
    const result = await runAgent({
      ...base,
      tools,
      workspaceCapability: fakeWorkspace(),
      model: new FakeModel([
        { toolCalls: [{ id: "pure-probe", name: "pure_probe", arguments: {} }] },
        { content: "done" },
      ]),
    });

    expect(receivedWorkspace).toBeUndefined();
    expect(result.events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: true, output: { hasWorkspace: false } });
  });

  it("denies a legacy workspace tool when no permission controller is injected", async () => {
    let reads = 0;
    const tools = new ToolRegistry([
      createBoundedTool({
        name: "workspace_read",
        description: "Requires explicit policy",
        parameters: z.object({ path: z.string() }).strict(),
        authorization: (input) => ({
          action: "fs.read",
          subject: (input as { path: string }).path,
        }),
        execute: async ({ path }, context) => context?.workspace?.readFile(path),
      }, {
        kind: "workspace",
        access: "read",
        capability: "readFile",
        root: "/legacy/workspace",
      }),
    ]);
    const result = await runAgent({
      ...base,
      tools,
      workspaceCapability: fakeWorkspace({
        readFile: async () => { reads++; return "must not read"; },
      }),
      model: new FakeModel([
        {
          toolCalls: [{
            id: "legacy-no-policy",
            name: "workspace_read",
            arguments: { path: "README.md" },
          }],
        },
        { content: "recovered" },
      ]),
    });

    expect(reads).toBe(0);
    expect(result.events.find((event) => event.type === "policy.decision")?.data)
      .toMatchObject({
        effect: "deny",
        ruleId: "kernel.m8.permission_required",
      });
    expect(result.events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({
        ok: false,
        error: { code: "TOOL_PERMISSION_REQUIRED" },
      });
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

  it("turns non-JSON tool results into an audited failure without breaking the run", async () => {
    const tools = new ToolRegistry([
      createTool({
        name: "bigint",
        description: "returns an invalid JSON value",
        parameters: z.object({}),
        execute: () => 1n,
      }),
    ]);
    const result = await runAgent({
      ...base,
      tools,
      model: new FakeModel([
        { toolCalls: [{ id: "c1", name: "bigint", arguments: {} }] },
        { content: "recovered" },
      ]),
    });
    expect(result.status).toBe("completed");
    const toolResult = result.events.find((event) => event.type === "tool.result");
    expect(toolResult?.data).toMatchObject({
      ok: false,
      error: { code: "TOOL_INVALID_RESULT" },
    });
    expect(result.events.at(-1)?.type).toBe("agent.stopped");
  });

  it("rejects non-JSON model tool arguments before any tool side effect", async () => {
    let sideEffects = 0;
    const tools = new ToolRegistry([
      createTool({
        name: "danger",
        description: "must not run",
        parameters: z.any(),
        execute: () => { sideEffects++; return null; },
      }),
    ]);
    const emitted: import("@harness/events").AnyHarnessEvent[] = [];
    await expect(runAgent({
      ...base,
      tools,
      model: {
        name: "invalid-arguments-model",
        complete: async () => ({
          id: "invalid-1",
          content: "",
          toolCalls: [{ id: "c1", name: "danger", arguments: 1n }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls" as const,
        }),
      },
      onEvent: (event) => emitted.push(event),
    })).rejects.toMatchObject({ name: "InvalidModelResponseError" });
    expect(sideEffects).toBe(0);
    expect(emitted.slice(-2).map((event) => event.type)).toEqual([
      "error",
      "agent.stopped",
    ]);
  });

  it("bounds aggregate tool arguments and tool-call identifiers before execution", async () => {
    let sideEffects = 0;
    const tools = new ToolRegistry([
      createTool({
        name: "danger",
        description: "must not run for oversized input",
        parameters: z.any(),
        execute: () => { sideEffects++; return null; },
      }),
    ]);
    const large = "x".repeat(240 * 1024);
    await expect(runAgent({
      ...base,
      tools,
      model: new FakeModel([{
        toolCalls: Array.from({ length: 18 }, (_unused, index) => ({
          id: `large-${index}`,
          name: "danger",
          arguments: { large },
        })),
      }]),
    })).rejects.toMatchObject({ name: "InvalidModelResponseError" });
    expect(sideEffects).toBe(0);

    await expect(runAgent({
      ...base,
      tools,
      model: new FakeModel([{
        toolCalls: [{
          id: "call-id",
          name: "x".repeat(257),
          arguments: {},
        }],
      }]),
    })).rejects.toMatchObject({ name: "InvalidModelResponseError" });
    expect(sideEffects).toBe(0);
  });

  it("enforces the token budget: warns at 50%, hard-stops over limit", async () => {
    const usage = { promptTokens: 10, completionTokens: 0, totalTokens: 10 };
    const model = new FakeModel([
      // Turn 1: a tool-call turn (so the loop continues), 10/15 = 66% → warning.
      { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage: { ...usage } },
      // Turn 2: another 10 tokens → 20 > 15 → budget exceeded.
      { content: "", toolCalls: [{ id: "c2", name: "echo", arguments: {} }], usage: { ...usage } },
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

  it("does not issue another provider request after exactly exhausting the token budget", async () => {
    const model = new FakeModel([
      {
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
        usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      },
      { content: "must not be requested" },
    ]);

    await expect(runAgent({
      ...base,
      model,
      budget: { maxModelTokens: 5 },
    })).rejects.toMatchObject({ metric: "tokens", used: 5, limit: 5 });
    expect(model.requests).toHaveLength(1);
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
    expect(result.status).toBe("failed");
    const stopped = result.events.at(-1) as any;
    expect(stopped.type).toBe("agent.stopped");
    expect(stopped.data.status).toBe("failed");
    expect(stopped.data.note).toContain("max_steps=2");
  });

  it("rejects error and inconsistent finish reasons and marks length truncation failed", async () => {
    await expect(runAgent({
      ...base,
      model: new FakeModel([{ content: "provider failed", finishReason: "error" }]),
    })).rejects.toBeInstanceOf(Error);

    await expect(runAgent({
      ...base,
      model: new FakeModel([{
        content: "not a valid stop",
        finishReason: "stop",
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
      }]),
    })).rejects.toBeInstanceOf(Error);

    const truncated = await runAgent({
      ...base,
      model: new FakeModel([{ content: "partial", finishReason: "length" }]),
    });
    expect(truncated).toMatchObject({ status: "failed", text: "partial" });
    expect(truncated.events.slice(-2).map((event) => event.type)).toEqual([
      "error",
      "agent.stopped",
    ]);

    await expect(runAgent({
      ...base,
      model: new FakeModel([{ content: "x".repeat(600 * 1024) }]),
    })).rejects.toMatchObject({ name: "InvalidModelResponseError" });
  });

  it("pauses an ask before side effects and resumes only after explicit allow", async () => {
    let sideEffects = 0;
    let resolvePermission!: (value: "allow" | "deny") => void;
    const waiting = new Promise<"allow" | "deny">((resolve) => { resolvePermission = resolve; });
    const tools = new ToolRegistry([
      createTool({
        name: "danger",
        description: "side effect",
        parameters: z.object({ command: z.string() }),
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        authorization: (params) => ({
          action: "process.exec",
          subject: (params as { command: string }).command,
          scope: "once",
        }),
        execute: () => { sideEffects++; return "ok"; },
      }),
    ]);
    const model = new FakeModel([
      { toolCalls: [{ id: "p1", name: "danger", arguments: { command: "pnpm test" } }] },
      { content: "approved" },
    ]);
    const running = runAgent({
      ...base,
      model,
      tools,
      permission: {
        decide: () => ({ effect: "ask", reason: "operator required" }),
        resolve: () => waiting,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sideEffects).toBe(0);
    resolvePermission("allow");
    const result = await running;
    expect(sideEffects).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.created",
      "agent.started",
      "model.request",
      "model.response",
      "tool.call",
      "policy.decision",
      "permission.requested",
      "permission.resolved",
      "tool.result",
      "model.request",
      "model.response",
      "agent.stopped",
    ]);
  });

  it("awaits durable event publication before crossing a tool boundary", async () => {
    let sideEffects = 0;
    const tools = new ToolRegistry([
      createTool({
        name: "danger",
        description: "side effect",
        parameters: z.object({}),
        authorization: () => ({
          action: "process.exec",
          subject: "pnpm test",
          scope: "once",
        }),
        execute: () => { sideEffects++; return "should not run"; },
      }),
    ]);

    await expect(runAgent({
      ...base,
      tools,
      model: new FakeModel([{
        toolCalls: [{ id: "durable-1", name: "danger", arguments: {} }],
      }]),
      permission: {
        decide: () => ({ effect: "allow", reason: "test" }),
      },
      onEvent: async (event) => {
        if (event.type === "policy.decision") {
          throw new Error("journal unavailable");
        }
      },
    })).rejects.toThrow("journal unavailable");
    expect(sideEffects).toBe(0);
  });

  it("reuses an approved run-scoped grant for the same action and subject", async () => {
    let resolutions = 0;
    let sideEffects = 0;
    const tools = new ToolRegistry([
      createTool({
        name: "run_scoped",
        description: "run-scoped side effect",
        parameters: z.object({}),
        authorization: () => ({
          action: "process.exec",
          subject: "pnpm test",
          scope: "run",
        }),
        execute: () => { sideEffects++; return "ok"; },
      }),
    ]);
    const model = new FakeModel([
      {
        toolCalls: [
          { id: "p1", name: "run_scoped", arguments: {} },
          { id: "p2", name: "run_scoped", arguments: {} },
        ],
      },
      { content: "done" },
    ]);
    const result = await runAgent({
      ...base,
      model,
      tools,
      permission: {
        decide: () => ({ effect: "ask", reason: "operator required" }),
        resolve: async () => { resolutions++; return "allow"; },
      },
    });

    expect(resolutions).toBe(1);
    expect(sideEffects).toBe(2);
    expect(result.events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "permission.resolved")).toHaveLength(1);
  });

  it("resolves a pending ask as denied before recording cancellation", async () => {
    const abort = new AbortController();
    const emitted: import("@harness/events").AnyHarnessEvent[] = [];
    const tools = new ToolRegistry([
      createTool({
        name: "pending",
        description: "waits for permission",
        parameters: z.object({}),
        authorization: () => ({ action: "network", scope: "once" }),
        execute: () => "must not execute",
      }),
    ]);
    const model = new FakeModel([
      { toolCalls: [{ id: "p1", name: "pending", arguments: {} }] },
    ]);
    const running = runAgent({
      ...base,
      model,
      tools,
      signal: abort.signal,
      onEvent: (event) => emitted.push(event),
      permission: {
        decide: () => ({ effect: "ask", reason: "operator required" }),
        resolve: () => new Promise(() => undefined),
      },
    });
    while (!emitted.some((event) => event.type === "permission.requested")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    abort.abort();

    await expect(running).rejects.toBeInstanceOf(RunCanceledError);
    expect(emitted.slice(-4).map((event) => event.type)).toEqual([
      "permission.requested",
      "permission.resolved",
      "tool.result",
      "agent.stopped",
    ]);
    const resolved = emitted.find((event) => event.type === "permission.resolved");
    expect(resolved?.data).toMatchObject({ decision: "deny", note: expect.stringContaining("canceled") });
  });

  it("passes cancellation to a cooperative tool and records its terminal trail", async () => {
    const abort = new AbortController();
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => { started = resolve; });
    const emitted: import("@harness/events").AnyHarnessEvent[] = [];
    const tools = new ToolRegistry([
      createTool({
        name: "cooperative",
        description: "cooperative long-running tool",
        parameters: z.object({}),
        execute: (_params, context) => new Promise((_resolve, reject) => {
          started();
          context?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
      }),
    ]);
    const running = runAgent({
      ...base,
      model: new FakeModel([{
        toolCalls: [{ id: "c1", name: "cooperative", arguments: {} }],
      }]),
      tools,
      signal: abort.signal,
      onEvent: (event) => emitted.push(event),
    });
    await toolStarted;
    abort.abort();

    await expect(running).rejects.toBeInstanceOf(RunCanceledError);
    expect(emitted.slice(-2).map((event) => event.type)).toEqual([
      "tool.result",
      "agent.stopped",
    ]);
    const result = emitted.find((event) => event.type === "tool.result");
    expect(result?.data).toMatchObject({
      ok: false,
      error: { code: "TOOL_CANCELED" },
    });
  });

  it("fails closed when ask has no resolver and when policy denies", async () => {
    let sideEffects = 0;
    const tools = new ToolRegistry([
      createTool({
        name: "danger",
        description: "side effect",
        parameters: z.object({}),
        authorization: () => ({ action: "network", subject: "example.test" }),
        execute: () => { sideEffects++; return "bad"; },
      }),
    ]);
    for (const effect of ["ask", "deny"] as const) {
      const model = new FakeModel([
        { toolCalls: [{ id: `p-${effect}`, name: "danger", arguments: {} }] },
        { content: "continued" },
      ]);
      const result = await runAgent({
        ...base,
        model,
        tools,
        permission: { decide: () => ({ effect, reason: `${effect} rule` }) },
      });
      const toolResult = result.events.find((event) => event.type === "tool.result");
      expect(toolResult?.data.ok).toBe(false);
      if (toolResult?.type === "tool.result") {
        expect(toolResult.data.error?.code).toBe(
          effect === "ask" ? "TOOL_PERMISSION_DENIED" : "TOOL_POLICY_DENIED",
        );
      }
    }
    expect(sideEffects).toBe(0);
  });

  it("turns authorization callback failures into a terminally complete tool result", async () => {
    const tools = new ToolRegistry([
      createTool({
        name: "broken_auth",
        description: "throws during authorization",
        parameters: z.object({}),
        authorization: () => { throw new Error("sensitive authorization failure"); },
        execute: () => "must not execute",
      }),
    ]);
    const result = await runAgent({
      ...base,
      tools,
      permission: { decide: () => ({ effect: "allow", reason: "allow" }) },
      model: new FakeModel([
        { toolCalls: [{ id: "c1", name: "broken_auth", arguments: {} }] },
        { content: "recovered" },
      ]),
    });
    expect(result.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "error",
      "tool.result",
      "agent.stopped",
    ]));
    const toolResult = result.events.find((event) => event.type === "tool.result");
    expect(toolResult?.data).toMatchObject({
      ok: false,
      error: { code: "TOOL_AUTHORIZATION_FAILED" },
    });
    expect(JSON.stringify(result.events)).not.toContain("sensitive authorization failure");
  });

  it("aggregates provider usage and emits a terminal trail on model failure", async () => {
    const model = new FakeModel([
      {
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      },
      {
        content: "done",
        usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
      },
    ]);
    const result = await runAgent({ ...base, model });
    expect(result.usage).toEqual({ promptTokens: 8, completionTokens: 10, totalTokens: 18 });

    const broken = {
      name: "broken-model",
      complete: async () => { throw Object.assign(new Error("secret provider body"), { code: "MODEL_TIMEOUT", retryable: true }); },
    };
    await expect(runAgent({ ...base, model: broken })).rejects.toThrow("secret provider body");
    const emitted: import("@harness/events").AnyHarnessEvent[] = [];
    await runAgent({ ...base, model: broken, onEvent: (event) => emitted.push(event) }).catch(() => undefined);
    expect(emitted.slice(-3).map((event) => event.type)).toEqual([
      "model.response",
      "error",
      "agent.stopped",
    ]);
    const error = emitted.find((event) => event.type === "error");
    expect(error?.data.message).not.toContain("secret provider body");
  });

  it("fails before aggregate token accounting exceeds safe integers", async () => {
    const hugeUsage = {
      promptTokens: 3_000_000_000_000_000,
      completionTokens: 3_000_000_000_000_000,
      totalTokens: 6_000_000_000_000_000,
    };
    const model = new FakeModel([
      {
        toolCalls: [{ id: "c1", name: "echo", arguments: {} }],
        usage: hugeUsage,
      },
      { content: "unsafe total", usage: hugeUsage },
    ]);
    await expect(runAgent({ ...base, model })).rejects.toMatchObject({
      name: "InvalidModelResponseError",
    });
    expect(model.requests).toHaveLength(2);
  });
});

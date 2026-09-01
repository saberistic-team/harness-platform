import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  EventStore,
  PermissionController,
  RunInput,
} from "../src";
import {
  EventAppendError,
  InvalidRunInputError,
  MinimalAgentRuntime,
  ModelStreamError,
  ModelTimeoutError,
  RunAlreadyExistsError,
  RunNotFoundError,
  RunTerminalError,
  RuntimeBudgetExceededError,
  RuntimeConsumerError,
  SteeringClosedError,
} from "../src";
import {
  FakeModel,
  adaptModel,
  type CompletionResponse,
  type Model,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "@harness/models";
import { createBoundedTool, ToolRegistry } from "@harness/tools";
import { z } from "zod";

const FIXED_AT = "2026-01-02T03:04:05.000Z";

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class RecordingEventStore implements EventStore {
  readonly events: AgentEvent[] = [];
  readonly appendStarted = gate();
  private readonly blockRelease = gate();

  constructor(
    private readonly options: {
      blockType?: AgentEvent["type"];
      failType?: AgentEvent["type"];
    } = {},
  ) {}

  releaseBlockedAppend(): void {
    this.blockRelease.release();
  }

  async append(event: AgentEvent): Promise<void> {
    if (event.type === this.options.blockType) {
      this.appendStarted.release();
      await this.blockRelease.promise;
    }
    if (event.type === this.options.failType) {
      throw new Error(`rejected ${event.type}`);
    }
    this.events.push(event);
  }

  async *readSession(sessionId: string): AsyncIterable<AgentEvent> {
    for (const event of this.events) {
      const data = event.data as { sessionId?: string };
      if (data.sessionId === sessionId) yield event;
    }
  }
}

class PullCountingAdapter implements ModelAdapter {
  pulls = 0;
  returns = 0;
  signal?: AbortSignal;
  readonly requests: ModelRequest[] = [];
  private readonly events: ModelEvent[];

  constructor(content = "ab") {
    this.events = [
      { type: "text.delta", delta: content.slice(0, 1) },
      { type: "text.delta", delta: content.slice(1) },
      {
        type: "response.completed",
        response: response(content),
      },
    ];
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.signal = request.signal;
    let index = 0;
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
        return {
          async next() {
            self.pulls++;
            const value = self.events[index++];
            return value === undefined
              ? { done: true, value: undefined }
              : { done: false, value };
          },
          async return() {
            self.returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

class HangingAdapter implements ModelAdapter {
  pulls = 0;
  returns = 0;
  signal?: AbortSignal;
  readonly pulled = gate();

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.signal = request.signal;
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
        return {
          next() {
            self.pulls++;
            self.pulled.release();
            return new Promise<IteratorResult<ModelEvent>>(() => undefined);
          },
          async return() {
            self.returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
}

class TerminalThenHangingAdapter implements ModelAdapter {
  pulls = 0;
  returns = 0;

  stream(): AsyncIterable<ModelEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
        return {
          next() {
            self.pulls++;
            if (self.pulls === 1) {
              return Promise.resolve({
                done: false,
                value: { type: "response.completed", response: response("done") },
              });
            }
            return new Promise<IteratorResult<ModelEvent>>(() => undefined);
          },
          return() {
            self.returns++;
            return new Promise<IteratorResult<ModelEvent>>(() => undefined);
          },
        };
      },
    };
  }
}

function response(content: string): CompletionResponse {
  return {
    id: "provider-response-1",
    content,
    toolCalls: [],
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    finishReason: "stop",
  };
}

function makeInput(
  modelAdapter: ModelAdapter,
  eventStore: EventStore,
  overrides: Partial<RunInput> = {},
): RunInput {
  let id = 0;
  return {
    runId: "run-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    input: "say hello",
    model: "fake-model/v1",
    modelAdapter,
    eventStore,
    now: () => FIXED_AT,
    newId: (prefix) => `${prefix}-${++id}`,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function collectOutcome(events: AsyncIterable<AgentEvent>): Promise<{
  events: AgentEvent[];
  error?: unknown;
}> {
  const collected: AgentEvent[] = [];
  try {
    for await (const event of events) collected.push(event);
    return { events: collected };
  } catch (error) {
    return { events: collected, error };
  }
}

function expectOneTerminalOutcome(
  events: readonly AgentEvent[],
  status: "completed" | "failed" | "canceled" | "budget_exceeded",
): void {
  const completed = events.filter((event) => event.type === "turn.completed");
  const stopped = events.filter((event) => event.type === "agent.stopped");
  expect(completed).toHaveLength(1);
  expect(stopped).toHaveLength(1);
  expect(completed[0]?.data).toMatchObject({ status });
  expect(stopped[0]?.data).toMatchObject({ status });
  expect(events.indexOf(completed[0]!)).toBeLessThan(events.indexOf(stopped[0]!));
}

describe("MinimalAgentRuntime", () => {
  it("persists and streams one deterministic text turn in the exact canonical order", async () => {
    const store = new RecordingEventStore();
    const model = new FakeModel([
      { content: "hello", textDeltas: ["he", "llo"] },
    ]);
    const runtime = new MinimalAgentRuntime();
    const yielded: AgentEvent[] = [];

    for await (const event of runtime.run(makeInput(model, store))) {
      expect(store.events).toContain(event);
      yielded.push(event);
    }

    expect(yielded.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "model.request",
      "message.delta",
      "message.delta",
      "model.response",
      "message.completed",
      "turn.completed",
      "agent.stopped",
    ]);
    expect(yielded[0]?.data).toMatchObject({
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
    });
    expect(yielded[2]?.data).toMatchObject({ role: "user", content: "say hello" });
    expect(yielded[4]?.data).toMatchObject({ sequence: 0, delta: "he" });
    expect(yielded[5]?.data).toMatchObject({ sequence: 1, delta: "llo" });
    expect(yielded[7]?.data).toMatchObject({ role: "assistant", content: "hello" });
    expect(yielded.at(-2)?.data).toMatchObject({
      status: "completed",
      modelRequests: 1,
      toolCalls: 0,
    });
    expect(yielded.at(-1)).toMatchObject({
      type: "agent.stopped",
      data: { status: "completed", steps: 1, toolCalls: 0 },
    });
    expect(store.events).toEqual(yielded);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages).toEqual([
      { role: "user", content: "say hello" },
    ]);
  });

  it("adapts a legacy completion model without fabricating text deltas", async () => {
    const store = new RecordingEventStore();
    const legacy: Model = {
      name: "legacy/v1",
      complete: async () => response("legacy answer"),
    };
    const events = await collect(new MinimalAgentRuntime().run(
      makeInput(adaptModel(legacy), store, { model: legacy.name }),
    ));

    expect(events.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "model.request",
      "model.response",
      "message.completed",
      "turn.completed",
      "agent.stopped",
    ]);
    expect(events.find((event) => event.type === "message.completed" && event.data.role === "assistant")?.data)
      .toMatchObject({ content: "legacy answer", finishReason: "stop" });
  });

  it("does not deliver or cross the model boundary until model.request is durable and consumed", async () => {
    const store = new RecordingEventStore({ blockType: "model.request" });
    const model = new FakeModel([{ content: "ok" }]);
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "agent.started" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "turn.started" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "message.completed" } });
    const pendingRequest = iterator.next();
    await store.appendStarted.promise;
    let delivered = false;
    void pendingRequest.then(() => { delivered = true; });
    await Promise.resolve();

    expect(delivered).toBe(false);
    expect(model.requests).toHaveLength(0);
    store.releaseBlockedAppend();
    await expect(pendingRequest).resolves.toMatchObject({ value: { type: "model.request" } });
    expect(model.requests).toHaveLength(0);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "message.delta" } });
    expect(model.requests).toHaveLength(1);
    while (!(await iterator.next()).done) {
      // Drain the remaining deterministic turn.
    }
  });

  it("fails closed before model invocation when model.request append fails", async () => {
    const store = new RecordingEventStore({ failType: "model.request" });
    const model = new FakeModel([{ content: "must not run" }]);
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "RUNTIME_EVENT_APPEND_FAILED",
      eventType: "model.request",
    });
    expect(model.requests).toHaveLength(0);
    expect(store.events.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
    ]);
  });

  it("pulls at most one model event per consumer advance", async () => {
    const store = new RecordingEventStore();
    const model = new PullCountingAdapter();
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next(); // agent.started
    await iterator.next(); // turn.started
    await iterator.next(); // user message
    await iterator.next(); // model.request
    expect(model.pulls).toBe(0);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "message.delta" } });
    expect(model.pulls).toBe(1);
    await Promise.resolve();
    expect(model.pulls).toBe(1);

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "message.delta" } });
    expect(model.pulls).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "model.response" } });
    expect(model.pulls).toBe(3);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "message.completed" } });
    expect(model.pulls).toBe(3);
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "turn.completed" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "agent.stopped" } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(model.returns).toBe(1);
  });

  it("treats response.completed as terminal even when another provider pull would hang", async () => {
    const store = new RecordingEventStore();
    const model = new TerminalThenHangingAdapter();
    const events = await collect(new MinimalAgentRuntime().run(makeInput(model, store)));

    expect(events.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "model.request",
      "model.response",
      "message.completed",
      "turn.completed",
      "agent.stopped",
    ]);
    expect(model.pulls).toBe(1);
    expect(model.returns).toBe(1);
  });

  it("stops pulling and closes the model iterator after a delta append failure", async () => {
    const store = new RecordingEventStore({ failType: "message.delta" });
    const model = new PullCountingAdapter();
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).rejects.toBeInstanceOf(EventAppendError);
    await Promise.resolve();

    expect(model.pulls).toBe(1);
    expect(model.returns).toBe(1);
    expect(store.events.some((event) => event.type === "message.delta")).toBe(false);
  });

  it("durably queues early steering and includes it in the first linearized model request", async () => {
    const store = new RecordingEventStore();
    const model = new FakeModel([{ content: "ok" }]);
    const runtime = new MinimalAgentRuntime();
    const stream = runtime.run(makeInput(model, store));

    await runtime.steer("run-1", "also inspect tests");
    expect(store.events.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "steering.queued",
    ]);

    const events = await collect(stream);
    expect(events.map(({ type }) => type).slice(0, 5)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "steering.queued",
      "model.request",
    ]);
    expect(model.requests[0]?.messages).toEqual([
      { role: "user", content: "say hello" },
      { role: "user", content: "also inspect tests" },
    ]);
  });

  it("rejects steering after the sole M6 request boundary instead of silently orphaning it", async () => {
    const store = new RecordingEventStore();
    const runtime = new MinimalAgentRuntime();
    const iterator = runtime.run(
      makeInput(new HangingAdapter(), store),
    )[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "model.request" } });
    await expect(runtime.steer("run-1", "too late")).rejects.toBeInstanceOf(SteeringClosedError);
    expect(store.events.some((event) => event.type === "steering.queued")).toBe(false);
    await iterator.return!();
  });

  it("settles pre-consumption steering when admission fails", async () => {
    const runtime = new MinimalAgentRuntime();
    const stream = runtime.run(makeInput(
      new FakeModel([{ content: "unused" }]),
      new RecordingEventStore(),
      { newId: () => "" },
    ));

    await expect(runtime.steer("run-1", "must not hang")).rejects.toBeInstanceOf(
      InvalidRunInputError,
    );
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
      InvalidRunInputError,
    );
  });

  it("coalesces cancellation, aborts an uncooperative model wait, and emits one terminal event", async () => {
    const store = new RecordingEventStore();
    const model = new HangingAdapter();
    const runtime = new MinimalAgentRuntime();
    const iterator = runtime.run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    const pendingModel = iterator.next();
    await model.pulled.promise;
    await Promise.all([runtime.cancel("run-1"), runtime.cancel("run-1")]);

    await expect(pendingModel).resolves.toMatchObject({
      value: { type: "turn.completed", data: { status: "canceled" } },
    });
    expect(model.signal?.aborted).toBe(true);
    expect(store.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(store.events.filter((event) => event.type === "agent.stopped")).toHaveLength(1);
    await expect(runtime.cancel("run-1")).resolves.toBeUndefined();
  });

  it("treats iterator return as cancellation and persists the unseen terminal event", async () => {
    const store = new RecordingEventStore();
    const model = new FakeModel([{ content: "must not run" }]);
    const runtime = new MinimalAgentRuntime();
    const iterator = runtime.run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "model.request" } });
    await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });

    expect(model.requests).toHaveLength(0);
    expect(store.events.at(-2)).toMatchObject({
      type: "turn.completed",
      data: { status: "canceled" },
    });
    expect(store.events.at(-1)).toMatchObject({
      type: "agent.stopped",
      data: { status: "canceled" },
    });
  });

  it("propagates a failed durable cancellation through cancel() and iterator return()", async () => {
    const cancelStore = new RecordingEventStore({ failType: "turn.completed" });
    const cancelModel = new HangingAdapter();
    const cancelRuntime = new MinimalAgentRuntime();
    const cancelIterator = cancelRuntime.run(
      makeInput(cancelModel, cancelStore),
    )[Symbol.asyncIterator]();
    await cancelIterator.next();
    await cancelIterator.next();
    await cancelIterator.next();
    await cancelIterator.next();
    const pendingModel = cancelIterator.next();
    await cancelModel.pulled.promise;

    await expect(cancelRuntime.cancel("run-1")).rejects.toMatchObject({
      code: "RUNTIME_EVENT_APPEND_FAILED",
      eventType: "turn.completed",
    });
    await expect(pendingModel).rejects.toBeInstanceOf(EventAppendError);

    const returnStore = new RecordingEventStore({ failType: "turn.completed" });
    const returnRuntime = new MinimalAgentRuntime();
    const returnIterator = returnRuntime.run(
      makeInput(new FakeModel([{ content: "must not run" }]), returnStore),
    )[Symbol.asyncIterator]();
    await returnIterator.next();
    await returnIterator.next();
    await returnIterator.next();
    await returnIterator.next();
    await expect(returnIterator.return!()).rejects.toBeInstanceOf(EventAppendError);
  });

  it("snapshots caller-owned run input before asynchronous production begins", async () => {
    const store = new RecordingEventStore();
    const model = new FakeModel([{ content: "stable" }]);
    const context: RunInput["context"] = [{ role: "user", content: "prior" }];
    const providerOptions = { nested: { temperature: 0 } };
    const input = makeInput(model, store, { context, providerOptions });
    const runtime = new MinimalAgentRuntime();
    const stream = runtime.run(input);

    input.runId = "mutated-run";
    input.sessionId = "mutated-session";
    input.turnId = "mutated-turn";
    input.input = "mutated input";
    input.model = "mutated/model";
    input.eventStore = new RecordingEventStore({ failType: "turn.started" });
    input.modelAdapter = new FakeModel([{ content: "mutated" }]);
    input.now = () => "2099-01-01T00:00:00.000Z";
    input.newId = () => "mutated-id";
    context![0]!.content = "mutated prior";
    providerOptions.nested.temperature = 1;

    const events = await collect(stream);
    expect(events.every((event) => event.at === FIXED_AT)).toBe(true);
    expect(events[0]?.data).toMatchObject({
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
    });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      model: "fake-model/v1",
      messages: [
        { role: "user", content: "prior" },
        { role: "user", content: "say hello" },
      ],
      providerOptions: { nested: { temperature: 0 } },
    });
  });

  it("returns typed errors for invalid, duplicate, unknown, reused, and terminal controls", async () => {
    const runtime = new MinimalAgentRuntime();
    const store = new RecordingEventStore();
    const model = new FakeModel([{ content: "done" }]);
    const input = makeInput(model, store);

    expect(() => runtime.run({ ...input, runId: "" })).toThrow(InvalidRunInputError);
    expect(() => runtime.run({ ...input, signal: {} as AbortSignal })).toThrow(
      InvalidRunInputError,
    );
    const stream = runtime.run(input);
    expect(() => runtime.run(input)).toThrow(RunAlreadyExistsError);
    const claimed = stream[Symbol.asyncIterator]();
    expect(() => stream[Symbol.asyncIterator]()).toThrow(RuntimeConsumerError);
    await expect(runtime.steer("missing", "hello")).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(runtime.cancel("missing")).rejects.toBeInstanceOf(RunNotFoundError);

    // The first iterator claimed above is intentionally abandoned through a
    // fresh run so this assertion does not rely on garbage collection.
    const runtime2 = new MinimalAgentRuntime();
    const completed = makeInput(new FakeModel([{ content: "done" }]), new RecordingEventStore());
    await collect(runtime2.run(completed));
    await expect(runtime2.steer("run-1", "too late")).rejects.toBeInstanceOf(RunTerminalError);
    await expect(runtime2.cancel("run-1")).rejects.toBeInstanceOf(RunTerminalError);

    await claimed.return!();
    await runtime.cancel("run-1");
  });
});

describe("M7 deterministic session loop", () => {
  it("runs two FakeModel rounds through a pure tool with exact durable order and context revisions", async () => {
    const executions: string[] = [];
    const uppercase = createBoundedTool({
      name: "uppercase",
      description: "Uppercase one string",
      parameters: z.object({ value: z.string() }).strict(),
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      authorization: (input) => ({
        action: "text.uppercase",
        subject: (input as { value: string }).value,
        scope: "once",
      }),
      execute: ({ value }) => {
        executions.push(value);
        return { value: value.toUpperCase() };
      },
    }, { kind: "pure" });
    const tools = new ToolRegistry([uppercase]);
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [
          { id: "model-call-1", name: "uppercase", arguments: { value: "hello" } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        content: "HELLO",
        textDeltas: ["HE", "LLO"],
        usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
      },
    ]);
    const store = new RecordingEventStore();

    const events = await collect(new MinimalAgentRuntime().run(
      makeInput(model, store, { tools }),
    ));

    expect(events.map(({ type }) => type)).toEqual([
      "agent.started",
      "turn.started",
      "message.completed",
      "model.request",
      "model.response",
      "message.completed",
      "tool.call",
      "policy.decision",
      "tool.result",
      "message.completed",
      "model.request",
      "message.delta",
      "message.delta",
      "model.response",
      "message.completed",
      "turn.completed",
      "agent.stopped",
    ]);
    expect(store.events).toEqual(events);
    expect(executions).toEqual(["hello"]);
    const durableCall = events.find((event) => event.type === "tool.call");
    const durableDecision = events.find((event) => event.type === "policy.decision");
    expect(durableDecision?.data).toMatchObject({
      sessionId: "sess-1",
      runId: "run-1",
      turnId: "turn-1",
      callId: durableCall?.type === "tool.call" ? durableCall.data.callId : "missing",
    });

    const requestEvents = events.filter((event) => event.type === "model.request");
    expect(requestEvents.map(({ data }) => data)).toEqual([
      expect.objectContaining({
        step: 1,
        contextVersion: 1,
        messageRevision: 1,
        messageCount: 1,
      }),
      expect.objectContaining({
        step: 2,
        contextVersion: 1,
        messageRevision: 3,
        messageCount: 3,
      }),
    ]);
    const completedMessages = events.filter((event) => event.type === "message.completed");
    expect(completedMessages.map(({ data }) => data.messageRevision)).toEqual([1, 2, 3, 4]);

    const requests = model.requests as ModelRequest[];
    expect(requests).toHaveLength(2);
    expect(requests.map(({ contextVersion, messageRevision }) => ({
      contextVersion,
      messageRevision,
    }))).toEqual([
      { contextVersion: 1, messageRevision: 1 },
      { contextVersion: 1, messageRevision: 3 },
    ]);
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "say hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "model-call-1", name: "uppercase", arguments: { value: "hello" } },
        ],
      },
      {
        role: "tool",
        name: "uppercase",
        toolCallId: "model-call-1",
        content: '{"value":"HELLO"}',
      },
    ]);
    expectOneTerminalOutcome(events, "completed");
    expect(events.at(-2)?.data).toMatchObject({
      modelRequests: 2,
      toolCalls: 1,
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      stateVersion: 1,
      messageRevision: 4,
    });
  });

  it("returns typed observations for unknown tools and invalid arguments before authorization or execution", async () => {
    let authorizationCalls = 0;
    let executions = 0;
    const strictTool = createBoundedTool({
      name: "strict-count",
      description: "Accept a positive count",
      parameters: z.object({ count: z.number().int().positive() }).strict(),
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
        additionalProperties: false,
      },
      authorization: () => {
        authorizationCalls++;
        return { action: "count.read", scope: "once" };
      },
      execute: ({ count }) => {
        executions++;
        return { count };
      },
    }, { kind: "pure" });
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [
          { id: "missing-call", name: "missing", arguments: {} },
          { id: "invalid-call", name: "strict-count", arguments: { count: "many" } },
        ],
      },
      { content: "recovered" },
    ]);
    const store = new RecordingEventStore();

    const events = await collect(new MinimalAgentRuntime().run(makeInput(model, store, {
      tools: new ToolRegistry([strictTool]),
    })));

    const results = events.filter((event) => event.type === "tool.result");
    expect(results.map(({ data }) => data.error?.code)).toEqual([
      "TOOL_NOT_FOUND",
      "TOOL_BAD_INPUT",
    ]);
    expect(results.every(({ data }) => data.ok === false)).toBe(true);
    expect(events.filter((event) => event.type === "policy.decision")).toHaveLength(0);
    expect(authorizationCalls).toBe(0);
    expect(executions).toBe(0);
    const secondRequest = (model.requests[1] as ModelRequest | undefined);
    const observations = secondRequest?.messages.filter((message) => message.role === "tool") ?? [];
    expect(observations).toHaveLength(2);
    expect(observations[0]?.content).toContain("TOOL_NOT_FOUND");
    expect(observations[1]?.content).toContain("TOOL_BAD_INPUT");
    expectOneTerminalOutcome(events, "completed");
  });

  it("turns a pure tool exception into a typed observation and lets the model recover", async () => {
    let executions = 0;
    const failing = createBoundedTool({
      name: "fail-pure",
      description: "Fail deterministically",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      execute: () => {
        executions++;
        throw new Error("deterministic boom");
      },
    }, { kind: "pure" });
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: "failure-call", name: "fail-pure", arguments: {} }],
      },
      { content: "handled" },
    ]);
    const store = new RecordingEventStore();

    const events = await collect(new MinimalAgentRuntime().run(makeInput(model, store, {
      tools: new ToolRegistry([failing]),
    })));

    expect(executions).toBe(1);
    const result = events.find((event) => event.type === "tool.result");
    expect(result?.data).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_EXECUTION_FAILED",
        message: "tool fail-pure failed: deterministic boom",
      },
    });
    const observation = (model.requests[1] as ModelRequest | undefined)?.messages
      .find((message) => message.role === "tool");
    expect(observation?.content).toContain("TOOL_EXECUTION_FAILED");
    expect(events.map(({ type }) => type).filter((type) =>
      type === "tool.call" || type === "policy.decision" || type === "tool.result"
    )).toEqual(["tool.call", "policy.decision", "tool.result"]);
    expectOneTerminalOutcome(events, "completed");
  });

  it.each([
    { effect: "allow" as const, expectedExecutions: 1, expectedOk: true },
    { effect: "deny" as const, expectedExecutions: 0, expectedOk: false },
  ])("persists tool intent then an $effect policy decision before its observation", async ({
    effect,
    expectedExecutions,
    expectedOk,
  }) => {
    let executions = 0;
    const tool = createBoundedTool({
      name: "permission-tool",
      description: "Exercise policy",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      authorization: () => ({ action: "permission.test", subject: "fixture", scope: "once" }),
      execute: () => {
        executions++;
        return { allowed: true };
      },
    }, { kind: "pure" });
    const permission: PermissionController = {
      decide: () => ({ effect, reason: `${effect} fixture`, ruleId: `fixture.${effect}` }),
    };
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: `${effect}-call`, name: "permission-tool", arguments: {} }],
      },
      { content: "done" },
    ]);
    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]), permission },
    )));

    expect(events.map(({ type }) => type).filter((type) =>
      type === "tool.call" || type === "policy.decision" || type === "tool.result"
    )).toEqual(["tool.call", "policy.decision", "tool.result"]);
    expect(events.find((event) => event.type === "policy.decision")?.data)
      .toMatchObject({ effect, action: "permission.test", subject: "fixture" });
    expect(events.find((event) => event.type === "tool.result")?.data.ok).toBe(expectedOk);
    if (effect === "deny") {
      expect(events.find((event) => event.type === "tool.result")?.data)
        .toMatchObject({ error: { code: "TOOL_POLICY_DENIED" } });
    }
    expect(executions).toBe(expectedExecutions);
    expectOneTerminalOutcome(events, "completed");
  });

  it("durably appends ask resolution before crossing the pure-tool execution fence", async () => {
    const store = new RecordingEventStore({ blockType: "permission.resolved" });
    let executions = 0;
    let resolvedRequest: { callId: string; signal?: AbortSignal } | undefined;
    const tool = createBoundedTool({
      name: "ask-tool",
      description: "Exercise interactive permission",
      parameters: z.object({ value: z.string() }).strict(),
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      authorization: () => ({ action: "ask.test", subject: "fixture", scope: "once" }),
      execute: ({ value }) => {
        executions++;
        return { value };
      },
    }, { kind: "pure" });
    const permission: PermissionController = {
      decide: () => ({ effect: "ask", reason: "operator fixture", ruleId: "fixture.ask" }),
      resolve: async (request, signal) => {
        resolvedRequest = { callId: request.callId, signal };
        return "allow";
      },
    };
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: "ask-call", name: "ask-tool", arguments: { value: "ok" } }],
      },
      { content: "done" },
    ]);
    const runtime = new MinimalAgentRuntime();
    const running = collect(runtime.run(makeInput(model, store, {
      tools: new ToolRegistry([tool]),
      permission,
    })));

    await store.appendStarted.promise;
    expect(executions).toBe(0);
    expect(store.events.some((event) => event.type === "permission.resolved")).toBe(false);
    expect(store.events.map(({ type }) => type).filter((type) =>
      type === "tool.call" || type === "policy.decision" || type.startsWith("permission.")
    )).toEqual(["tool.call", "policy.decision", "permission.requested"]);

    store.releaseBlockedAppend();
    const events = await running;
    expect(executions).toBe(1);
    expect(resolvedRequest?.signal?.aborted).toBe(false);
    expect(resolvedRequest?.callId).toBe(
      (events.find((event) => event.type === "tool.call")?.data as { callId: string }).callId,
    );
    expect(events.find((event) => event.type === "permission.resolved")?.actor)
      .toBe("operator");
    expect(events.map(({ type }) => type).filter((type) =>
      type === "tool.call" ||
      type === "policy.decision" ||
      type.startsWith("permission.") ||
      type === "tool.result"
    )).toEqual([
      "tool.call",
      "policy.decision",
      "permission.requested",
      "permission.resolved",
      "tool.result",
    ]);
    expectOneTerminalOutcome(events, "completed");
  });

  it("reuses one durably approved run-scoped grant for matching later calls", async () => {
    let resolutions = 0;
    let executions = 0;
    const tool = createBoundedTool({
      name: "run-grant-tool",
      description: "Exercise a run-scoped grant",
      parameters: z.object({ value: z.number() }).strict(),
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      authorization: () => ({
        action: "grant.test",
        subject: "same-subject",
        scope: "run",
      }),
      execute: ({ value }) => {
        executions++;
        return { value };
      },
    }, { kind: "pure" });
    const permission: PermissionController = {
      decide: () => ({ effect: "ask", reason: "approve once for this run" }),
      resolve: async () => {
        resolutions++;
        return "allow";
      },
    };
    const model = new FakeModel([
      {
        toolCalls: [{ id: "grant-call-1", name: "run-grant-tool", arguments: { value: 1 } }],
      },
      {
        toolCalls: [{ id: "grant-call-2", name: "run-grant-tool", arguments: { value: 2 } }],
      },
      { content: "done" },
    ]);

    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]), permission },
    )));

    expect(executions).toBe(2);
    expect(resolutions).toBe(1);
    expect(events.filter((event) => event.type === "policy.decision")).toHaveLength(2);
    expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "permission.resolved")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool.result" && event.data.ok)).toHaveLength(2);
    expectOneTerminalOutcome(events, "completed");
  });

  it.each(["tool.call", "policy.decision"] as const)(
    "does not execute when the durable %s append fence fails",
    async (failType) => {
      const store = new RecordingEventStore({ failType });
      let authorizationCalls = 0;
      let executions = 0;
      const tool = createBoundedTool({
        name: "fenced-tool",
        description: "Exercise persistence fences",
        parameters: z.object({}).strict(),
        inputSchema: { type: "object", additionalProperties: false },
        authorization: () => {
          authorizationCalls++;
          return { action: "fence.test", scope: "once" };
        },
        execute: () => {
          executions++;
          return { shouldNotRun: true };
        },
      }, { kind: "pure" });
      const model = new FakeModel([{
        content: "",
        toolCalls: [{ id: "fenced-call", name: "fenced-tool", arguments: {} }],
      }]);

      const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(model, store, {
        tools: new ToolRegistry([tool]),
      })));

      expect(outcome.error).toBeInstanceOf(EventAppendError);
      expect(outcome.error).toMatchObject({
        code: "RUNTIME_EVENT_APPEND_FAILED",
        eventType: failType,
      });
      expect(executions).toBe(0);
      expect(authorizationCalls).toBe(failType === "tool.call" ? 0 : 1);
      expect(store.events.some((event) => event.type === "tool.result")).toBe(false);
      expect(store.events.some((event) => event.type === "turn.completed")).toBe(false);
      expect(store.events.some((event) => event.type === "agent.stopped")).toBe(false);
    },
  );

  it("times out a model round, aborts its signal, and emits one failed terminal outcome", async () => {
    const store = new RecordingEventStore();
    const model = new HangingAdapter();
    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(model, store, {
      modelTimeoutMs: 5,
    })));

    expect(outcome.error).toBeInstanceOf(ModelTimeoutError);
    expect(outcome.error).toMatchObject({
      code: "RUNTIME_MODEL_TIMEOUT",
      timeoutMs: 5,
    });
    expect(model.signal?.aborted).toBe(true);
    expect(model.returns).toBe(1);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it.each([
    {
      name: "missing terminal",
      stream: [{ type: "text.delta", delta: "partial" }] as ModelEvent[],
    },
    {
      name: "text after tool intent",
      stream: [
        {
          type: "tool.call",
          call: { id: "bad-order", name: "unused", arguments: {} },
        },
        { type: "text.delta", delta: "late" },
      ] as ModelEvent[],
    },
    {
      name: "unknown frame",
      stream: [{ type: "provider.mystery" } as unknown as ModelEvent],
    },
  ])("fails a malformed model stream with one terminal outcome: $name", async ({ stream }) => {
    const model = new FakeModel([{ content: "unused", stream }]);
    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expect(outcome.events.some((event) => event.type === "model.response")).toBe(false);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it.each([
    { metric: "steps" as const, limit: 1, expectedExecutions: 1 },
    { metric: "tokens" as const, limit: 3, expectedExecutions: 0 },
    { metric: "tool_calls" as const, limit: 1, expectedExecutions: 1 },
  ])("hard-stops the $metric budget with one budget terminal outcome", async ({
    metric,
    limit,
    expectedExecutions,
  }) => {
    let executions = 0;
    const tool = createBoundedTool({
      name: "budget-tool",
      description: "Exercise hard budgets",
      parameters: z.object({ value: z.number() }).strict(),
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      execute: ({ value }) => {
        executions++;
        return { value };
      },
    }, { kind: "pure" });
    const call = (id: string, value: number) => ({
      id,
      name: "budget-tool",
      arguments: { value },
    });
    const model = metric === "tokens"
      ? new FakeModel([{
          content: "over budget",
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        }])
      : metric === "tool_calls"
        ? new FakeModel([{
            content: "",
            toolCalls: [call("budget-call-1", 1), call("budget-call-2", 2)],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          }])
        : new FakeModel([
            {
              content: "",
              toolCalls: [call("budget-step-call", 1)],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
            { content: "must not be requested" },
          ]);
    const budget = metric === "steps"
      ? { maxSteps: limit }
      : metric === "tokens"
        ? { maxModelTokens: limit }
        : { maxToolCalls: limit };

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(model, new RecordingEventStore(), {
      tools: new ToolRegistry([tool]),
      budget,
    })));

    expect(outcome.error).toBeInstanceOf(RuntimeBudgetExceededError);
    expect(outcome.error).toMatchObject({
      code: "RUNTIME_BUDGET_EXCEEDED",
      metric,
      limit,
    });
    expect(executions).toBe(expectedExecutions);
    expect(outcome.events.some((event) =>
      event.type === "budget.warning" && event.data.metric === metric
    )).toBe(true);
    if (metric === "tool_calls") {
      expect(outcome.events.filter((event) => event.type === "tool.call")).toHaveLength(2);
      expect(outcome.events.filter((event) => event.type === "policy.decision")).toHaveLength(1);
      expect(outcome.events.some((event) =>
        event.type === "budget.warning" &&
        event.data.metric === "tool_calls" &&
        event.data.used === 2 &&
        event.data.limit === 1
      )).toBe(true);
    }
    expectOneTerminalOutcome(outcome.events, "budget_exceeded");
  });

  it("cancels while awaiting permission, cleans its signal listener, and never executes", async () => {
    const waiting = gate();
    let resolverActive = 0;
    let listenerCleaned = false;
    let executions = 0;
    const tool = createBoundedTool({
      name: "cancel-permission-tool",
      description: "Wait for permission cancellation",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      authorization: () => ({ action: "cancel.permission", scope: "once" }),
      execute: () => {
        executions++;
        return { shouldNotRun: true };
      },
    }, { kind: "pure" });
    const permission: PermissionController = {
      decide: () => ({ effect: "ask", reason: "wait for cancellation" }),
      resolve: (_request, signal) => {
        if (!signal) throw new Error("runtime did not provide a cancellation signal");
        resolverActive++;
        waiting.release();
        return new Promise((resolve) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            listenerCleaned = true;
            resolverActive--;
            queueMicrotask(() => resolve("deny"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    const model = new FakeModel([{
      content: "",
      toolCalls: [{ id: "permission-cancel-call", name: "cancel-permission-tool", arguments: {} }],
    }]);
    const runtime = new MinimalAgentRuntime();
    const running = collect(runtime.run(makeInput(model, new RecordingEventStore(), {
      tools: new ToolRegistry([tool]),
      permission,
    })));

    await waiting.promise;
    await runtime.cancel("run-1");
    const events = await running;

    expect(listenerCleaned).toBe(true);
    expect(resolverActive).toBe(0);
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "permission.resolved")?.data)
      .toMatchObject({ decision: "deny", note: "run canceled while awaiting permission" });
    expect(events.find((event) => event.type === "permission.resolved")?.actor)
      .toBe("kernel");
    expect(events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: false, error: { code: "TOOL_CANCELED" } });
    expectOneTerminalOutcome(events, "canceled");
  });

  it("cancels a cooperative pure tool without leaving active work or a success result", async () => {
    const executionStarted = gate();
    let executions = 0;
    let activeExecutions = 0;
    let executionSettled = false;
    let listenerCleaned = false;
    const tool = createBoundedTool({
      name: "cancel-tool",
      description: "Wait cooperatively for cancellation",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      execute: (_input, context) => {
        const signal = context?.signal;
        if (!signal) throw new Error("runtime did not provide a cancellation signal");
        executions++;
        activeExecutions++;
        executionStarted.release();
        return new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            listenerCleaned = true;
            activeExecutions--;
            queueMicrotask(() => reject(new Error("cooperative abort")));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }).finally(() => {
          executionSettled = true;
        });
      },
    }, { kind: "pure" });
    const model = new FakeModel([{
      content: "",
      toolCalls: [{ id: "tool-cancel-call", name: "cancel-tool", arguments: {} }],
    }]);
    const runtime = new MinimalAgentRuntime();
    const running = collect(runtime.run(makeInput(model, new RecordingEventStore(), {
      tools: new ToolRegistry([tool]),
    })));

    await executionStarted.promise;
    await runtime.cancel("run-1");
    const events = await running;

    expect(executions).toBe(1);
    expect(activeExecutions).toBe(0);
    expect(executionSettled).toBe(true);
    expect(listenerCleaned).toBe(true);
    const results = events.filter((event) => event.type === "tool.result");
    expect(results).toHaveLength(1);
    expect(results[0]?.data).toMatchObject({
      ok: false,
      error: { code: "TOOL_CANCELED" },
    });
    expectOneTerminalOutcome(events, "canceled");
  });
});

describe("M7 hardened boundary regressions", () => {
  it("rejects nested accessor-backed tool arguments without invoking the accessor", async () => {
    let getterReads = 0;
    const argumentsWithGetter: Record<string, unknown> = {};
    Object.defineProperty(argumentsWithGetter, "value", {
      enumerable: true,
      get() {
        getterReads++;
        return "must not be read";
      },
    });
    const model: ModelAdapter = {
      async *stream(): AsyncIterable<ModelEvent> {
        yield {
          type: "tool.call",
          call: {
            id: "accessor-arguments-call",
            name: "unused",
            arguments: argumentsWithGetter,
          },
        };
      },
    };

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(getterReads).toBe(0);
    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.events.some((event) => event.type === "tool.call")).toBe(false);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("snapshots nested pure-tool definitions once at run admission", async () => {
    const inputSchema = {
      type: "object",
      properties: {
        value: { type: "string", description: "captured at admission" },
      },
      required: ["value"],
      additionalProperties: false,
    };
    const tool = createBoundedTool({
      name: "definition-snapshot-tool",
      description: "Exercise immutable advertised definitions",
      parameters: z.object({ value: z.string() }).strict(),
      inputSchema,
      execute: ({ value }) => {
        inputSchema.properties.value.description = "mutated during execution";
        return { value };
      },
    }, { kind: "pure" });
    const model = new FakeModel([
      {
        toolCalls: [{
          id: "definition-snapshot-call",
          name: "definition-snapshot-tool",
          arguments: { value: "ok" },
        }],
      },
      { content: "done" },
    ]);
    const runtime = new MinimalAgentRuntime();
    const stream = runtime.run(makeInput(model, new RecordingEventStore(), {
      tools: new ToolRegistry([tool]),
    }));
    inputSchema.properties.value.description = "mutated before consumption";

    const events = await collect(stream);

    expect(model.requests).toHaveLength(2);
    for (const request of model.requests as ModelRequest[]) {
      const schema = request.tools?.[0]?.inputSchema as {
        properties: { value: { description: string } };
      } | undefined;
      expect(schema?.properties.value.description).toBe("captured at admission");
      expect(Object.isFrozen(schema?.properties.value)).toBe(true);
    }
    expectOneTerminalOutcome(events, "completed");
  });

  it("keeps the durable tool intent immutable across consumer and authorization boundaries", async () => {
    let authorizationValue: unknown;
    let executionValue: unknown;
    const tool = createBoundedTool({
      name: "immutable-intent-tool",
      description: "Exercise tool-input snapshotting",
      parameters: z.any(),
      inputSchema: { type: "object" },
      authorization: (input) => {
        authorizationValue = input;
        try {
          (input as { value: string }).value = "authorization mutation";
        } catch {
          // Frozen validated input rejects mutation in strict-mode callers.
        }
        return { action: "immutable.intent", scope: "once" };
      },
      execute: (input) => {
        executionValue = input;
        return input;
      },
    }, { kind: "pure" });
    const model = new FakeModel([
      {
        toolCalls: [{
          id: "immutable-intent-call",
          name: "immutable-intent-tool",
          arguments: { value: "original" },
        }],
      },
      { content: "done" },
    ]);
    const events: AgentEvent[] = [];

    for await (const event of new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]) },
    ))) {
      events.push(event);
      if (event.type === "tool.call") {
        const persistedInput = event.data.input as { value: string };
        expect(Object.isFrozen(persistedInput)).toBe(true);
        try {
          persistedInput.value = "consumer mutation";
        } catch {
          // The consumer must not be able to change the post-ACK execution.
        }
      }
    }

    expect(authorizationValue).toEqual({ value: "original" });
    expect(executionValue).toEqual({ value: "original" });
    expect(Object.isFrozen(authorizationValue)).toBe(true);
    expect(events.find((event) => event.type === "tool.call")?.data.input)
      .toEqual({ value: "original" });
    expect(events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: true, output: { value: "original" } });
    expectOneTerminalOutcome(events, "completed");
  });

  it.each([
    { path: "already-failing turn event", successfulModel: false, failAt: 5 },
    { path: "already-failing stop event", successfulModel: false, failAt: 6 },
    { path: "successful turn event", successfulModel: true, failAt: 7 },
    { path: "successful stop event", successfulModel: true, failAt: 8 },
  ])("retries a transient terminal construction fault: $path", async ({
    successfulModel,
    failAt,
  }) => {
    let clockCalls = 0;
    const now = () => {
      clockCalls++;
      if (clockCalls === failAt) throw new Error("transient clock failure");
      return FIXED_AT;
    };
    const model = successfulModel
      ? new FakeModel([{ content: "done" }])
      : new FakeModel([{
          content: "unused",
          stream: [{ type: "provider.mystery" } as unknown as ModelEvent],
        }]);

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { now },
    )));

    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("rejects an accessor-backed model event frame without invoking the accessor", async () => {
    let accessorReads = 0;
    const frame = { delta: "must not be read" } as Record<string, unknown>;
    Object.defineProperty(frame, "type", {
      enumerable: true,
      get() {
        accessorReads++;
        return "text.delta";
      },
    });
    const model = new FakeModel([{
      content: "unused",
      stream: [frame as unknown as ModelEvent],
    }]);

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(accessorReads).toBe(0);
    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("rejects an otherwise valid model event frame with an unknown extra field", async () => {
    const frame = {
      type: "text.delta",
      delta: "hello",
      providerSequence: 1,
    } as unknown as ModelEvent;
    const model = new FakeModel([{ content: "unused", stream: [frame] }]);

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expect(outcome.events.some((event) => event.type === "message.delta")).toBe(false);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("accepts streamed and completed tool arguments with equal JSON semantics but different key order", async () => {
    const streamedArguments: Record<string, number> = {};
    streamedArguments.alpha = 1;
    streamedArguments.beta = 2;
    const completedArguments: Record<string, number> = {};
    completedArguments.beta = 2;
    completedArguments.alpha = 1;
    const callId = "ordered-arguments-call";
    let executions = 0;
    const tool = createBoundedTool({
      name: "ordered-arguments",
      description: "Accept two numeric fields",
      parameters: z.object({ alpha: z.number(), beta: z.number() }).strict(),
      inputSchema: {
        type: "object",
        properties: {
          alpha: { type: "number" },
          beta: { type: "number" },
        },
        required: ["alpha", "beta"],
        additionalProperties: false,
      },
      execute: (input) => {
        executions++;
        return input.alpha + input.beta;
      },
    }, { kind: "pure" });
    const completion: CompletionResponse = {
      id: "ordered-completion",
      content: "",
      toolCalls: [{
        id: callId,
        name: "ordered-arguments",
        arguments: completedArguments,
      }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "tool_calls",
    };
    const model = new FakeModel([
      {
        content: "",
        stream: [
          {
            type: "tool.call",
            call: {
              id: callId,
              name: "ordered-arguments",
              arguments: streamedArguments,
            },
          },
          { type: "response.completed", response: completion },
        ],
      },
      { content: "done" },
    ]);

    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]) },
    )));

    expect(executions).toBe(1);
    expect(events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: true, output: 3 });
    expectOneTerminalOutcome(events, "completed");
  });

  it("snapshots a streamed tool intention before the provider mutates its objects", async () => {
    const requests: ModelRequest[] = [];
    let round = 0;
    const model: ModelAdapter = {
      stream(request) {
        requests.push(request);
        round++;
        if (round === 1) {
          return (async function* (): AsyncIterable<ModelEvent> {
            const mutableArguments = { value: "original" };
            const mutableCall = {
              id: "mutable-call",
              name: "snapshot-tool",
              arguments: mutableArguments,
            };
            yield { type: "tool.call", call: mutableCall };
            mutableCall.name = "mutated-tool";
            mutableArguments.value = "mutated";
            yield {
              type: "response.completed",
              response: {
                id: "snapshot-completion",
                content: "",
                toolCalls: [{
                  id: "mutable-call",
                  name: "snapshot-tool",
                  arguments: { value: "original" },
                }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                finishReason: "tool_calls",
              },
            };
          })();
        }
        return (async function* (): AsyncIterable<ModelEvent> {
          yield {
            type: "response.completed",
            response: response("done"),
          };
        })();
      },
    };
    const received: string[] = [];
    const tool = createBoundedTool({
      name: "snapshot-tool",
      description: "Record one snapshotted value",
      parameters: z.object({ value: z.string() }).strict(),
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      execute: ({ value }) => {
        received.push(value);
        return { value };
      },
    }, { kind: "pure" });

    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]) },
    )));

    expect(received).toEqual(["original"]);
    expect(events.find((event) => event.type === "tool.call")?.data).toMatchObject({
      tool: "snapshot-tool",
      input: { value: "original" },
      modelCallId: "mutable-call",
    });
    expect(requests[1]?.messages.find((message) => message.role === "tool"))
      .toMatchObject({ name: "snapshot-tool", toolCallId: "mutable-call" });
    expectOneTerminalOutcome(events, "completed");
  });

  it.each([
    {
      malformed: "text mismatch",
      stream: [
        { type: "text.delta", delta: "streamed" },
        {
          type: "response.completed",
          response: {
            id: "text-mismatch",
            content: "completed",
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: "stop",
          },
        },
      ] as ModelEvent[],
    },
    {
      malformed: "usage mismatch",
      stream: [{
        type: "response.completed",
        response: {
          id: "usage-mismatch",
          content: "done",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 3 },
          finishReason: "stop",
        },
      }] as ModelEvent[],
    },
    {
      malformed: "finish mismatch",
      stream: [{
        type: "response.completed",
        response: {
          id: "finish-mismatch",
          content: "",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "tool_calls",
        },
      }] as ModelEvent[],
    },
    {
      malformed: "tool mismatch",
      stream: [
        {
          type: "tool.call",
          call: { id: "mismatch-call", name: "unused", arguments: { value: 1 } },
        },
        {
          type: "response.completed",
          response: {
            id: "tool-mismatch",
            content: "",
            toolCalls: [{
              id: "mismatch-call",
              name: "unused",
              arguments: { value: 2 },
            }],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            finishReason: "tool_calls",
          },
        },
      ] as ModelEvent[],
    },
  ])("rejects malformed completion $malformed", async ({ stream }) => {
    const model = new FakeModel([{ content: "unused", stream }]);
    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expect(outcome.events.some((event) => event.type === "model.response")).toBe(false);
    expect(outcome.events.some((event) => event.type === "tool.call")).toBe(false);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it.each([
    {
      boundary: "modelAdapter.stream",
      adapter: (): ModelAdapter => ({
        stream: () => Promise.reject(new Error("rejected stream")) as unknown as AsyncIterable<ModelEvent>,
      }),
    },
    {
      boundary: "async iterator factory",
      adapter: (): ModelAdapter => ({
        stream: () => ({
          [Symbol.asyncIterator]: () =>
            Promise.reject(new Error("rejected iterator")) as unknown as AsyncIterator<ModelEvent>,
        }),
      }),
    },
  ])("observes a rejected thenable from $boundary as a typed model failure", async ({ adapter }) => {
    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      adapter(),
      new RecordingEventStore(),
    )));

    await Promise.resolve();
    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.error).toMatchObject({ code: "RUNTIME_MODEL_STREAM_INVALID" });
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it.each([
    {
      boundary: "authorization",
      ruleId: "runtime.authorization.invalid",
    },
    {
      boundary: "policy",
      ruleId: "runtime.policy.invalid",
    },
  ])("observes a rejected thenable from $boundary and fails the tool closed", async ({
    boundary,
    ruleId,
  }) => {
    let executions = 0;
    const tool = createBoundedTool({
      name: "thenable-tool",
      description: "Exercise synchronous-only decisions",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      authorization: boundary === "authorization"
        ? () => Promise.reject(new Error("rejected authorization")) as unknown as {
            action: string;
            scope: "once";
          }
        : () => ({ action: "thenable.policy", scope: "once" }),
      execute: () => {
        executions++;
        return { shouldNotRun: true };
      },
    }, { kind: "pure" });
    const permission: PermissionController | undefined = boundary === "policy"
      ? {
          decide: () => Promise.reject(new Error("rejected policy")) as unknown as
            ReturnType<PermissionController["decide"]>,
        }
      : undefined;
    const model = new FakeModel([
      {
        content: "",
        toolCalls: [{ id: `${boundary}-thenable-call`, name: "thenable-tool", arguments: {} }],
      },
      { content: "recovered" },
    ]);

    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { tools: new ToolRegistry([tool]), permission },
    )));

    await Promise.resolve();
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "policy.decision")?.data)
      .toMatchObject({ effect: "deny", ruleId });
    expect(events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: false, error: { code: "TOOL_AUTHORIZATION_FAILED" } });
    expectOneTerminalOutcome(events, "completed");
  });

  it("cancels cleanly when permission.resolved is appended concurrently with cancellation", async () => {
    const store = new RecordingEventStore({ blockType: "permission.resolved" });
    let executions = 0;
    const tool = createBoundedTool({
      name: "permission-race-tool",
      description: "Exercise the permission resolution cancellation race",
      parameters: z.object({}).strict(),
      inputSchema: { type: "object", additionalProperties: false },
      authorization: () => ({ action: "permission.race", scope: "once" }),
      execute: () => {
        executions++;
        return { shouldNotRun: true };
      },
    }, { kind: "pure" });
    const permission: PermissionController = {
      decide: () => ({ effect: "ask", reason: "race fixture" }),
      resolve: async () => "allow",
    };
    const model = new FakeModel([{
      content: "",
      toolCalls: [{ id: "permission-race-call", name: "permission-race-tool", arguments: {} }],
    }]);
    const runtime = new MinimalAgentRuntime();
    const running = collect(runtime.run(makeInput(model, store, {
      tools: new ToolRegistry([tool]),
      permission,
    })));

    await store.appendStarted.promise;
    const canceling = runtime.cancel("run-1");
    let cancelSettled = false;
    void canceling.then(() => { cancelSettled = true; });
    await Promise.resolve();
    expect(cancelSettled).toBe(false);
    expect(executions).toBe(0);

    store.releaseBlockedAppend();
    const [events] = await Promise.all([running, canceling.then(() => undefined)]);
    expect(executions).toBe(0);
    expect(events.find((event) => event.type === "permission.resolved")?.data)
      .toMatchObject({ decision: "allow" });
    expect(events.find((event) => event.type === "tool.result")?.data)
      .toMatchObject({ ok: false, error: { code: "TOOL_CANCELED" } });
    expect(events.map(({ type }) => type).filter((type) =>
      type === "permission.resolved" || type === "tool.result" || type === "turn.completed"
    )).toEqual(["permission.resolved", "tool.result", "turn.completed"]);
    expectOneTerminalOutcome(events, "canceled");
  });

  it("does not start another provider pull after a held delta crosses its deadline", async () => {
    const model = new PullCountingAdapter("ab");
    const iterator = new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { modelTimeoutMs: 20 },
    ))[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    while (true) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      events.push(next.value!);
      if (next.value?.type === "message.delta") break;
    }
    expect(model.pulls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(model.signal?.aborted).toBe(true);
    expect(model.pulls).toBe(1);

    let error: unknown;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect(model.pulls).toBe(1);
    expect(model.returns).toBe(1);
    expectOneTerminalOutcome(events, "failed");
  });

  it("aborts the request after iterator.return registers cooperative cleanup", async () => {
    let activeReturns = 0;
    let returnSettled = false;
    let requestSignal: AbortSignal | undefined;
    const model: ModelAdapter = {
      stream(request) {
        requestSignal = request.signal;
        let emitted = false;
        return {
          [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
            return {
              async next() {
                if (emitted) return { done: true, value: undefined };
                emitted = true;
                return {
                  done: false,
                  value: { type: "response.completed", response: response("done") },
                };
              },
              return() {
                activeReturns++;
                return new Promise<IteratorResult<ModelEvent>>((resolve) => {
                  const settle = () => {
                    activeReturns--;
                    returnSettled = true;
                    resolve({ done: true, value: undefined });
                  };
                  if (request.signal?.aborted) settle();
                  else request.signal?.addEventListener("abort", settle, { once: true });
                });
              },
            };
          },
        };
      },
    };

    const events = await collect(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(requestSignal?.aborted).toBe(true);
    expect(activeReturns).toBe(0);
    expect(returnSettled).toBe(true);
    expectOneTerminalOutcome(events, "completed");
  });

  it("preserves the typed timeout when the iterator.return getter throws", async () => {
    const model: ModelAdapter = {
      stream: () => ({
        [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
          const iterator = {
            next: () => new Promise<IteratorResult<ModelEvent>>(() => undefined),
          } as AsyncIterator<ModelEvent>;
          Object.defineProperty(iterator, "return", {
            get() {
              throw new Error("return getter exploded");
            },
          });
          return iterator;
        },
      }),
    };

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
      { modelTimeoutMs: 5 },
    )));

    expect(outcome.error).toBeInstanceOf(ModelTimeoutError);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("rejects accessor-backed iterator results without invoking their accessors", async () => {
    let doneReads = 0;
    const model: ModelAdapter = {
      stream: () => ({
        [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
          return {
            next: async () => {
              const result = { value: { type: "text.delta", delta: "unsafe" } };
              Object.defineProperty(result, "done", {
                enumerable: true,
                get() {
                  doneReads++;
                  return false;
                },
              });
              return result as unknown as IteratorResult<ModelEvent>;
            },
          };
        },
      }),
    };

    const outcome = await collectOutcome(new MinimalAgentRuntime().run(makeInput(
      model,
      new RecordingEventStore(),
    )));

    expect(doneReads).toBe(0);
    expect(outcome.error).toBeInstanceOf(ModelStreamError);
    expect(outcome.events.some((event) => event.type === "message.delta")).toBe(false);
    expectOneTerminalOutcome(outcome.events, "failed");
  });

  it("contains structural AbortSignal method failures and keeps run IDs reusable", async () => {
    const runtime = new MinimalAgentRuntime();
    const badAddSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("bad add");
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    const reusableModel = new FakeModel([{ content: "done" }]);

    expect(() => runtime.run(makeInput(
      reusableModel,
      new RecordingEventStore(),
      { signal: badAddSignal },
    ))).toThrow(InvalidRunInputError);
    const events = await collect(runtime.run(makeInput(
      reusableModel,
      new RecordingEventStore(),
    )));
    expectOneTerminalOutcome(events, "completed");

    const badRemoveSignal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        throw new Error("bad remove");
      },
    } as unknown as AbortSignal;
    const secondEvents = await collect(new MinimalAgentRuntime().run(makeInput(
      new FakeModel([{ content: "done" }]),
      new RecordingEventStore(),
      { runId: "run-remove", signal: badRemoveSignal },
    )));
    expectOneTerminalOutcome(secondEvents, "completed");
  });

  it("lets completion win when cancellation races the synchronous final-message ACK boundary", async () => {
    const store = new RecordingEventStore();
    const runtime = new MinimalAgentRuntime();
    const iterator = runtime.run(makeInput(
      new FakeModel([{ content: "done" }]),
      store,
    ))[Symbol.asyncIterator]();

    while (true) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (
        next.value?.type === "message.completed" &&
        next.value.data.role === "assistant"
      ) {
        break;
      }
    }

    const terminalPull = iterator.next();
    await expect(runtime.cancel("run-1")).rejects.toMatchObject({
      code: "RUNTIME_RUN_TERMINAL",
      status: "completing",
    });
    await expect(terminalPull).resolves.toMatchObject({
      value: { type: "turn.completed", data: { status: "completed" } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "agent.stopped", data: { status: "completed" } },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expectOneTerminalOutcome(store.events, "completed");
  });
});

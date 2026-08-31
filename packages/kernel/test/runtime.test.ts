import { describe, expect, it } from "vitest";
import type { AgentEvent, EventStore, RunInput } from "../src";
import {
  EventAppendError,
  InvalidRunInputError,
  MinimalAgentRuntime,
  RunAlreadyExistsError,
  RunNotFoundError,
  RunTerminalError,
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
      "turn.started",
      "message.completed",
      "model.request",
      "message.delta",
      "message.delta",
      "model.response",
      "message.completed",
      "turn.completed",
    ]);
    expect(yielded[1]?.data).toMatchObject({ role: "user", content: "say hello" });
    expect(yielded[3]?.data).toMatchObject({ sequence: 0, delta: "he" });
    expect(yielded[4]?.data).toMatchObject({ sequence: 1, delta: "llo" });
    expect(yielded[6]?.data).toMatchObject({ role: "assistant", content: "hello" });
    expect(yielded.at(-1)?.data).toMatchObject({
      status: "completed",
      modelRequests: 1,
      toolCalls: 0,
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
      "turn.started",
      "message.completed",
      "model.request",
      "model.response",
      "message.completed",
      "turn.completed",
    ]);
    expect(events.find((event) => event.type === "message.completed" && event.data.role === "assistant")?.data)
      .toMatchObject({ content: "legacy answer", finishReason: "stop" });
  });

  it("does not deliver or cross the model boundary until model.request is durable and consumed", async () => {
    const store = new RecordingEventStore({ blockType: "model.request" });
    const model = new FakeModel([{ content: "ok" }]);
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

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
    await expect(iterator.next()).rejects.toMatchObject({
      code: "RUNTIME_EVENT_APPEND_FAILED",
      eventType: "model.request",
    });
    expect(model.requests).toHaveLength(0);
    expect(store.events.map(({ type }) => type)).toEqual([
      "turn.started",
      "message.completed",
    ]);
  });

  it("pulls at most one model event per consumer advance", async () => {
    const store = new RecordingEventStore();
    const model = new PullCountingAdapter();
    const iterator = new MinimalAgentRuntime()
      .run(makeInput(model, store))[Symbol.asyncIterator]();

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
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(model.returns).toBe(1);
  });

  it("treats response.completed as terminal even when another provider pull would hang", async () => {
    const store = new RecordingEventStore();
    const model = new TerminalThenHangingAdapter();
    const events = await collect(new MinimalAgentRuntime().run(makeInput(model, store)));

    expect(events.map(({ type }) => type)).toEqual([
      "turn.started",
      "message.completed",
      "model.request",
      "model.response",
      "message.completed",
      "turn.completed",
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
      "turn.started",
      "message.completed",
      "steering.queued",
    ]);

    const events = await collect(stream);
    expect(events.map(({ type }) => type).slice(0, 4)).toEqual([
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
    const pendingModel = iterator.next();
    await model.pulled.promise;
    await Promise.all([runtime.cancel("run-1"), runtime.cancel("run-1")]);

    await expect(pendingModel).resolves.toMatchObject({
      value: { type: "turn.completed", data: { status: "canceled" } },
    });
    expect(model.signal?.aborted).toBe(true);
    expect(store.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    await expect(runtime.cancel("run-1")).resolves.toBeUndefined();
  });

  it("treats iterator return as cancellation and persists the unseen terminal event", async () => {
    const store = new RecordingEventStore();
    const model = new FakeModel([{ content: "must not run" }]);
    const runtime = new MinimalAgentRuntime();
    const iterator = runtime.run(makeInput(model, store))[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "model.request" } });
    await expect(iterator.return!()).resolves.toEqual({ done: true, value: undefined });

    expect(model.requests).toHaveLength(0);
    expect(store.events.at(-1)).toMatchObject({
      type: "turn.completed",
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

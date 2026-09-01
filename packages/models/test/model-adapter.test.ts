import { describe, expect, it } from "vitest";
import {
  CompleteModelAdapter,
  adaptModel,
  type CompletionResponse,
  type Model,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from "../src";

const response: CompletionResponse = {
  id: "legacy-1",
  content: "legacy response",
  toolCalls: [
    { id: "call-1", name: "fs.read", arguments: { path: "README.md" } },
  ],
  usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  finishReason: "tool_calls",
};

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("CompleteModelAdapter", () => {
  it("forwards the full request and emits tool intentions before legacy parity", async () => {
    let captured: ModelRequest | undefined;
    const legacy: Model = {
      name: "legacy-test",
      async complete(request) {
        captured = request;
        return response;
      },
    };
    const controller = new AbortController();
    const request: ModelRequest = {
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "fs.read",
          description: "read a file",
          inputSchema: { type: "object" },
        },
      ],
      model: "legacy-model",
      maxTokens: 100,
      system: "system prompt",
      providerOptions: { seed: 1 },
      signal: controller.signal,
      contextVersion: 1,
      messageRevision: 4,
    };

    const events = await collect(adaptModel(legacy).stream(request));

    expect(captured).toBe(request);
    expect(events).toEqual([
      { type: "tool.call", call: response.toolCalls[0] },
      { type: "response.completed", response },
    ]);
    expect(events[1]).toMatchObject({
      type: "response.completed",
      response: { toolCalls: response.toolCalls },
    });
  });

  it("exports the named adapter and propagates completion failures", async () => {
    const failure = new Error("provider failed");
    const legacy: Model = {
      name: "legacy-test",
      async complete() {
        throw failure;
      },
    };
    const iterator = new CompleteModelAdapter(legacy)
      .stream({ messages: [] })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBe(failure);
  });

  it("does not invoke a legacy model for an already-cancelled request", async () => {
    let calls = 0;
    const legacy: Model = {
      name: "legacy-test",
      async complete() {
        calls += 1;
        return response;
      },
    };
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);

    await expect(
      collect(adaptModel(legacy).stream({
        messages: [],
        signal: controller.signal,
      })),
    ).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it("suppresses completion when cancellation wins an in-flight legacy call", async () => {
    let resolveCompletion: ((value: CompletionResponse) => void) | undefined;
    const legacy: Model = {
      name: "legacy-test",
      complete: () =>
        new Promise<CompletionResponse>((resolve) => {
          resolveCompletion = resolve;
        }),
    };
    const controller = new AbortController();
    const reason = new Error("cancelled while pending");
    const iterator = adaptModel(legacy)
      .stream({ messages: [], signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = iterator.next();

    await Promise.resolve();
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    resolveCompletion?.(response);
  });

  it("preserves native streaming adapters instead of wrapping them", () => {
    const native: ModelAdapter = {
      async *stream() {
        yield { type: "text.delta", delta: "native" };
        yield { type: "response.completed", response };
      },
    };

    expect(adaptModel(native)).toBe(native);
  });
});

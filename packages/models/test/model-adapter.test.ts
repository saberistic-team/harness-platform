import { describe, expect, it } from "vitest";
import {
  CompleteModelAdapter,
  adaptModel,
  type CompletionResponse,
  type Model,
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
  it("forwards the full request unchanged and emits legacy parity as one terminal event", async () => {
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
    };

    const events = await collect(adaptModel(legacy).stream(request));

    expect(captured).toBe(request);
    expect(events).toEqual([{ type: "response.completed", response }]);
    expect(events[0]).toMatchObject({
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
});

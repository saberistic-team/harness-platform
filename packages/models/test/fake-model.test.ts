import { describe, expect, it } from "vitest";
import { FakeModel } from "../src";
import {
  estimateTokens,
  MAX_MODEL_TEXT_DELTA_CHARS,
  type ModelEvent,
  type ModelRequest,
  type Usage,
} from "../src/model";

const usage = (n: number): Usage => ({
  promptTokens: n,
  completionTokens: n,
  totalTokens: n * 2,
});

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("FakeModel", () => {
  it("replays queued turns in order and then acks", async () => {
    const model = new FakeModel([{ content: "first" }, { content: "second" }]);

    const r1 = await model.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(r1.content).toBe("first");
    expect(r1.finishReason).toBe("stop");

    const r2 = await model.complete({ messages: [] });
    expect(r2.content).toBe("second");

    const r3 = await model.complete({ messages: [] });
    expect(r3.content).toBe("[fake-model] ack #3");
  });

  it("returns default deterministic usage when none is scripted", async () => {
    const model = new FakeModel([{ content: "abcd" }]);
    const res = await model.complete({
      system: "sysprompt",
      messages: [{ role: "user", content: "abcdefgh" }],
    });
    expect(res.usage.promptTokens).toBe(estimateTokens("sysprompt\nabcdefgh"));
    expect(res.usage.completionTokens).toBe(estimateTokens("abcd"));
    expect(res.usage.totalTokens).toBe(
      res.usage.promptTokens + res.usage.completionTokens,
    );
  });

  it("honors explicit scripted usage", async () => {
    const model = new FakeModel([{ content: "x", usage: usage(5) }]);
    const res = await model.complete({ messages: [] });
    expect(res.usage).toEqual(usage(5));
  });

  it("defaults finishReason to tool_calls when the turn has tool calls", async () => {
    const model = new FakeModel([
      {
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }],
        usage: usage(1),
      },
    ]);
    const res = await model.complete({ messages: [] });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.finishReason).toBe("tool_calls");
  });

  it("records every request for assertions", async () => {
    const model = new FakeModel();
    await model.complete({ messages: [{ role: "user", content: "a" }] });
    await model.complete({ messages: [{ role: "user", content: "b" }] });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.messages[0]?.content).toBe("a");
    expect(model.requests[1]?.messages[0]?.content).toBe("b");
  });

  it("streams scripted text chunks in order and completes with their exact content", async () => {
    const model = new FakeModel([
      {
        content: "hello",
        textDeltas: ["he", "ll", "o"],
        usage: usage(2),
      },
    ]);
    const signal = new AbortController().signal;
    const request: ModelRequest = {
      messages: [{ role: "user", content: "say hello" }],
      tools: [],
      model: "fake-override",
      maxTokens: 20,
      system: "be concise",
      providerOptions: { temperature: 0 },
      signal,
    };

    const events = await collect(model.stream(request));

    expect(events).toEqual([
      { type: "text.delta", delta: "he" },
      { type: "text.delta", delta: "ll" },
      { type: "text.delta", delta: "o" },
      {
        type: "response.completed",
        response: {
          id: "fake-1",
          content: "hello",
          toolCalls: [],
          usage: usage(2),
          finishReason: "stop",
        },
      },
    ]);
    expect(model.requests).toEqual([request]);
    expect(model.requests[0]?.signal).toBe(signal);
  });

  it("derives completed content from scripted chunks when content is omitted", async () => {
    const model = new FakeModel([{ textDeltas: ["a", "b", "c"] }]);

    const events = await collect(model.stream({ messages: [] }));

    expect(events.map((event) => event.type)).toEqual([
      "text.delta",
      "text.delta",
      "text.delta",
      "response.completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { content: "abc" },
    });
  });

  it("omits empty chunks while preserving completed content", async () => {
    const model = new FakeModel([
      { content: "ab", textDeltas: ["", "a", "", "b", ""] },
    ]);

    const events = await collect(model.stream({ messages: [] }));

    expect(events).toMatchObject([
      { type: "text.delta", delta: "a" },
      { type: "text.delta", delta: "b" },
      { type: "response.completed", response: { content: "ab" } },
    ]);
  });

  it("splits oversized chunks at the canonical event-safe boundary", async () => {
    const content = "x".repeat(MAX_MODEL_TEXT_DELTA_CHARS + 1);
    const model = new FakeModel([{ content }]);

    const events = await collect(model.stream({ messages: [] }));
    const deltas = events.flatMap((event) =>
      event.type === "text.delta" ? [event.delta] : []
    );

    expect(deltas.map((delta) => delta.length)).toEqual([
      MAX_MODEL_TEXT_DELTA_CHARS,
      1,
    ]);
    expect(deltas.join("")).toBe(content);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: { content },
    });
  });

  it("observes cancellation between streamed events and omits completion", async () => {
    const model = new FakeModel([
      { content: "ab", textDeltas: ["a", "b"] },
    ]);
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const iterator = model
      .stream({ messages: [], signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text.delta", delta: "a" },
    });
    controller.abort(reason);

    await expect(iterator.next()).rejects.toBe(reason);
  });

  it("closes cleanly when a consumer abandons the stream", async () => {
    const model = new FakeModel([
      { content: "ab", textDeltas: ["a", "b"] },
    ]);
    const iterator = model.stream({ messages: [] })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text.delta", delta: "a" },
    });
    await expect(iterator.return!(undefined)).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("rejects inconsistent scripted chunks instead of emitting divergent content", async () => {
    const model = new FakeModel([{ content: "ab", textDeltas: ["not-ab"] }]);

    await expect(collect(model.stream({ messages: [] }))).rejects.toThrow(
      "scripted text deltas must concatenate to response content",
    );
  });
});

import { describe, expect, it } from "vitest";
import { FakeModel } from "../src";
import { estimateTokens, type Usage } from "../src/model";

const usage = (n: number): Usage => ({
  promptTokens: n,
  completionTokens: n,
  totalTokens: n * 2,
});

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
});

import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolDefinition } from "@harness/models";
import {
  MESSAGE_STATE_VERSION,
  MODEL_CONTEXT_VERSION,
  InvalidMessageStateError,
  appendMessage,
  buildModelContext,
  createMessageState,
  type VersionedMessageState,
} from "../src/state";

describe("versioned message state", () => {
  it("creates an immutable revision from prior context", () => {
    const argumentsObject = { nested: { value: 1 } };
    const prior: ChatMessage[] = [
      { role: "system", content: "be concise" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{
          id: "call-1",
          name: "echo",
          arguments: argumentsObject,
        }],
      },
    ];

    const state = createMessageState(prior);
    argumentsObject.nested.value = 99;
    prior[0]!.content = "caller mutation";

    expect(MESSAGE_STATE_VERSION).toBe(1);
    expect(state).toEqual({
      version: 1,
      revision: 2,
      messages: [
        { role: "system", content: "be concise" },
        {
          role: "assistant",
          content: "checking",
          toolCalls: [{
            id: "call-1",
            name: "echo",
            arguments: { nested: { value: 1 } },
          }],
        },
      ],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.messages)).toBe(true);
    expect(Object.isFrozen(state.messages[1])).toBe(true);
    expect(Object.isFrozen(
      (state.messages[1] as any).toolCalls[0].arguments.nested,
    )).toBe(true);
  });

  it("uses revision zero for empty context and advances monotonically", () => {
    const empty = createMessageState();
    const user: ChatMessage = { role: "user", content: "start" };
    const first = appendMessage(empty, user);
    const second = appendMessage(first, {
      role: "tool",
      content: "{\"ok\":true}",
      name: "echo",
      toolCallId: "call-1",
    });
    user.content = "caller mutation";

    expect(empty).toMatchObject({ version: 1, revision: 0, messages: [] });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.messages).toEqual([{ role: "user", content: "start" }]);
    expect(second.messages).toEqual([
      { role: "user", content: "start" },
      {
        role: "tool",
        content: "{\"ok\":true}",
        name: "echo",
        toolCallId: "call-1",
      },
    ]);
    expect(second.messages).not.toBe(first.messages);
    expect(second.messages[0]).not.toBe(first.messages[0]);
  });

  it("rejects malformed and future-version state with a typed error", () => {
    const future = {
      version: 2,
      revision: 0,
      messages: [],
    } as unknown as VersionedMessageState;
    const revisionBehindMessages = {
      version: 1,
      revision: 0,
      messages: [{ role: "user", content: "already present" }],
    } as unknown as VersionedMessageState;
    const malformedMessage = {
      version: 1,
      revision: 1,
      messages: [{ role: "future", content: "unknown" }],
    } as unknown as VersionedMessageState;

    for (const state of [future, revisionBehindMessages, malformedMessage]) {
      expect(() => appendMessage(state, { role: "assistant", content: "x" }))
        .toThrow(InvalidMessageStateError);
      expect(() => buildModelContext(state))
        .toThrow(InvalidMessageStateError);
    }
  });
});

describe("versioned model context", () => {
  it("builds a detached immutable snapshot of messages and tools", () => {
    const state = appendMessage(createMessageState(), {
      role: "user",
      content: "start",
    });
    const tools: ToolDefinition[] = [{
      name: "echo",
      description: "echo input",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    }];

    const context = buildModelContext(state, tools);
    (tools[0]!.inputSchema.properties as Record<string, unknown>).value = {
      type: "number",
    };

    expect(MODEL_CONTEXT_VERSION).toBe(1);
    expect(context.version).toBe(1);
    expect(context.messageRevision).toBe(1);
    expect(context.messages).toEqual(state.messages);
    expect(context.messages).not.toBe(state.messages);
    expect(context.tools).toEqual([{
      name: "echo",
      description: "echo input",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    }]);
    expect(context.tools).not.toBe(tools);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.messages)).toBe(true);
    expect(Object.isFrozen(context.tools)).toBe(true);
    expect(Object.isFrozen(context.tools[0]!.inputSchema)).toBe(true);

    expect(() => {
      (context.messages[0] as { content: string }).content = "model mutation";
    }).toThrow(TypeError);
    expect(state.messages[0]?.content).toBe("start");
  });
});

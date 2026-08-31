import { describe, expect, it } from "vitest";
import { createEvent } from "@harness/events";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  AcpProtocolError,
  acpEvent,
  acpInitializeResultSchema,
  acpPromptResultSchema,
  decodeAcpMessage,
} from "../src";

describe("ACP wire contract", () => {
  it("decodes every request with validated params", () => {
    const messages = [
      { id: 1, method: ACP_METHODS.initialize, params: { protocolVersion: ACP_PROTOCOL_VERSION, clientName: "test", capabilities: {} } },
      { id: 2, method: ACP_METHODS.newSession, params: { workspace: ".", taskId: "m3-services", model: "fake" } },
      { id: 3, method: ACP_METHODS.prompt, params: { sessionId: "s1", content: "hello" } },
      { id: 4, method: ACP_METHODS.respondPermission, params: { sessionId: "s1", permissionId: "p1", decision: "deny" } },
      { id: 5, method: ACP_METHODS.cancelSession, params: { sessionId: "s1" } },
    ];
    for (const message of messages) {
      expect(decodeAcpMessage(JSON.stringify({ jsonrpc: "2.0", ...message }))).toMatchObject(message);
    }
  });

  it("round-trips a validated harness event notification", () => {
    const event = createEvent("permission.requested", {
      permissionId: "p1", sessionId: "s1", action: "process.exec", scope: "once",
    });
    const notification = acpEvent({ sessionId: "s1", seq: 2, event });
    expect(decodeAcpMessage(JSON.stringify(notification))).toEqual(notification);
  });

  it("rejects malformed JSON, unknown methods, bad params, and invalid events with typed errors", () => {
    const frames = [
      "{",
      { jsonrpc: "2.0", id: 1, method: "unknown", params: {} },
      { jsonrpc: "2.0", id: 1, method: "toString", params: {} },
      { jsonrpc: "2.0", id: 1, method: "constructor", params: {} },
      { jsonrpc: "2.0", id: 1, method: "__proto__", params: {} },
      { jsonrpc: "2.0", id: 1, method: ACP_METHODS.prompt, params: { sessionId: "s" } },
      { jsonrpc: "2.0", method: ACP_METHODS.sessionEvent, params: { sessionId: "s", seq: 0, event: { v: 99 } } },
    ];
    for (const frame of frames) {
      expect(() => decodeAcpMessage(typeof frame === "string" ? frame : JSON.stringify(frame))).toThrow(AcpProtocolError);
    }
  });

  it("uses own envelope discriminators even when an object's prototype is hostile", () => {
    const prototype = Object.create(null) as object;
    Object.defineProperty(prototype, "method", { value: "initialize", enumerable: false });
    const response = Object.assign(Object.create(prototype) as object, {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    expect(decodeAcpMessage(response)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("bounds identifiers, counters, result collections, and usage invariants", () => {
    const invalid = [
      { jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, method: ACP_METHODS.cancelSession, params: { sessionId: "s" } },
      { jsonrpc: "2.0", id: "x".repeat(257), method: ACP_METHODS.cancelSession, params: { sessionId: "s" } },
      {
        jsonrpc: "2.0",
        method: ACP_METHODS.sessionEvent,
        params: {
          sessionId: "s",
          seq: Number.MAX_SAFE_INTEGER + 1,
          event: createEvent("session.created", { sessionId: "s" }),
        },
      },
    ];
    for (const message of invalid) expect(() => decodeAcpMessage(message)).toThrow(AcpProtocolError);

    const oversizedModels = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentName: "agent",
      capabilities: {},
      models: Array.from({ length: 129 }, (_, index) => `model-${index}`),
    };
    expect(acpInitializeResultSchema.safeParse(oversizedModels).success).toBe(false);
    expect(acpPromptResultSchema.safeParse({
      status: "completed",
      events: [],
      finalText: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 3 },
    }).success).toBe(false);
  });
});

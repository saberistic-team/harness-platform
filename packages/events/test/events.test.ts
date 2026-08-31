import { describe, expect, it } from "vitest";
import {
  createEvent,
  deserializeEvent,
  serializeEvent,
  eventSchemas,
  redactEvent,
  redactValue,
  type AnyHarnessEvent,
  type EventType,
} from "../src";
import {
  EventParseError,
  EventSchemaError,
  EventVersionError,
  UnknownEventTypeError,
} from "../src/errors";

const FIXED_AT = "2026-01-02T03:04:05.000Z";
const FIXED_ID = "00000000-0000-4000-8000-000000000001";

/** One fully-populated sample per event type. */
function samples(): Array<{ type: EventType; event: AnyHarnessEvent }> {
  const opts = { eventId: FIXED_ID, at: FIXED_AT, actor: "system" };
  return [
    { type: "session.created", event: createEvent("session.created", { sessionId: "sess-1", workspace: "ws-1" }, opts) },
    { type: "agent.started", event: createEvent("agent.started", { agentId: "ag-1", sessionId: "sess-1", taskId: "kernel-0001", model: "fake-model/v1" }, opts) },
    { type: "agent.stopped", event: createEvent("agent.stopped", { agentId: "ag-1", status: "completed", steps: 3, toolCalls: 1 }, opts) },
    { type: "model.request", event: createEvent("model.request", { requestId: "req-1", model: "fake-model/v1", messageCount: 2 }, opts) },
    {
      type: "model.response",
      event: createEvent("model.response", { requestId: "req-1", model: "fake-model/v1", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }, opts),
    },
    { type: "tool.call", event: createEvent("tool.call", { callId: "call-1", tool: "read_file", input: { path: "README.md" } }, opts) },
    { type: "tool.result", event: createEvent("tool.result", { callId: "call-1", tool: "read_file", ok: true, output: "hello", durationMs: 3 }, opts) },
    { type: "task.updated", event: createEvent("task.updated", { taskId: "kernel-0001", phase: "running", note: "started" }, opts) },
    { type: "budget.warning", event: createEvent("budget.warning", { taskId: "kernel-0001", metric: "tokens", used: 50_000, limit: 100_000, pct: 50 }, opts) },
    { type: "policy.decision", event: createEvent("policy.decision", { action: "process.exec", subject: "pnpm test", effect: "allow", reason: "pattern pnpm test*", ruleId: "perm-1" }, opts) },
    { type: "permission.requested", event: createEvent("permission.requested", { permissionId: "perm-1", sessionId: "sess-1", callId: "call-1", action: "process.exec", subject: "pnpm install", scope: "once", reason: "operator approval required" }, opts) },
    { type: "permission.resolved", event: createEvent("permission.resolved", { permissionId: "perm-1", sessionId: "sess-1", callId: "call-1", action: "process.exec", subject: "pnpm install", scope: "once", decision: "deny", note: "operator denied" }, opts) },
    { type: "sandbox.started", event: createEvent("sandbox.started", { runId: "run-1", containerName: "ctr-1", image: "harness-sandbox:local", network: "none", mounts: 2 }, opts) },
    { type: "sandbox.stopped", event: createEvent("sandbox.stopped", { runId: "run-1", containerName: "ctr-1", status: "completed", exitCode: 0, durationMs: 12 }, opts) },
    { type: "run.recorded", event: createEvent("run.recorded", { runId: "run-1", taskId: "kernel-0001", status: "passed", reportPath: "tasks/runs/report.json" }, opts) },
    { type: "error", event: createEvent("error", { code: "MODEL_TIMEOUT", message: "timed out after 30s", retryable: true }, opts) },
  ];
}

describe("event round-trip", () => {
  it("serializes and deserializes every event type without data loss", () => {
    for (const { type, event } of samples()) {
      const wire = serializeEvent(event);
      const back = deserializeEvent(wire);
      expect(back, `round-trip of ${type}`).toEqual(event);
    }
  });

  it("produces stable field order on the wire", () => {
    const event = samples()[0]!;
    const wire = serializeEvent(event.event);
    const order = ["\"v\":1", '"type":"session.created"', `"eventId":"${FIXED_ID}"`, `"at":"${FIXED_AT}"`, '"actor":"system"', '"data":'];
    let last = -1;
    for (const needle of order) {
      const idx = wire.indexOf(needle);
      expect(idx, `expected ${needle} in ${wire}`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("every schema in the registry validates its own sample", () => {
    for (const { type, event } of samples()) {
      expect(eventSchemas[type].safeParse(event).success).toBe(true);
    }
  });
});

describe("process-boundary redaction", () => {
  it("redacts sensitive keys and inline credentials without mutating input", () => {
    const input = {
      authorization: "Bearer top-secret",
      nested: {
        api_key: "sk-proj-abcdefghijklmnop",
        "x-api-key": "top-secret-x-key",
        clientSecret: "client-secret-value",
        token: "generic-token-value",
        command: "OPENAI_API_KEY=sk-proj-abcdefghijklmnop pnpm test",
        log: "client_secret=visible-no-more token=also-hidden",
        headers: "Authorization: Basic dXNlcjpwYXNz\nCookie: session=abc123\nSet-Cookie: refresh=def456",
      },
    };
    const redacted = redactValue(input) as typeof input;
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.nested.api_key).toBe("[REDACTED]");
    expect(redacted.nested["x-api-key"]).toBe("[REDACTED]");
    expect(redacted.nested.clientSecret).toBe("[REDACTED]");
    expect(redacted.nested.token).toBe("[REDACTED]");
    expect(redacted.nested.command).not.toContain("abcdefghijklmnop");
    expect(redacted.nested.log).not.toContain("visible-no-more");
    expect(redacted.nested.log).not.toContain("also-hidden");
    expect(redacted.nested.headers).not.toContain("dXNlcjpwYXNz");
    expect(redacted.nested.headers).not.toContain("abc123");
    expect(redacted.nested.headers).not.toContain("def456");
    expect(input.authorization).toBe("Bearer top-secret");
  });

  it("returns a schema-valid redacted event copy", () => {
    const event = createEvent("tool.call", {
      callId: "call-1",
      tool: "http",
      input: { authorization: "Bearer top-secret", url: "https://example.test" },
    });
    const redacted = redactEvent(event);
    expect(redacted).not.toBe(event);
    expect((redacted.data.input as { authorization: string }).authorization).toBe("[REDACTED]");
    expect((event.data.input as { authorization: string }).authorization).toBe("Bearer top-secret");
  });

  it("bounds adversarial nesting without overflowing or dropping the event", () => {
    const input: Record<string, unknown> = {};
    let cursor = input;
    for (let depth = 0; depth < 20_000; depth++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const event = createEvent("tool.call", {
      callId: "call-deep",
      tool: "missing",
      input,
    });
    expect(() => redactEvent(event)).not.toThrow();
    expect(serializeEvent(redactEvent(event))).toContain("[REDACTED]");
  });
});

describe("deserialization gates", () => {
  it("rejects invalid JSON with EventParseError", () => {
    expect(() => deserializeEvent("not json")).toThrow(EventParseError);
  });

  it("rejects unsupported envelope versions with a typed EventVersionError", () => {
    const frame = {
      v: 99,
      type: "session.created",
      eventId: "e1",
      at: FIXED_AT,
      data: { sessionId: "s" },
    };
    let caught: unknown;
    try {
      deserializeEvent(serializeEvent(frame));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EventVersionError);
    expect((caught as EventVersionError).version).toBe(99);
  });

  it("rejects unknown event types with a typed UnknownEventTypeError", () => {
    const frame = {
      v: 1,
      type: "vendor.something.new",
      eventId: "e1",
      at: FIXED_AT,
      data: { x: 1 },
    };
    let caught: unknown;
    try {
      deserializeEvent(serializeEvent(frame));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownEventTypeError);
    expect((caught as UnknownEventTypeError).type).toBe("vendor.something.new");
  });

  it("rejects malformed payloads with EventSchemaError carrying field issues", () => {
    const frame = {
      v: 1,
      type: "model.response",
      eventId: "e1",
      at: FIXED_AT,
      data: { requestId: "r", model: "m", finishReason: "bogus", usage: {} },
    };
    let caught: unknown;
    try {
      deserializeEvent(serializeEvent(frame));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EventSchemaError);
    const issues = (caught as EventSchemaError).issues;
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["data.finishReason", "data.usage.promptTokens"]),
    );
  });

  it("rejects non-object frames with EventParseError", () => {
    expect(() => deserializeEvent(42)).toThrow(EventParseError);
    expect(() => deserializeEvent(null)).toThrow(EventParseError);
  });
});

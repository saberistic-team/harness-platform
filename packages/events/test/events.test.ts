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
    { type: "session.restored", event: createEvent("session.restored", { sessionId: "sess-1", afterSeq: 3, availableThroughSeq: 8, availableEvents: 5, outcome: "completed" }, opts) },
    { type: "agent.started", event: createEvent("agent.started", { agentId: "ag-1", sessionId: "sess-1", taskId: "kernel-0001", model: "fake-model/v1", runId: "run-1", turnId: "turn-1" }, opts) },
    { type: "agent.stopped", event: createEvent("agent.stopped", { agentId: "ag-1", status: "completed", steps: 3, toolCalls: 1, runId: "run-1", sessionId: "sess-1", turnId: "turn-1" }, opts) },
    { type: "turn.started", event: createEvent("turn.started", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", inputMessageId: "msg-user-1" }, opts) },
    { type: "message.delta", event: createEvent("message.delta", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", requestId: "req-1", messageId: "msg-assistant-1", role: "assistant", sequence: 0, delta: "hello" }, opts) },
    { type: "message.completed", event: createEvent("message.completed", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", requestId: "req-1", messageId: "msg-assistant-1", role: "assistant", content: "hello", finishReason: "stop", stateVersion: 1, messageRevision: 2 }, opts) },
    { type: "steering.queued", event: createEvent("steering.queued", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", messageId: "msg-steer-1", content: "also check the tests" }, opts) },
    { type: "context.compacted", event: createEvent("context.compacted", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", requestId: "req-compact-1", summaryMessageId: "msg-summary-1", summary: "Earlier work summarized.", beforeMessages: 20, afterMessages: 6, beforeTokens: 8_000, afterTokens: 2_000 }, opts) },
    { type: "turn.completed", event: createEvent("turn.completed", { runId: "run-1", sessionId: "sess-1", turnId: "turn-1", status: "completed", outputMessageId: "msg-assistant-1", modelRequests: 1, toolCalls: 0, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, stateVersion: 1, messageRevision: 2, note: "finished" }, opts) },
    { type: "model.request", event: createEvent("model.request", { requestId: "req-1", model: "fake-model/v1", messageCount: 2, runId: "run-1", sessionId: "sess-1", turnId: "turn-1", step: 1, contextVersion: 1, messageRevision: 1 }, opts) },
    {
      type: "model.response",
      event: createEvent("model.response", { requestId: "req-1", model: "fake-model/v1", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, runId: "run-1", sessionId: "sess-1", turnId: "turn-1" }, opts),
    },
    { type: "tool.call", event: createEvent("tool.call", { callId: "call-1", tool: "read_file", input: { path: "README.md" }, runId: "run-1", sessionId: "sess-1", turnId: "turn-1", requestId: "req-1", modelCallId: "model-call-1" }, opts) },
    { type: "tool.result", event: createEvent("tool.result", { callId: "call-1", tool: "read_file", ok: true, output: "hello", durationMs: 3, runId: "run-1", sessionId: "sess-1", turnId: "turn-1" }, opts) },
    { type: "task.updated", event: createEvent("task.updated", { taskId: "kernel-0001", phase: "running", note: "started" }, opts) },
    { type: "budget.warning", event: createEvent("budget.warning", { taskId: "kernel-0001", runId: "run-1", sessionId: "sess-1", turnId: "turn-1", metric: "steps", used: 4, limit: 8, pct: 50 }, opts) },
    { type: "policy.decision", event: createEvent("policy.decision", { taskId: "kernel-0001", sessionId: "sess-1", runId: "run-1", turnId: "turn-1", callId: "call-1", action: "process.exec", subject: "pnpm test", effect: "allow", reason: "pattern pnpm test*", ruleId: "perm-1" }, opts) },
    { type: "permission.requested", event: createEvent("permission.requested", { permissionId: "perm-1", sessionId: "sess-1", runId: "run-1", turnId: "turn-1", callId: "call-1", action: "process.exec", subject: "pnpm install", scope: "once", reason: "operator approval required" }, opts) },
    { type: "permission.resolved", event: createEvent("permission.resolved", { permissionId: "perm-1", sessionId: "sess-1", runId: "run-1", turnId: "turn-1", callId: "call-1", action: "process.exec", subject: "pnpm install", scope: "once", decision: "deny", note: "operator denied" }, opts) },
    { type: "sandbox.started", event: createEvent("sandbox.started", { runId: "run-1", containerName: "ctr-1", image: "harness-sandbox:local", network: "none", mounts: 2 }, opts) },
    { type: "sandbox.stopped", event: createEvent("sandbox.stopped", { runId: "run-1", containerName: "ctr-1", status: "completed", exitCode: 0, durationMs: 12 }, opts) },
    { type: "run.recorded", event: createEvent("run.recorded", { runId: "run-1", taskId: "kernel-0001", status: "passed", reportPath: "tasks/runs/report.json" }, opts) },
    { type: "run.scheduled", event: createEvent("run.scheduled", { runId: "run-1", taskId: "kernel-0001", attempt: 1, manifestDigest: "sha256:manifest" }, opts) },
    { type: "run.leased", event: createEvent("run.leased", { runId: "run-1", taskId: "kernel-0001", workerId: "worker-1", fencingToken: 1, expiresAt: "2026-01-02T03:05:05.000Z" }, opts) },
    { type: "run.updated", event: createEvent("run.updated", { runId: "run-1", taskId: "kernel-0001", change: "completed", status: "passed", previousStatus: "running", version: 5, attempt: 1, fencingToken: 1, reportPath: "tasks/runs/report.json" }, opts) },
    { type: "artifact.registered", event: createEvent("artifact.registered", { artifactId: "artifact-1", kind: "audit", bucket: "harness", key: "audit/task/run.jsonl", sha256: "a".repeat(64), bytes: 42, contentType: "application/x-ndjson", taskId: "kernel-0001", runId: "run-1", sessionId: "sess-1" }, opts) },
    { type: "audit.exported", event: createEvent("audit.exported", { exportId: "export-1", artifactId: "artifact-1", fromSeq: 0, toSeq: 9, eventCount: 10, sha256: "a".repeat(64) }, opts) },
    { type: "error", event: createEvent("error", { code: "MODEL_TIMEOUT", message: "timed out after 30s", retryable: true, taskId: "kernel-0001", sessionId: "sess-1", runId: "run-1", stage: "builder" }, opts) },
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

  it("stably serializes runtime message identity and chunk order", () => {
    const event = samples().find((sample) => sample.type === "message.delta")!.event;
    expect(serializeEvent(event)).toBe(
      `{"v":1,"type":"message.delta","eventId":"${FIXED_ID}","at":"${FIXED_AT}","actor":"system","data":{"runId":"run-1","sessionId":"sess-1","turnId":"turn-1","requestId":"req-1","messageId":"msg-assistant-1","role":"assistant","sequence":0,"delta":"hello"}}`,
    );
  });

  it("every schema in the registry validates its own sample", () => {
    expect(samples().map(({ type }) => type)).toEqual(Object.keys(eventSchemas));
    for (const { type, event } of samples()) {
      expect(eventSchemas[type].safeParse(event).success).toBe(true);
    }
  });

  it("continues to decode legacy runtime payloads without M7 optional fields", () => {
    const opts = { eventId: FIXED_ID, at: FIXED_AT, actor: "kernel" };
    const legacy = [
      createEvent("agent.started", {
        agentId: "ag-1",
        sessionId: "sess-1",
        model: "fake-model/v1",
      }, opts),
      createEvent("agent.stopped", {
        agentId: "ag-1",
        status: "completed",
        steps: 1,
        toolCalls: 0,
      }, opts),
      createEvent("message.completed", {
        runId: "run-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        messageId: "msg-user-1",
        role: "user",
        content: "hello",
      }, opts),
      createEvent("turn.completed", {
        runId: "run-1",
        sessionId: "sess-1",
        turnId: "turn-1",
        status: "completed",
        modelRequests: 1,
        toolCalls: 0,
      }, opts),
      createEvent("model.request", {
        requestId: "req-1",
        model: "fake-model/v1",
        messageCount: 1,
      }, opts),
      createEvent("model.response", {
        requestId: "req-1",
        model: "fake-model/v1",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }, opts),
      createEvent("tool.call", {
        callId: "call-1",
        tool: "echo",
        input: {},
      }, opts),
      createEvent("tool.result", {
        callId: "call-1",
        tool: "echo",
        ok: true,
        output: "ok",
      }, opts),
      createEvent("budget.warning", {
        metric: "tokens",
        used: 5,
        limit: 10,
        pct: 50,
      }, opts),
      createEvent("permission.requested", {
        permissionId: "perm-1",
        sessionId: "sess-1",
        action: "network",
        scope: "once",
      }, opts),
      createEvent("permission.resolved", {
        permissionId: "perm-1",
        sessionId: "sess-1",
        action: "network",
        scope: "once",
        decision: "deny",
      }, opts),
    ];

    for (const event of legacy) {
      expect(deserializeEvent(serializeEvent(event))).toEqual(event);
    }
  });

  it("continues to decode legacy policy decisions without attribution", () => {
    const legacy = createEvent("policy.decision", {
      action: "process.exec",
      subject: "pnpm test",
      effect: "allow",
      reason: "legacy producer",
    }, {
      eventId: FIXED_ID,
      at: FIXED_AT,
      actor: "kernel",
    });

    expect(deserializeEvent(serializeEvent(legacy))).toEqual(legacy);
  });

  it("rejects partial policy-decision attribution", () => {
    expect(() => deserializeEvent(JSON.stringify({
      v: 1,
      type: "policy.decision",
      eventId: FIXED_ID,
      at: FIXED_AT,
      actor: "harness-cli",
      data: {
        taskId: "kernel-0001",
        action: "process.exec",
        effect: "allow",
      },
    }))).toThrow();
  });

  it("rejects semantically impossible run.updated transitions", () => {
    const invalid = {
      v: 1,
      type: "run.updated",
      eventId: FIXED_ID,
      at: FIXED_AT,
      data: {
        runId: "run-1",
        taskId: "task-1",
        change: "started",
        previousStatus: "leased",
        status: "queued",
        version: 2,
        attempt: 1,
        fencingToken: 1,
      },
    };
    expect(eventSchemas["run.updated"].safeParse(invalid).success).toBe(false);
  });

  it("round-trips the strict user-message variant without model-only fields", () => {
    const event = createEvent("message.completed", {
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      messageId: "msg-user-1",
      role: "user",
      content: "diagnose the repository",
    }, {
      eventId: FIXED_ID,
      at: FIXED_AT,
      actor: "kernel",
    });

    expect(deserializeEvent(serializeEvent(event))).toEqual(event);
  });

  it("round-trips a strict versioned tool observation message", () => {
    const event = createEvent("message.completed", {
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      messageId: "msg-tool-1",
      role: "tool",
      name: "echo",
      toolCallId: "model-call-1",
      content: "{\"ok\":true}",
      stateVersion: 1,
      messageRevision: 3,
    }, {
      eventId: FIXED_ID,
      at: FIXED_AT,
      actor: "kernel",
    });

    expect(deserializeEvent(serializeEvent(event))).toEqual(event);
  });
});

describe("runtime event schemas", () => {
  const envelope = (type: EventType, data: Record<string, unknown>) => ({
    v: 1,
    type,
    eventId: FIXED_ID,
    at: FIXED_AT,
    actor: "kernel",
    data,
  });

  const identity = {
    runId: "run-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    messageId: "msg-1",
  };

  it("rejects model-only fields on user messages and missing request identity on assistant messages", () => {
    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      requestId: "req-1",
      role: "user",
      content: "hello",
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      role: "assistant",
      content: "hello",
      finishReason: "stop",
    }))).toThrow(EventSchemaError);
  });

  it("requires paired version and revision fields on messages and model context", () => {
    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      role: "user",
      content: "hello",
      stateVersion: 1,
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      role: "tool",
      name: "echo",
      toolCallId: "model-call-1",
      content: "ok",
      messageRevision: 2,
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("model.request", {
      requestId: "req-1",
      model: "fake-model/v1",
      messageCount: 1,
      contextVersion: 1,
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("model.request", {
      requestId: "req-1",
      model: "fake-model/v1",
      messageCount: 1,
      messageRevision: 1,
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("turn.completed", {
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      status: "completed",
      modelRequests: 1,
      toolCalls: 0,
      stateVersion: 1,
    }))).toThrow(EventSchemaError);
  });

  it("rejects malformed tool observations and unsafe request revisions", () => {
    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      role: "tool",
      name: "echo",
      content: "ok",
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("message.completed", {
      ...identity,
      role: "tool",
      name: "echo",
      toolCallId: "model-call-1",
      requestId: "req-1",
      content: "ok",
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("model.request", {
      requestId: "req-1",
      model: "fake-model/v1",
      messageCount: 1,
      step: 0,
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("model.request", {
      requestId: "req-1",
      model: "fake-model/v1",
      messageCount: 1,
      contextVersion: 1,
      messageRevision: Number.MAX_SAFE_INTEGER + 1,
    }))).toThrow(EventSchemaError);
  });

  it("rejects empty or out-of-order-shaped message deltas", () => {
    expect(() => deserializeEvent(envelope("message.delta", {
      ...identity,
      requestId: "req-1",
      role: "assistant",
      sequence: -1,
      delta: "",
    }))).toThrow(EventSchemaError);
  });

  it("requires compaction to reduce context and token counts to be paired", () => {
    const compacted = {
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      summaryMessageId: "msg-summary-1",
      summary: "summary",
      beforeMessages: 4,
      afterMessages: 4,
      beforeTokens: 100,
    };
    expect(() => deserializeEvent(envelope("context.compacted", compacted))).toThrow(EventSchemaError);
  });

  it("rejects empty or oversized steering messages and unknown terminal statuses", () => {
    expect(() => deserializeEvent(envelope("steering.queued", {
      ...identity,
      content: "",
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("steering.queued", {
      ...identity,
      content: "x".repeat(256 * 1024 + 1),
    }))).toThrow(EventSchemaError);

    expect(() => deserializeEvent(envelope("turn.completed", {
      runId: "run-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      status: "paused",
      modelRequests: 1,
      toolCalls: 0,
    }))).toThrow(EventSchemaError);
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

  it("rejects non-timestamp envelope and lease dates", () => {
    const invalidEnvelope = {
      ...samples()[0]!.event,
      at: "eventually",
    };
    expect(() => deserializeEvent(serializeEvent(invalidEnvelope))).toThrow(EventSchemaError);

    const leaseSample = samples().find((sample) => sample.type === "run.leased")!.event;
    const invalidLease = {
      ...leaseSample,
      data: { ...(leaseSample.data as Record<string, unknown>), expiresAt: "later" },
    };
    expect(() => deserializeEvent(serializeEvent(invalidLease))).toThrow(EventSchemaError);
  });

  it("rejects unknown envelope and data fields instead of stripping them", () => {
    const sample = samples()[0]!.event;
    expect(() => deserializeEvent({ ...sample, surprise: true })).toThrow(EventSchemaError);
    expect(() => deserializeEvent({
      ...sample,
      data: { ...sample.data, surprise: true },
    })).toThrow(EventSchemaError);
  });

  it("rejects non-object frames with EventParseError", () => {
    expect(() => deserializeEvent(42)).toThrow(EventParseError);
    expect(() => deserializeEvent(null)).toThrow(EventParseError);
  });
});

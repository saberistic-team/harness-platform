import { describe, expect, it } from "vitest";
import {
  createEvent,
  serializeEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import type {
  AcpInitializeParams,
  AcpNewSessionResult,
  AcpPromptParams,
  AcpPromptResult,
} from "@harness/acp";
import {
  createConfirmation,
  isExplicitAllow,
  parseConnectArgs,
  permissionQuestion,
  runConnectCommand,
  runInteractive,
  type AcpEventNotification,
  type InteractiveAcpClient,
  type PermissionRequestedEvent,
  type PermissionResolvedEvent,
  type PermissionResponseParams,
} from "../src/interactive";
import { eventSummary, renderEventLine, terminalSafeJson } from "../src/render";

const AT = "2026-08-31T12:00:00.000Z";

function requested(): PermissionRequestedEvent {
  return {
    v: 1,
    type: "permission.requested",
    eventId: "evt-permission-requested",
    at: AT,
    actor: "agent-server",
    data: {
      permissionId: "perm-1",
      sessionId: "sess-1",
      callId: "call-1",
      action: "process.exec",
      subject: "pnpm test",
      scope: "once",
      reason: "manifest rule requires operator approval",
    },
  };
}

function resolved(decision: "allow" | "deny"): PermissionResolvedEvent {
  return {
    v: 1,
    type: "permission.resolved",
    eventId: `evt-permission-${decision}`,
    at: AT,
    actor: "harness-view",
    data: {
      ...requested().data,
      decision,
    },
  };
}

class FakeClient implements InteractiveAcpClient {
  initializeParams?: AcpInitializeParams;
  sessionParams?: { workspace: string; taskId?: string; model?: string };
  promptParams?: AcpPromptParams;
  responses: PermissionResponseParams[] = [];
  cancellations: Array<{ sessionId: string }> = [];
  closed = false;
  mode: "permission" | "pending" = "permission";
  onPrompt?: () => void;
  resolutionDecisionOverride?: "allow" | "deny";
  stoppedStatus: "completed" | "failed" | "canceled" | "budget_exceeded" = "completed";
  resultStatus: "completed" | "failed" = "completed";
  finalText = "final answer";
  transcriptOverride?: string[];
  unsubscribeThrows = false;
  closeThrows = false;
  private listeners = new Set<(notification: AcpEventNotification) => void>();
  private releasePermission?: () => void;

  async initialize(params: AcpInitializeParams) {
    this.initializeParams = params;
    return {
      protocolVersion: params.protocolVersion,
      agentName: "fake-agent-server",
      capabilities: { streaming: true, permissioning: true, sessions: true },
      models: ["fake-model"],
    };
  }

  async newSession(params: {
    workspace: string;
    taskId?: string;
    model?: string;
  }): Promise<AcpNewSessionResult> {
    this.sessionParams = params;
    return { sessionId: "sess-1" };
  }

  async prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    this.promptParams = params;
    this.onPrompt?.();
    if (this.mode === "pending") return new Promise(() => undefined);

    const started = createEvent(
      "agent.started",
      {
        agentId: "agent-1",
        sessionId: "sess-1",
        taskId: "m3-services",
        model: "fake-model",
      },
      { eventId: "evt-started", at: AT },
    );
    this.emit(0, started);
    this.emit(1, requested());

    await new Promise<void>((resolve) => {
      this.releasePermission = resolve;
    });

    const decision = this.resolutionDecisionOverride ?? this.responses[0]?.decision ?? "deny";
    this.emit(2, resolved(decision));
    const stopped = createEvent(
      "agent.stopped",
      { agentId: "agent-1", status: this.stoppedStatus, steps: 1, toolCalls: 1 },
      { eventId: "evt-stopped", at: AT },
    );
    this.emit(3, stopped);

    return {
      status: this.resultStatus,
      // The first event is deliberately duplicated from the stream.
      events: this.transcriptOverride ?? [serializeEvent(started), serializeEvent(stopped)],
      finalText: this.finalText,
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    };
  }

  async respondPermission(params: PermissionResponseParams): Promise<void> {
    this.responses.push(params);
    this.releasePermission?.();
  }

  async cancelSession(params: { sessionId: string }): Promise<void> {
    this.cancellations.push(params);
  }

  onEvent(listener: (notification: AcpEventNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.unsubscribeThrows) throw new Error("unsubscribe failed");
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closeThrows) throw new Error("close failed");
  }

  emit(seq: number, event: AnyHarnessEvent | PermissionRequestedEvent | PermissionResolvedEvent) {
    for (const listener of this.listeners) {
      listener({ sessionId: "sess-1", seq, event });
    }
  }
}

describe("explicit confirmation", () => {
  it("allows only y or yes, case-insensitively", () => {
    for (const value of ["y", "Y", "yes", " YES "]) {
      expect(isExplicitAllow(value), value).toBe(true);
    }
    for (const value of [undefined, "", "n", "no", "true", "allow", "yep"]) {
      expect(isExplicitAllow(value), String(value)).toBe(false);
    }
  });

  it("fails closed for empty, invalid, EOF, reader errors, and noninteractive input", async () => {
    const request = requested().data;
    expect(await createConfirmation(async () => "", true)(request)).toBe(false);
    expect(await createConfirmation(async () => "maybe", true)(request)).toBe(false);
    expect(await createConfirmation(async () => undefined, true)(request)).toBe(false);
    expect(
      await createConfirmation(async () => {
        throw new Error("stdin closed");
      }, true)(request),
    ).toBe(false);

    let reads = 0;
    const noninteractive = createConfirmation(async () => {
      reads++;
      return "yes";
    }, false);
    expect(await noninteractive(request)).toBe(false);
    expect(reads).toBe(0);
  });

  it("renders untrusted permission text as inert single-line terminal text", () => {
    const question = permissionQuestion({
      ...requested().data,
      action: "process.exec\nAllow everything?",
      subject: "\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007",
      reason: "\u001b[2Jspoof",
    });
    expect(question).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(question).toContain("\\u{A}");
    expect(question).toContain("\\u{1B}");

    const event = requested();
    event.data.subject = "safe\nFAKE APPROVAL\u001b[2J";
    const rendered = renderEventLine(1, event);
    expect(rendered).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(rendered).toContain("\\u{A}");
  });

  it("escapes bidi controls while keeping raw JSON valid", () => {
    const unsafe = "safe\u061c\u200f\u202eevil";
    const raw = terminalSafeJson({ value: unsafe });
    expect(raw).not.toMatch(/[\u061c\u200f\u202e]/u);
    expect(JSON.parse(raw)).toEqual({ value: unsafe });
  });
});

describe("connect argument parsing", () => {
  it("parses URL, workspace, task, model, and prompt words", () => {
    expect(
      parseConnectArgs(
        [
          "ws://127.0.0.1:7777",
          "--workspace",
          ".",
          "--task",
          "m3-services",
          "--model",
          "fake-model",
          "do",
          "the",
          "thing",
        ],
        "/work/repo",
        {},
      ),
    ).toEqual({
      url: "ws://127.0.0.1:7777",
      workspace: "/work/repo",
      taskId: "m3-services",
      model: "fake-model",
      prompt: "do the thing",
    });
  });

  it("adds an explicit or environment token only to the connection URL", async () => {
    expect(parseConnectArgs(
      ["ws://127.0.0.1/acp", "--workspace", "."],
      "/work/repo",
      { HARNESS_AGENT_TOKEN: "from-env" },
    )).toMatchObject({ token: "from-env" });
    expect(parseConnectArgs(
      ["ws://127.0.0.1/acp", "--workspace", ".", "--token", "from-flag"],
      "/work/repo",
      { HARNESS_AGENT_TOKEN: "from-env" },
    )).toMatchObject({ token: "from-flag" });

    const client = new FakeClient();
    let connectedUrl = "";
    await runInteractive(
      {
        url: "ws://127.0.0.1/acp?existing=1",
        token: "s e c r e t",
        workspace: "/work/repo",
        prompt: "hello",
      },
      {
        connect: async (url) => {
          connectedUrl = url;
          return client;
        },
        out: () => undefined,
      },
    );
    const parsed = new URL(connectedUrl);
    expect(parsed.searchParams.get("token")).toBe("s e c r e t");
    expect(parsed.searchParams.get("existing")).toBe("1");
  });

  it("rejects missing workspace, non-WebSocket URLs, and unknown flags", () => {
    expect(() => parseConnectArgs(["ws://127.0.0.1", "prompt"], undefined, {})).toThrow(/--workspace/);
    expect(() => parseConnectArgs(["https://host", "--workspace", "."], undefined, {})).toThrow(/ws:\/\//);
    expect(() => parseConnectArgs(["ws://127.0.0.1", "--workspace", ".", "--bogus"], undefined, {})).toThrow(
      /unknown connect option/,
    );
  });

  it("requires encrypted transport off loopback and rejects URL credentials", () => {
    expect(
      parseConnectArgs(["wss://agent.example/acp", "--workspace", "."], "/work", {}),
    ).toMatchObject({ url: "wss://agent.example/acp" });
    expect(() =>
      parseConnectArgs(["ws://agent.example/acp", "--workspace", "."], "/work", {}),
    ).toThrow(/require wss:\/\//);

    let message = "";
    try {
      parseConnectArgs(
        ["wss://operator:top-secret@agent.example/acp", "--workspace", "."],
        "/work",
        {},
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("must not contain username or password");
    expect(message).not.toContain("top-secret");
  });

  it("redacts URL and flag tokens from transport errors", async () => {
    const errors: string[] = [];
    const code = await runConnectCommand(
      [
        "wss://agent.example/acp?token=query-secret",
        "--workspace",
        ".",
        "--token",
        "flag secret",
        "hello",
      ],
      {
        env: {},
        connect: async (url) => {
          throw new Error(`connection failed at ${url}; credential=flag secret; old=query-secret`);
        },
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).not.toContain("flag secret");
    expect(errors.join("\n")).not.toContain("query-secret");
    expect(errors.join("\n")).toContain("[REDACTED]");
  });

  it("redacts a reflected connection token from server-provided output", async () => {
    const client = new FakeClient();
    client.finalText = "server accidentally echoed bearer-secret";
    const lines: string[] = [];
    const code = await runInteractive(
      {
        url: "ws://127.0.0.1/acp",
        token: "bearer-secret",
        workspace: "/work/repo",
        prompt: "hello",
      },
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: (line) => lines.push(line),
      },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("bearer-secret");
    expect(lines.join("\n")).toContain("[REDACTED]");
  });
});

describe("interactive ACP runner", () => {
  it("creates a session, streams events, approves exact IDs, and renders final text", async () => {
    const client = new FakeClient();
    const lines: string[] = [];
    const seenRequests: unknown[] = [];

    const code = await runInteractive(
      {
        url: "ws://127.0.0.1:7777",
        workspace: "/work/repo",
        taskId: "m3-services",
        model: "fake-model",
        prompt: "run the tests",
      },
      {
        connect: async () => client,
        confirmPermission: async (request) => {
          seenRequests.push(request);
          return true;
        },
        out: (line) => lines.push(line),
      },
    );

    expect(code).toBe(0);
    expect(client.initializeParams?.capabilities.permissioning).toBe(true);
    expect(client.sessionParams).toEqual({
      workspace: "/work/repo",
      taskId: "m3-services",
      model: "fake-model",
    });
    expect(client.promptParams).toEqual({ sessionId: "sess-1", content: "run the tests" });
    expect(seenRequests).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        permissionId: "perm-1",
        callId: "call-1",
        action: "process.exec",
      }),
    ]);
    expect(client.responses).toEqual([
      {
        sessionId: "sess-1",
        permissionId: "perm-1",
        decision: "allow",
        note: "approved by harness-view",
      },
    ]);
    const output = lines.join("\n");
    expect(output).toContain("permission.requested");
    expect(output).toContain("permission.resolved");
    expect(output).toContain("final answer");
    expect(output.match(/agent\.started/g)).toHaveLength(1);
    expect(output.match(/agent\.stopped/g)).toHaveLength(1);
    expect(client.closed).toBe(true);
  });

  it("deduplicates identical transcript events but rejects event-id collisions", async () => {
    const client = new FakeClient();
    const conflicting = createEvent(
      "error",
      { code: "SPOOF", message: "different payload", retryable: false },
      { eventId: "evt-started", at: AT },
    );
    client.transcriptOverride = [serializeEvent(conflicting)];
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", ".", "go"],
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: () => undefined,
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("conflicts with the streamed event");
    expect(client.closed).toBe(true);
  });

  it("rejects an oversized completion transcript", async () => {
    const client = new FakeClient();
    const event = serializeEvent(createEvent(
      "error",
      { code: "EXCESS", message: "too many", retryable: false },
      { eventId: "evt-excess", at: AT },
    ));
    client.transcriptOverride = Array<string>(10_001).fill(event);
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", ".", "go"],
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: () => undefined,
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("exceeded 10000 total events");
  });

  it("denies an ask when confirmation is not explicit", async () => {
    const client = new FakeClient();
    const code = await runInteractive(
      {
        url: "ws://127.0.0.1",
        workspace: "/work/repo",
        prompt: "try it",
      },
      {
        connect: async () => client,
        confirmPermission: createConfirmation(async () => "no", true),
        out: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(client.responses[0]).toMatchObject({
      sessionId: "sess-1",
      permissionId: "perm-1",
      decision: "deny",
    });
  });

  it("requires an exact boolean true from an injected confirmation", async () => {
    const client = new FakeClient();
    await runInteractive(
      {
        url: "ws://127.0.0.1",
        workspace: "/work/repo",
        prompt: "try it",
      },
      {
        connect: async () => client,
        confirmPermission: (() => "yes") as unknown as () => boolean,
        out: () => undefined,
      },
    );
    expect(client.responses[0]?.decision).toBe("deny");
  });

  it("cancels the exact session and closes the client on abort", async () => {
    const client = new FakeClient();
    client.mode = "pending";
    const abort = new AbortController();
    client.onPrompt = () => abort.abort();

    const code = await runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "wait" },
      {
        connect: async () => client,
        signal: abort.signal,
        out: () => undefined,
      },
    );

    expect(code).toBe(130);
    expect(client.cancellations).toEqual([{ sessionId: "sess-1" }]);
    expect(client.closed).toBe(true);
  });

  it("reports cancellation when aborted during connection setup", async () => {
    const abort = new AbortController();
    const codePromise = runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "wait" },
      {
        signal: abort.signal,
        connect: (_url, connectOptions) => new Promise((_resolve, reject) => {
          connectOptions?.signal?.addEventListener(
            "abort",
            () => reject(new Error("transport closed")),
            { once: true },
          );
        }),
        out: () => undefined,
      },
    );
    abort.abort();
    await expect(codePromise).resolves.toBe(130);
  });

  it("aborts while confirmation is pending without sending a late allow", async () => {
    const client = new FakeClient();
    const abort = new AbortController();
    let resolveConfirmation!: (allowed: boolean) => void;
    let confirmationStarted!: () => void;
    const beganConfirming = new Promise<void>((resolve) => {
      confirmationStarted = resolve;
    });
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });

    const codePromise = runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "wait" },
      {
        connect: async () => client,
        signal: abort.signal,
        confirmPermission: () => {
          confirmationStarted();
          return confirmation;
        },
        out: () => undefined,
      },
    );
    await beganConfirming;
    abort.abort();
    await expect(codePromise).resolves.toBe(130);
    resolveConfirmation(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.responses).toEqual([]);
    expect(client.cancellations).toEqual([{ sessionId: "sess-1" }]);
    expect(client.closed).toBe(true);
  });

  it("aborts prompt input without connecting", async () => {
    const abort = new AbortController();
    let promptStarted!: () => void;
    const beganPrompt = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    let connected = false;
    const codePromise = runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo" },
      {
        signal: abort.signal,
        readPrompt: () => {
          promptStarted();
          return new Promise(() => undefined);
        },
        connect: async () => {
          connected = true;
          return new FakeClient();
        },
      },
    );
    await beganPrompt;
    abort.abort();
    await expect(codePromise).resolves.toBe(130);
    expect(connected).toBe(false);
  });

  it("closes a client that arrives after connection cancellation", async () => {
    const abort = new AbortController();
    const client = new FakeClient();
    let resolveConnect!: (value: InteractiveAcpClient) => void;
    let connectStarted!: () => void;
    const beganConnect = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    const connecting = new Promise<InteractiveAcpClient>((resolve) => {
      resolveConnect = resolve;
    });
    const codePromise = runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "wait" },
      {
        signal: abort.signal,
        connect: async () => {
          connectStarted();
          return connecting;
        },
        out: () => undefined,
      },
    );
    await beganConnect;
    abort.abort();
    await expect(codePromise).resolves.toBe(130);
    resolveConnect(client);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.closed).toBe(true);
  });

  it("fails closed on a gap in the streamed event sequence", async () => {
    const client = new FakeClient();
    client.mode = "pending";
    client.onPrompt = () => {
      client.emit(1, createEvent(
        "agent.started",
        { agentId: "agent-1", sessionId: "sess-1", model: "fake-model" },
        { eventId: "evt-gap", at: AT },
      ));
    };
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", ".", "go"],
      {
        connect: async () => client,
        out: () => undefined,
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("expected session event sequence 0");
    expect(client.cancellations).toEqual([{ sessionId: "sess-1" }]);
    expect(client.closed).toBe(true);
  });

  it("rejects a permission resolution that differs from the submitted decision", async () => {
    const client = new FakeClient();
    client.resolutionDecisionOverride = "deny";
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", ".", "go"],
      {
        connect: async () => client,
        confirmPermission: async () => true,
        out: () => undefined,
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("does not match the submitted decision");
    expect(client.closed).toBe(true);
  });

  it("maps failed runs to exit 2 and validates the terminal event status", async () => {
    const client = new FakeClient();
    client.stoppedStatus = "failed";
    client.resultStatus = "failed";
    const code = await runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "go" },
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: () => undefined,
      },
    );
    expect(code).toBe(2);
    expect(client.closed).toBe(true);
  });

  it("rejects a successful terminal event paired with a failed prompt result", async () => {
    const client = new FakeClient();
    client.resultStatus = "failed";
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", ".", "go"],
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: () => undefined,
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("status conflicts");
  });

  it("still closes the transport when unsubscribe or close throws", async () => {
    const client = new FakeClient();
    client.unsubscribeThrows = true;
    client.closeThrows = true;
    const code = await runInteractive(
      { url: "ws://127.0.0.1", workspace: "/work/repo", prompt: "go" },
      {
        connect: async () => client,
        confirmPermission: async () => false,
        out: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(client.closed).toBe(true);
  });

  it("treats prompt EOF as a usage exit without connecting", async () => {
    let connected = false;
    const errors: string[] = [];
    const code = await runConnectCommand(
      ["ws://127.0.0.1", "--workspace", "."],
      {
        readPrompt: async () => undefined,
        connect: async () => {
          connected = true;
          return new FakeClient();
        },
        err: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(connected).toBe(false);
    expect(errors.join("\n")).toContain("prompt text");
  });

  it("returns usage errors without connecting", async () => {
    let connected = false;
    const errs: string[] = [];
    const code = await runConnectCommand(["ws://127.0.0.1"], {
      connect: async () => {
        connected = true;
        return new FakeClient();
      },
      err: (line) => errs.push(line),
    });
    expect(code).toBe(1);
    expect(connected).toBe(false);
    expect(errs.join("\n")).toContain("--workspace");
  });
});

describe("permission rendering", () => {
  it("summarizes requests and resolutions with their audit IDs", () => {
    expect(eventSummary(requested())).toContain("permission=perm-1");
    expect(eventSummary(requested())).toContain("process.exec → ask");
    expect(eventSummary(resolved("allow"))).toContain("process.exec → allow");
  });
});

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  McpClientError,
  McpStdioClient,
  isMcpResponse,
  mcpNotification,
  mcpProtocolVersion,
  mcpRequest,
  mcpResponse,
  type McpNotification,
} from "../src/index.js";

const fixturePath = fileURLToPath(
  new URL("./fixture-server.mjs", import.meta.url),
);
const clients = new Set<McpStdioClient>();

function fixtureClient(
  options: ConstructorParameters<typeof McpStdioClient>[1] = {},
  env?: NodeJS.ProcessEnv,
): McpStdioClient {
  const client = new McpStdioClient(
    {
      command: process.execPath,
      args: [fixturePath],
      ...(env === undefined ? {} : { env }),
    },
    options,
  );
  clients.add(client);
  return client;
}

async function expectCode(
  promise: Promise<unknown>,
  code: McpClientError["code"],
): Promise<McpClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(McpClientError);
    expect(error).toMatchObject({ code });
    return error as McpClientError;
  }
  throw new Error(`Expected promise to reject with ${code}`);
}

afterEach(async () => {
  await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
});

describe("MCP protocol envelopes", () => {
  it("requires exactly one result or error on responses", () => {
    expect(mcpProtocolVersion).toBe("2025-11-25");
    expect(
      isMcpResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    ).toBe(true);
    expect(
      isMcpResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "missing" },
      }),
    ).toBe(true);
    expect(mcpResponse.safeParse({ jsonrpc: "2.0", id: 1 }).success).toBe(
      false,
    );
    expect(
      mcpResponse.safeParse({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -32603, message: "both" },
      }).success,
    ).toBe(false);
    expect(
      mcpResponse.safeParse({ jsonrpc: "2.0", id: 1, result: null }).success,
    ).toBe(false);
    expect(
      mcpResponse.safeParse({
        jsonrpc: "2.0",
        error: { code: -32600, message: "uncorrelated" },
      }).success,
    ).toBe(true);
    expect(
      mcpRequest.safeParse({
        jsonrpc: "2.0",
        id: 1.5,
        method: "ping",
      }).success,
    ).toBe(false);
    expect(
      mcpNotification.safeParse({
        jsonrpc: "2.0",
        id: 1,
        method: "notifications/message",
      }).success,
    ).toBe(false);
  });
});

describe("McpStdioClient", () => {
  it("initializes, handles fragmented/coalesced frames, and calls tools", async () => {
    const notifications: string[] = [];
    const client = fixtureClient({
      onNotification: (notification) => {
        notifications.push(notification.method);
      },
    });

    await client.start();
    expect(client.state).toBe("running");
    await expectCode(client.listTools(), "MCP_NOT_INITIALIZED");

    const [initialized, concurrentInitialize] = await Promise.all([
      client.initialize(),
      client.initialize(),
    ]);
    expect(initialized).toMatchObject({
      protocolVersion: "2025-11-25",
      serverInfo: { name: "harness-mcp-fixture", version: "0.1.0" },
    });
    expect(concurrentInitialize).toBe(initialized);
    expect(await client.initialize()).toBe(initialized);
    expect(client.state).toBe("initialized");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "add",
      "fail",
      "stall",
      "malformed",
      "crash",
      "delayed-echo",
      "client-ping",
      "client-unknown",
    ]);
    expect(notifications).toContain("notifications/message");

    const echo = await client.callTool("echo", { message: "harness" });
    expect(echo.content).toEqual([{ type: "text", text: "Echo: harness" }]);

    const add = await client.callTool("add", { a: 20, b: 22 });
    expect(add.structuredContent).toEqual({ sum: 42 });

    const failed = await client.callTool("fail");
    expect(failed).toMatchObject({ isError: true });
    await client.ping();
    expect(await client.request("fixture/stats")).toEqual({
      initializeCount: 1,
    });

    await client.close();
    await client.close();
    expect(client.state).toBe("closed");
    await expectCode(client.ping(), "MCP_CLOSED");
  });

  it("correlates concurrent responses that arrive out of order", async () => {
    const client = fixtureClient();
    await client.initialize();

    const completionOrder: string[] = [];
    const slow = client
      .callTool("delayed-echo", { message: "slow", delayMs: 60 })
      .then((result) => {
        completionOrder.push("slow");
        return result;
      });
    const fast = client
      .callTool("delayed-echo", { message: "fast", delayMs: 5 })
      .then((result) => {
        completionOrder.push("fast");
        return result;
      });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(completionOrder).toEqual(["fast", "slow"]);
    expect(slowResult.content[0]).toMatchObject({ text: "slow" });
    expect(fastResult.content[0]).toMatchObject({ text: "fast" });
  });

  it("answers server ping requests and rejects unknown client methods", async () => {
    const client = fixtureClient();
    await client.initialize();

    const ping = await client.callTool("client-ping");
    expect(ping.structuredContent).toEqual({ answered: true });
    const unknown = await client.callTool("client-unknown");
    expect(unknown.structuredContent).toEqual({ rpcCode: -32601 });
    await client.ping();
  });

  it("enforces frame limits per line, not per coalesced stdout write", async () => {
    const notifications: McpNotification[] = [];
    const client = fixtureClient({
      maxFrameBytes: 900,
      onNotification: (notification) => {
        notifications.push(notification);
      },
    });
    await client.initialize();

    await expect(client.request("fixture/coalesced")).resolves.toEqual({
      ok: true,
    });
    expect(notifications).toHaveLength(2);
    await client.ping();
  });

  it("contains rejected async notification observers", async () => {
    const client = fixtureClient({
      onNotification: async () => {
        throw new Error("observer failure");
      },
    });
    await client.initialize();
    await client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.ping();
    expect(client.state).toBe("initialized");
  });

  it("surfaces JSON-RPC errors without corrupting the connection", async () => {
    const client = fixtureClient();
    await client.initialize();

    const error = await expectCode(
      client.callTool("does-not-exist"),
      "MCP_RPC_ERROR",
    );
    expect(error.details).toMatchObject({ rpcCode: -32602 });
    await expectCode(client.request("fixture/unknown"), "MCP_RPC_ERROR");
    await client.ping();
  });

  it("times out a request, ignores its late response, and stays usable", async () => {
    const client = fixtureClient({ requestTimeoutMs: 1_000 });
    await client.initialize();

    await expectCode(
      client.callTool("stall", {}, { timeoutMs: 30 }),
      "MCP_TIMEOUT",
    );
    const echo = await client.callTool("echo", { message: "still alive" });
    expect(echo.content[0]).toMatchObject({ text: "Echo: still alive" });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await client.ping();
    expect(client.state).toBe("initialized");
  });

  it("treats initialize timeout as terminal and does not send cancellation", async () => {
    const client = fixtureClient(
      { requestTimeoutMs: 30, closeTimeoutMs: 50 },
      { MCP_FIXTURE_INITIALIZE_DELAY_MS: "200" },
    );

    await expectCode(client.initialize(), "MCP_TIMEOUT");
    expect(client.state).toBe("failed");
    await expectCode(client.ping(), "MCP_TIMEOUT");
  });

  it("does not become initialized when close wins the handshake race", async () => {
    const client = fixtureClient(
      { closeTimeoutMs: 50 },
      { MCP_FIXTURE_INITIALIZE_DELAY_MS: "200" },
    );
    const initializing = expectCode(client.initialize(), "MCP_CLOSED");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await client.close();
    await initializing;
    expect(client.state).toBe("closed");
    expect(client.initializeResult).toBeUndefined();
  });

  it("rejects start when close wins the subprocess spawn race", async () => {
    const client = fixtureClient({ closeTimeoutMs: 50 });
    const starting = expectCode(client.start(), "MCP_CLOSED");
    await client.close();
    await starting;
    expect(client.state).toBe("closed");
  });

  it("turns a closed server stdin into a typed terminal write failure", async () => {
    const client = fixtureClient({ closeTimeoutMs: 50 });
    await client.initialize();
    await client.request("fixture/close-input");
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expectCode(client.ping(), "MCP_WRITE_FAILED");
    expect(client.state).toBe("failed");
  });

  it("does not inherit arbitrary parent secrets by default", async () => {
    const secretName = `HARNESS_MCP_TEST_SECRET_${process.pid}`;
    process.env[secretName] = "must-not-cross-process-boundary";
    try {
      const client = fixtureClient();
      await client.initialize();
      await expect(
        client.request("fixture/get-env", { name: secretName }),
      ).resolves.toEqual({ value: null });
    } finally {
      delete process.env[secretName];
    }
  });

  it("fails terminally on an uncorrelated JSON-RPC error", async () => {
    const client = fixtureClient();
    await client.initialize();

    await expectCode(
      client.request("fixture/uncorrelated-error"),
      "MCP_PROTOCOL_ERROR",
    );
    expect(client.state).toBe("failed");
  });

  it("turns malformed server stdout into a terminal protocol error", async () => {
    const client = fixtureClient();
    await client.initialize();

    await expectCode(client.callTool("malformed"), "MCP_PROTOCOL_ERROR");
    expect(client.state).toBe("failed");
    await expectCode(client.ping(), "MCP_PROTOCOL_ERROR");
  });

  it("rejects an in-flight request when the server exits", async () => {
    const client = fixtureClient();
    await client.initialize();

    const error = await expectCode(
      client.callTool("crash"),
      "MCP_SERVER_EXITED",
    );
    expect(error.message).toContain("fixture crash requested");
    expect(client.state).toBe("failed");
  });

  it("reports spawn failures as typed errors", async () => {
    const client = new McpStdioClient({
      command: `missing-mcp-command-${process.pid}`,
    });
    clients.add(client);

    await expectCode(client.start(), "MCP_SPAWN_FAILED");
    expect(client.state).toBe("failed");
  });

  it("rejects unsupported negotiated protocol versions", async () => {
    const client = fixtureClient(
      {},
      { ...process.env, MCP_FIXTURE_PROTOCOL_VERSION: "1900-01-01" },
    );

    await expectCode(
      client.initialize(),
      "MCP_UNSUPPORTED_PROTOCOL_VERSION",
    );
    expect(client.state).toBe("failed");
  });

  it("validates construction and request inputs with typed errors", async () => {
    expect(() => new McpStdioClient({ command: "" })).toThrowError(
      expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }),
    );
    expect(
      () =>
        new McpStdioClient(
          { command: process.execPath },
          { requestTimeoutMs: 0 },
        ),
    ).toThrowError(expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }));
    expect(
      () =>
        new McpStdioClient(
          { command: process.execPath },
          { supportedProtocolVersions: [42] as unknown as string[] },
      ),
    ).toThrowError(expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }));
    expect(
      () =>
        new McpStdioClient({
          command: process.execPath,
          args: { bad: true } as unknown as string[],
        }),
    ).toThrowError(expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }));
    expect(
      () =>
        new McpStdioClient({
          command: process.execPath,
          env: { BAD: 42 } as unknown as NodeJS.ProcessEnv,
        }),
    ).toThrowError(expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }));
    expect(
      () =>
        new McpStdioClient(
          { command: process.execPath },
          null as unknown as ConstructorParameters<typeof McpStdioClient>[1],
        ),
    ).toThrowError(expect.objectContaining({ code: "MCP_INVALID_ARGUMENT" }));

    const client = fixtureClient();
    await expectCode(client.request("ping"), "MCP_NOT_STARTED");
    await client.initialize();
    await expectCode(client.callTool(""), "MCP_INVALID_ARGUMENT");
    await expectCode(
      client.callTool("echo", null as unknown as Record<string, unknown>),
      "MCP_INVALID_ARGUMENT",
    );
    await expectCode(
      client.listTools(42 as unknown as string),
      "MCP_INVALID_ARGUMENT",
    );
    await expectCode(
      client.request("ping", null as unknown as Record<string, unknown>),
      "MCP_INVALID_ARGUMENT",
    );
    await expectCode(
      client.request("ping", {}, { timeoutMs: 0 }),
      "MCP_INVALID_ARGUMENT",
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expectCode(
      client.request("fixture/circular", circular),
      "MCP_INVALID_ARGUMENT",
    );
    expect(client.state).toBe("initialized");
    await client.ping();
  });
});

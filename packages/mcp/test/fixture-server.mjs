import { closeSync } from "node:fs";
import { createInterface } from "node:readline";

const protocolVersion =
  process.env.MCP_FIXTURE_PROTOCOL_VERSION ?? "2025-11-25";
const initializeDelayMs = Number(
  process.env.MCP_FIXTURE_INITIALIZE_DELAY_MS ?? 0,
);
let initialized = false;
let initializeCount = 0;
let serverRequestSequence = 0;
const pendingClientResponses = new Map();
let keepAlive;

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function writeFrame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeFragmentedFrame(message) {
  const frame = `${JSON.stringify(message)}\n`;
  const split = Math.max(1, Math.floor(frame.length / 2));
  process.stdout.write(frame.slice(0, split));
  setTimeout(() => process.stdout.write(frame.slice(split)), 5);
}

function requestClient(method, params, onResponse) {
  const id = `fixture-server-${++serverRequestSequence}`;
  pendingClientResponses.set(id, onResponse);
  writeFrame({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function writeToolList(id) {
  const notification = {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      level: "info",
      logger: "fixture",
      data: "tools listed",
    },
  };
  const tools = response(id, {
    tools: [
      {
        name: "echo",
        description: "Echo a message",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
      {
        name: "fail",
        description: "Return a tool execution error",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "stall",
        description: "Respond after the client's short test timeout",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "malformed",
        description: "Corrupt stdout for protocol-error testing",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "crash",
        description: "Exit before returning a response",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "delayed-echo",
        description: "Echo after a caller-selected delay",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string" },
            delayMs: { type: "number" },
          },
          required: ["message", "delayMs"],
          additionalProperties: false,
        },
      },
      {
        name: "client-ping",
        description: "Ask the client to handle a ping request",
        inputSchema: { type: "object", additionalProperties: false },
      },
      {
        name: "client-unknown",
        description: "Ask the client to reject an unknown method",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  });

  // Deliberately coalesce two protocol messages into one stdout write.
  process.stdout.write(
    `${JSON.stringify(notification)}\n${JSON.stringify(tools)}\n`,
  );
}

function requireInitialized(id) {
  if (initialized) return true;
  writeFrame(errorResponse(id, -32002, "Server is not initialized"));
  return false;
}

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  switch (name) {
    case "echo": {
      if (typeof args.message !== "string") {
        writeFrame(errorResponse(id, -32602, "echo.message must be a string"));
        return;
      }
      writeFrame(
        response(id, {
          content: [{ type: "text", text: `Echo: ${args.message}` }],
        }),
      );
      return;
    }
    case "add": {
      if (typeof args.a !== "number" || typeof args.b !== "number") {
        writeFrame(errorResponse(id, -32602, "add requires numeric a and b"));
        return;
      }
      writeFrame(
        response(id, {
          content: [{ type: "text", text: String(args.a + args.b) }],
          structuredContent: { sum: args.a + args.b },
        }),
      );
      return;
    }
    case "fail":
      writeFrame(
        response(id, {
          content: [{ type: "text", text: "fixture tool failure" }],
          isError: true,
        }),
      );
      return;
    case "stall":
      setTimeout(
        () =>
          writeFrame(
            response(id, {
              content: [{ type: "text", text: "late response" }],
            }),
          ),
        200,
      );
      return;
    case "malformed":
      process.stdout.write("{not-json}\n");
      return;
    case "crash":
      process.stderr.write("fixture crash requested\n", () => process.exit(17));
      return;
    case "delayed-echo": {
      if (
        typeof args.message !== "string" ||
        !Number.isFinite(args.delayMs) ||
        args.delayMs < 0
      ) {
        writeFrame(
          errorResponse(id, -32602, "delayed-echo requires message and delayMs"),
        );
        return;
      }
      setTimeout(
        () =>
          writeFrame(
            response(id, {
              content: [{ type: "text", text: args.message }],
            }),
          ),
        args.delayMs,
      );
      return;
    }
    case "client-ping":
      requestClient("ping", undefined, (message) => {
        if (
          message?.error !== undefined ||
          typeof message?.result !== "object" ||
          message.result === null
        ) {
          writeFrame(errorResponse(id, -32603, "client ping response invalid"));
          return;
        }
        writeFrame(
          response(id, {
            content: [{ type: "text", text: "client ping answered" }],
            structuredContent: { answered: true },
          }),
        );
      });
      return;
    case "client-unknown":
      requestClient("fixture/not-supported", {}, (message) => {
        if (message?.error?.code !== -32601) {
          writeFrame(
            errorResponse(id, -32603, "client did not reject unknown method"),
          );
          return;
        }
        writeFrame(
          response(id, {
            content: [{ type: "text", text: "unknown method rejected" }],
            structuredContent: { rpcCode: message.error.code },
          }),
        );
      });
      return;
    default:
      writeFrame(errorResponse(id, -32602, `Unknown tool: ${String(name)}`));
  }
}

function handleMessage(message) {
  if (
    message?.jsonrpc !== "2.0" ||
    typeof message !== "object" ||
    message === null
  ) {
    return;
  }

  if (message.method === "notifications/initialized") {
    initialized = true;
    return;
  }
  if (message.method === "notifications/cancelled") {
    return;
  }
  if (!("id" in message)) {
    return;
  }
  if (!("method" in message)) {
    const onResponse = pendingClientResponses.get(message.id);
    if (onResponse) {
      pendingClientResponses.delete(message.id);
      onResponse(message);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      initializeCount += 1;
      setTimeout(
        () =>
          writeFragmentedFrame(
            response(message.id, {
              protocolVersion,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "harness-mcp-fixture", version: "0.1.0" },
              instructions: "Offline fixture server",
            }),
          ),
        initializeDelayMs,
      );
      return;
    case "ping":
      if (requireInitialized(message.id)) writeFrame(response(message.id, {}));
      return;
    case "tools/list":
      if (requireInitialized(message.id)) writeToolList(message.id);
      return;
    case "tools/call":
      if (requireInitialized(message.id)) callTool(message.id, message.params);
      return;
    case "fixture/stats":
      if (requireInitialized(message.id)) {
        writeFrame(response(message.id, { initializeCount }));
      }
      return;
    case "fixture/get-env":
      if (requireInitialized(message.id)) {
        const name = message.params?.name;
        writeFrame(
          response(message.id, {
            value: typeof name === "string" ? process.env[name] ?? null : null,
          }),
        );
      }
      return;
    case "fixture/coalesced": {
      if (!requireInitialized(message.id)) return;
      const padding = "x".repeat(700);
      const first = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { data: padding, sequence: 1 },
      };
      const second = {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { data: padding, sequence: 2 },
      };
      process.stdout.write(
        `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(response(message.id, { ok: true }))}\n`,
      );
      return;
    }
    case "fixture/close-input":
      if (!requireInitialized(message.id)) return;
      process.stdout.write(
        `${JSON.stringify(response(message.id, { closing: true }))}\n`,
        () => {
          setTimeout(() => {
            lines.close();
            try {
              closeSync(0);
            } catch {
              // stdin may already be closed by the parent.
            }
            keepAlive = setInterval(() => undefined, 1_000);
          }, 5);
        },
      );
      return;
    case "fixture/uncorrelated-error":
      writeFrame({
        jsonrpc: "2.0",
        error: { code: -32600, message: "uncorrelated fixture error" },
      });
      return;
    default:
      writeFrame(errorResponse(message.id, -32601, "Method not found"));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdin.on("error", () => undefined);
lines.on("line", (line) => {
  try {
    handleMessage(JSON.parse(line));
  } catch {
    writeFrame(errorResponse(null, -32700, "Parse error"));
  }
});

lines.on("close", () => {
  if (keepAlive) return;
});

process.stderr.write("harness MCP fixture ready\n");

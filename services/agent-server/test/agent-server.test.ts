import { describe, expect, it } from "vitest";
import { AcpClient, ACP_PROTOCOL_VERSION, AcpRemoteError } from "@harness/acp";
import type { AnyHarnessEvent } from "@harness/events";
import { FakeModel } from "@harness/models";
import type {
  CommandExecutor,
  ExecuteOptions,
  ExecuteResult,
} from "@harness/sandbox-runner";
import { ToolRegistry, createEchoTool, createTool } from "@harness/tools";
import { z } from "zod";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConnection, startAgentServer } from "../src";

async function until<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for test message");
}

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const TEST_CONTAINER_ID = "b".repeat(64);

function dockerOption(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function commandSuccess(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...overrides,
  };
}

class FakeDockerExecutor implements CommandExecutor {
  readonly calls: Array<{
    executable: string;
    args: string[];
    options: ExecuteOptions;
  }> = [];

  async execute(
    executable: string,
    args: readonly string[],
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    this.calls.push({ executable, args: [...args], options });
    if (args[0] === "run") {
      const cidFile = dockerOption(args, "--cidfile");
      if (cidFile === undefined) throw new Error("sandbox run omitted --cidfile");
      writeFileSync(cidFile, `${TEST_CONTAINER_ID}\n`, "utf8");
      options.onSpawn?.();
      return commandSuccess({ stdout: "v22.0.0\n" });
    }
    if (args[0] === "rm") return commandSuccess();
    throw new Error(`unexpected Docker command: ${args[0] ?? "<empty>"}`);
  }
}

describe("AgentConnection", () => {
  it("rejects model advertisements that exceed ACP collection or UTF-8 limits", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-model-limits-"));
    try {
      const tooManyModels = Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          `model-${index}`,
          () => new FakeModel(),
        ]),
      );
      expect(() => new AgentConnection(() => undefined, {
        workspaceRoot: root,
        sessionDbPath: false,
        models: tooManyModels,
      })).toThrow(/models: Array must contain at most 128 element/u);

      expect(() => new AgentConnection(() => undefined, {
        workspaceRoot: root,
        sessionDbPath: false,
        models: { ["💡".repeat(65)]: () => new FakeModel() },
      })).toThrow(/models\.0: string must be at most 256 UTF-8 bytes/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the session audit database outside a sandboxed workspace", () => {
    const container = mkdtempSync(join(tmpdir(), "harness-agent-db-boundary-"));
    const root = join(container, "workspace");
    mkdirSync(join(root, "tasks"), { recursive: true });
    try {
      expect(() => new AgentConnection(() => undefined, {
        workspaceRoot: root,
        sessionDbPath: join(root, "tasks", "runs", "agent-server.sqlite"),
        models: { fake: () => new FakeModel() },
        sandbox: {
          image: "harness-sandbox:test",
          trustedLocalImage: true,
        },
      })).toThrow("sessionDbPath must be outside the workspace");

      const alias = join(container, "audit-alias");
      symlinkSync(join(root, "tasks"), alias);
      expect(() => new AgentConnection(() => undefined, {
        workspaceRoot: root,
        sessionDbPath: join(alias, "runs", "agent-server.sqlite"),
        models: { fake: () => new FakeModel() },
        sandbox: {
          image: "harness-sandbox:test",
          trustedLocalImage: true,
        },
      })).toThrow("sessionDbPath must be outside the workspace");
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it.each([
    { streaming: false, permissioning: true },
    { streaming: true, permissioning: false },
    { streaming: true },
  ])("rejects clients missing required M3 capabilities: %j", async (capabilities) => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-capabilities-"));
    const sent: Array<Record<string, any>> = [];
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: { fake: () => new FakeModel([{ content: "ok" }]) },
        },
      );

      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities,
      }));
      const rejected = await until(() => sent.find((item) => item.id === 1));
      expect(rejected.error).toMatchObject({
        code: -32602,
        data: { code: "ACP_INVALID_PARAMS" },
      });
      expect(rejected.error.message).toContain("streaming and permissioning");
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically reserves one kernel run and resolves ask only by correlated response", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-"));
    const sent: Array<Record<string, any>> = [];
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: {
            fake: () => new FakeModel([
              {
                toolCalls: [{
                  id: "provider-call-1",
                  name: "danger",
                  arguments: { authorization: "Bearer super-secret" },
                }],
              },
              { content: "done" },
            ]),
          },
          tools: () => new ToolRegistry([
            createEchoTool("danger", "permitted"),
          ]),
          loadManifest: async () => ({
            id: "m3-services",
            title: "M3",
            goal: "test",
            acceptance: ["works"],
            allowed_paths: ["packages/**"],
            permissions: { "tool.call": { danger: "ask", "*": "deny" }, network: "deny" },
            delivery: { type: "none" },
          }),
          permissionTimeoutMs: 2_000,
        },
      );

      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));
      connection.receive(rpc(2, "session/new", { workspace: ".", taskId: "m3-services", model: "fake" }));
      const created = await until(() => sent.find((item) => item.id === 2));
      const sessionId = created.result.sessionId as string;

      connection.receive(rpc(3, "session/prompt", { sessionId, content: "run it" }));
      connection.receive(rpc(4, "session/prompt", { sessionId, content: "run twice" }));
      const duplicate = await until(() => sent.find((item) => item.id === 4));
      expect(duplicate.error.code).toBe(-32011);

      const requested = await until(() => sent.find(
        (item) => item.method === "session/event" && item.params.event.type === "permission.requested",
      ));
      expect(sent.some(
        (item) => item.method === "session/event" && item.params.event.type === "tool.result",
      )).toBe(false);
      const permissionId = requested.params.event.data.permissionId as string;
      connection.receive(rpc(5, "permission/respond", {
        sessionId,
        permissionId,
        decision: "allow",
      }));
      await until(() => sent.find((item) => item.id === 5));
      const completed = await until(() => sent.find((item) => item.id === 3));
      expect(completed.result.finalText).toBe("done");
      const toolResult = sent.find(
        (item) => item.method === "session/event" && item.params.event.type === "tool.result",
      );
      expect(toolResult?.params.event.data).toMatchObject({ tool: "danger", ok: true });

      const toolCall = sent.find(
        (item) => item.method === "session/event" && item.params.event.type === "tool.call",
      );
      expect(toolCall?.params.event.data.input.authorization).toBe("[REDACTED]");

      connection.receive(rpc(6, "permission/respond", { sessionId, permissionId, decision: "deny" }));
      const stale = await until(() => sent.find((item) => item.id === 6));
      expect(stale.error.code).toBe(-32021);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unbounded injected host tools before an ACP session can run them", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-unsafe-tool-"));
    const sent: Array<Record<string, any>> = [];
    let sideEffects = 0;
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: {
            fake: () => new FakeModel([
              {
                toolCalls: [{ id: "unsafe-1", name: "unsafe", arguments: {} }],
              },
            ]),
          },
          tools: () => new ToolRegistry([
            createTool({
              name: "unsafe",
              description: "unreviewed host side effect",
              parameters: z.object({}),
              execute: () => {
                sideEffects++;
                return { ok: true };
              },
            }),
          ]),
        },
      );

      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));
      connection.receive(rpc(2, "session/new", { workspace: ".", model: "fake" }));
      const rejected = await until(() => sent.find((item) => item.id === 2));

      expect(rejected.error).toMatchObject({
        code: -32602,
        data: { code: "ACP_INVALID_PARAMS" },
      });
      expect(rejected.error.message).toContain("no reviewed execution boundary");
      expect(sideEffects).toBe(0);
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not accept inherited object keys as model names", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-model-key-"));
    const sent: Array<Record<string, any>> = [];
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: { fake: () => new FakeModel([{ content: "ok" }]) },
        },
      );

      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));
      connection.receive(rpc(2, "session/new", { workspace: ".", model: "toString" }));
      const rejected = await until(() => sent.find((item) => item.id === 2));

      expect(rejected.error).toMatchObject({
        code: -32602,
        data: { code: "ACP_INVALID_PARAMS" },
      });
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a typed input error for missing or mismatched task manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-manifest-"));
    const sent: Array<Record<string, any>> = [];
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: { fake: () => new FakeModel([{ content: "ok" }]) },
          loadManifest: async (_workspace, taskId) => {
            if (taskId === "missing-task") throw new Error("missing");
            return {
              id: "different-task",
              title: "Mismatch",
              goal: "test",
              acceptance: ["typed failure"],
              allowed_paths: ["package.json"],
              permissions: {},
              delivery: { type: "none" },
            };
          },
        },
      );
      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));

      connection.receive(rpc(2, "session/new", {
        workspace: ".",
        taskId: "missing-task",
        model: "fake",
      }));
      const missing = await until(() => sent.find((item) => item.id === 2));
      expect(missing.error).toMatchObject({
        code: -32602,
        data: { code: "ACP_INVALID_PARAMS" },
      });

      connection.receive(rpc(3, "session/new", {
        workspace: ".",
        taskId: "requested-task",
        model: "fake",
      }));
      const mismatched = await until(() => sent.find((item) => item.id === 3));
      expect(mismatched.error).toMatchObject({
        code: -32602,
        data: { code: "ACP_INVALID_PARAMS" },
      });
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps sessions per connection and expires an unprompted session", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-session-cap-"));
    const sent: Array<Record<string, any>> = [];
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: { fake: () => new FakeModel([{ content: "ok" }]) },
          maxSessionsPerConnection: 1,
          createdSessionTimeoutMs: 5,
        },
      );
      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));
      connection.receive(rpc(2, "session/new", { workspace: ".", model: "fake" }));
      const created = await until(() => sent.find((item) => item.id === 2));
      connection.receive(rpc(3, "session/new", { workspace: ".", model: "fake" }));
      const limited = await until(() => sent.find((item) => item.id === 3));
      expect(limited.error).toMatchObject({
        code: -32012,
        data: { code: "ACP_SESSION_LIMIT" },
      });

      await new Promise((resolve) => setTimeout(resolve, 15));
      connection.receive(rpc(4, "session/prompt", {
        sessionId: created.result.sessionId,
        content: "too late",
      }));
      const expired = await until(() => sent.find((item) => item.id === 4));
      expect(expired.error).toMatchObject({ code: -32011 });
      connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for cooperative run cleanup after a connection closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-drain-"));
    const sent: Array<Record<string, any>> = [];
    let runStarted = false;
    let cleanupFinished = false;
    try {
      const connection = new AgentConnection(
        (wire) => sent.push(JSON.parse(wire)),
        {
          workspaceRoot: root,
          sessionDbPath: false,
          models: { fake: () => new FakeModel() },
          run: async (options) => {
            runStarted = true;
            await new Promise<void>((resolveAbort) => {
              const finish = () => {
                cleanupFinished = true;
                resolveAbort();
              };
              options.signal?.addEventListener("abort", finish, { once: true });
              if (options.signal?.aborted) finish();
            });
            return {
              status: "failed",
              text: "",
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              steps: 0,
              toolCalls: 0,
              events: [],
            };
          },
        },
      );
      connection.receive(rpc(1, "initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "test",
        capabilities: { streaming: true, permissioning: true },
      }));
      await until(() => sent.find((item) => item.id === 1));
      connection.receive(rpc(2, "session/new", { workspace: ".", model: "fake" }));
      const created = await until(() => sent.find((item) => item.id === 2));
      connection.receive(rpc(3, "session/prompt", {
        sessionId: created.result.sessionId,
        content: "wait",
      }));
      await until(() => runStarted ? true : undefined);

      connection.close();
      await connection.waitForIdle();
      expect(cleanupFinished).toBe(true);
      expect(sent.some((item) => item.id === 3)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ACP WebSocket server", () => {
  it("streams one kernel run over a real WebSocket", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-ws-"));
    const server = await startAgentServer({
      workspaceRoot: root,
      sessionDbPath: false,
      host: "127.0.0.1",
      port: 0,
      models: { fake: () => new FakeModel([{ content: "hello over ws" }]) },
    });
    try {
      const client = await AcpClient.connect(server.url);
      const streamed: string[] = [];
      client.onEvent(({ event }) => streamed.push(event.type));
      await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "integration-test",
        capabilities: { streaming: true, permissioning: true },
      });
      const { sessionId } = await client.newSession({ workspace: ".", model: "fake" });
      const result = await client.prompt({ sessionId, content: "hello" });
      expect(result.finalText).toBe("hello over ws");
      expect(result.events).toEqual([]);
      expect(streamed).toEqual([
        "session.created",
        "agent.started",
        "model.request",
        "model.response",
        "agent.stopped",
      ]);
      await expect(client.prompt({ sessionId, content: "again" })).rejects.toBeInstanceOf(AcpRemoteError);
      client.close();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs sandbox_exec end to end with one mirrored ACP run approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-agent-sandbox-e2e-"));
    writeFileSync(join(root, "package.json"), "{}\n", "utf8");
    const executor = new FakeDockerExecutor();
    const server = await startAgentServer({
      workspaceRoot: root,
      sessionDbPath: false,
      host: "127.0.0.1",
      port: 0,
      models: {
        fake: () => new FakeModel([
          {
            toolCalls: [{
              id: "sandbox-call-1",
              name: "sandbox_exec",
              arguments: { argv: ["node", "--version"] },
            }],
          },
          { content: "sandbox completed" },
        ]),
      },
      sandbox: {
        image: "harness-sandbox:test",
        trustedLocalImage: true,
        dockerBinary: "docker-test",
        executor,
      },
      loadManifest: async () => ({
        id: "sandbox-e2e",
        title: "Sandbox E2E",
        goal: "Run one command in the sandbox",
        acceptance: ["command completes"],
        allowed_paths: ["package.json"],
        permissions: {
          "process.exec": { "node --version": "ask", "*": "deny" },
          "fs.read": "allow",
          "fs.write": "deny",
          network: "deny",
        },
        delivery: { type: "none" },
      }),
    });
    let client: AcpClient | undefined;
    try {
      client = await AcpClient.connect(server.url);
      const streamed: AnyHarnessEvent[] = [];
      let permissionResponses = 0;
      let permissionResponse: ReturnType<AcpClient["respondPermission"]> | undefined;
      client.onEvent(({ sessionId, event }) => {
        streamed.push(event);
        if (event.type !== "permission.requested") return;
        permissionResponses++;
        permissionResponse = client!.respondPermission({
          sessionId,
          permissionId: event.data.permissionId,
          decision: "allow",
        });
      });

      await client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "sandbox-e2e-test",
        capabilities: { streaming: true, permissioning: true },
      });
      const { sessionId } = await client.newSession({
        workspace: ".",
        taskId: "sandbox-e2e",
        model: "fake",
      });
      const result = await client.prompt({ sessionId, content: "check Node" });
      expect(await permissionResponse).toEqual({ accepted: true });

      expect(result).toMatchObject({
        status: "completed",
        finalText: "sandbox completed",
        events: [],
      });
      expect(permissionResponses).toBe(1);

      const execDecisions = streamed.filter(
        (event) => event.type === "policy.decision" &&
          event.data.action === "process.exec" &&
          event.data.subject === "node --version",
      );
      expect(execDecisions).toHaveLength(2);
      expect(execDecisions.map((event) => event.actor)).toEqual([
        "kernel",
        "sandbox-runner",
      ]);
      const permissionRequests = streamed.filter(
        (event) => event.type === "permission.requested",
      );
      expect(permissionRequests).toHaveLength(1);
      expect(permissionRequests[0]).toMatchObject({
        data: {
          action: "process.exec",
          subject: "node --version",
          scope: "run",
        },
      });
      expect(streamed.filter((event) => event.type === "permission.resolved")).toHaveLength(1);

      const sandboxEvents = streamed.filter(
        (event) => event.type === "sandbox.started" || event.type === "sandbox.stopped",
      );
      expect(sandboxEvents.map((event) => event.type)).toEqual([
        "sandbox.started",
        "sandbox.stopped",
      ]);
      expect(sandboxEvents[1]).toMatchObject({
        actor: "sandbox-runner",
        data: { status: "completed", exitCode: 0 },
      });
      const toolResult = streamed.find((event) => event.type === "tool.result");
      expect(toolResult).toMatchObject({
        data: {
          tool: "sandbox_exec",
          ok: true,
          output: {
            ok: true,
            exitCode: 0,
            stdout: "v22.0.0\n",
            cleanup: "removed",
          },
        },
      });

      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0]).toMatchObject({ executable: "docker-test" });
      expect(executor.calls[0]!.args[0]).toBe("run");
      expect(executor.calls[0]!.args).toEqual(expect.arrayContaining([
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        "harness-sandbox:test",
        "--version",
      ]));
      expect(executor.calls[1]).toMatchObject({
        executable: "docker-test",
        args: ["rm", "--force", "--volumes", TEST_CONTAINER_ID],
      });
    } finally {
      client?.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

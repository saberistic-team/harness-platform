import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { Buffer } from "node:buffer";
import { z, type ZodType } from "zod";

import {
  mcpNotification,
  mcpProtocolVersion,
  mcpRequest,
  mcpResponse,
  mcpSupportedProtocolVersions,
  type McpNotification,
  type McpResponse,
} from "./protocol.js";

const implementationSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    title: z.string().min(1).optional(),
  })
  .passthrough();

const initializeResultSchema = z
  .object({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.unknown()),
    serverInfo: implementationSchema,
    instructions: z.string().optional(),
  })
  .passthrough();

const toolSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()).optional(),
    annotations: z.record(z.unknown()).optional(),
    execution: z.record(z.unknown()).optional(),
  })
  .passthrough();

const listToolsResultSchema = z
  .object({
    tools: z.array(toolSchema),
    nextCursor: z.string().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

const contentBlockSchema = z
  .object({
    type: z.string().min(1),
  })
  .passthrough();

const callToolResultSchema = z
  .object({
    content: z.array(contentBlockSchema),
    structuredContent: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type McpInitializeResult = z.infer<typeof initializeResultSchema>;
export type McpTool = z.infer<typeof toolSchema>;
export type McpListToolsResult = z.infer<typeof listToolsResultSchema>;
export type McpCallToolResult = z.infer<typeof callToolResultSchema>;

export type McpClientErrorCode =
  | "MCP_INVALID_ARGUMENT"
  | "MCP_NOT_STARTED"
  | "MCP_NOT_INITIALIZED"
  | "MCP_CLOSED"
  | "MCP_SPAWN_FAILED"
  | "MCP_SERVER_EXITED"
  | "MCP_TRANSPORT_ERROR"
  | "MCP_WRITE_FAILED"
  | "MCP_CLOSE_TIMEOUT"
  | "MCP_TIMEOUT"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_RPC_ERROR"
  | "MCP_UNSUPPORTED_PROTOCOL_VERSION";

export class McpClientError extends Error {
  readonly code: McpClientErrorCode;
  readonly details?: unknown;

  constructor(
    code: McpClientErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "McpClientError";
    this.code = code;
    this.details = options.details;
  }
}

export interface McpStdioServerSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * Complete environment for the subprocess. When omitted, only a small set
   * of non-secret process-launch variables is inherited.
   */
  env?: NodeJS.ProcessEnv;
}

export interface McpStdioClientOptions {
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxFrameBytes?: number;
  maxStderrBytes?: number;
  clientInfo?: { name: string; version: string };
  supportedProtocolVersions?: readonly string[];
  onNotification?: (
    notification: McpNotification,
  ) => void | Promise<void>;
}

export type McpClientState =
  | "idle"
  | "starting"
  | "running"
  | "initializing"
  | "initialized"
  | "closing"
  | "closed"
  | "failed";

interface PendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: McpClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RequestOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const MAX_IGNORED_RESPONSE_IDS = 1_000;
const SAFE_INHERITED_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
] as const;

function restrictedSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpClientError(
      "MCP_INVALID_ARGUMENT",
      `${name} must be a positive safe integer`,
      { details: { [name]: value } },
    );
  }
  return value;
}

function protocolError(message: string, details?: unknown): McpClientError {
  return new McpClientError("MCP_PROTOCOL_ERROR", message, { details });
}

export class McpStdioClient {
  private readonly spec: McpStdioServerSpec;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxStderrBytes: number;
  private readonly clientInfo: { name: string; version: string };
  private readonly supportedProtocolVersions: readonly string[];
  private readonly onNotification?: (
    notification: McpNotification,
  ) => void | Promise<void>;

  private stateValue: McpClientState = "idle";
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private initializePromise?: Promise<McpInitializeResult>;
  private closePromise?: Promise<void>;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private sequence = 0;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly ignoredResponseIds = new Set<string | number>();
  private terminalError?: McpClientError;
  private negotiated?: McpInitializeResult;

  constructor(spec: McpStdioServerSpec, options: McpStdioClientOptions = {}) {
    if (typeof options !== "object" || options === null) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP stdio client options must be an object",
      );
    }
    if (
      typeof spec !== "object" ||
      spec === null ||
      typeof spec.command !== "string" ||
      spec.command.trim().length === 0
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP stdio server command must be a non-empty string",
      );
    }
    if (
      spec.args !== undefined &&
      (!Array.isArray(spec.args) ||
        spec.args.some((arg) => typeof arg !== "string"))
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP stdio server args must contain only strings",
      );
    }
    if (
      spec.cwd !== undefined &&
      (typeof spec.cwd !== "string" || spec.cwd.length === 0)
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP stdio server cwd must be a non-empty string",
      );
    }
    if (
      spec.env !== undefined &&
      (!isRecord(spec.env) ||
        Object.values(spec.env).some(
          (value) => value !== undefined && typeof value !== "string",
        ))
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP stdio server env must contain only string values",
      );
    }
    if (
      options.onNotification !== undefined &&
      typeof options.onNotification !== "function"
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "onNotification must be a function",
      );
    }

    const supported =
      options.supportedProtocolVersions ?? mcpSupportedProtocolVersions;
    if (
      !Array.isArray(supported) ||
      supported.length === 0 ||
      supported.some(
        (version) =>
          typeof version !== "string" || version.trim().length === 0,
      )
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "supportedProtocolVersions must contain at least one non-empty version",
      );
    }

    const clientInfo = options.clientInfo ?? {
      name: "harness-mcp-client",
      version: "0.1.0",
    };
    if (
      typeof clientInfo !== "object" ||
      clientInfo === null ||
      typeof clientInfo.name !== "string" ||
      clientInfo.name.trim().length === 0 ||
      typeof clientInfo.version !== "string" ||
      clientInfo.version.trim().length === 0
    ) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "clientInfo name and version must be non-empty strings",
      );
    }

    this.spec = spec;
    this.requestTimeoutMs = positiveInteger(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.closeTimeoutMs = positiveInteger(
      "closeTimeoutMs",
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    );
    this.maxFrameBytes = positiveInteger(
      "maxFrameBytes",
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    );
    this.maxStderrBytes = positiveInteger(
      "maxStderrBytes",
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    );
    this.clientInfo = clientInfo;
    this.supportedProtocolVersions = [...supported];
    this.onNotification = options.onNotification;
  }

  get state(): McpClientState {
    return this.stateValue;
  }

  get initializeResult(): McpInitializeResult | undefined {
    return this.negotiated;
  }

  async start(): Promise<void> {
    if (
      this.stateValue === "running" ||
      this.stateValue === "initializing" ||
      this.stateValue === "initialized"
    ) {
      return;
    }
    if (this.stateValue === "starting" && this.startPromise) {
      return this.startPromise;
    }
    if (this.stateValue !== "idle") {
      throw this.stateError();
    }

    this.stateValue = "starting";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.spec.command, [...(this.spec.args ?? [])], {
        cwd: this.spec.cwd,
        env:
          this.spec.env === undefined
            ? restrictedSubprocessEnv()
            : { ...this.spec.env },
        // A dedicated POSIX process group lets close/failure clean up helpers
        // spawned by an MCP server as well as the direct child.
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (cause) {
      const error = new McpClientError(
        "MCP_SPAWN_FAILED",
        `Failed to spawn MCP server command ${JSON.stringify(this.spec.command)}`,
        { cause },
      );
      this.fail(error, false);
      throw error;
    }

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    child.stdin.on("error", (cause) =>
      this.handleStreamError("stdin", cause),
    );
    child.stdout.on("error", (cause) =>
      this.handleStreamError("stdout", cause),
    );
    child.stderr.on("error", (cause) =>
      this.handleStreamError("stderr", cause),
    );

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    this.startPromise = new Promise<void>((resolve, reject) => {
      let startupSettled = false;

      child.once("spawn", () => {
        startupSettled = true;
        if (this.stateValue === "starting") {
          this.stateValue = "running";
          resolve();
          return;
        }
        reject(this.stateError());
      });

      child.on("error", (cause) => {
        const error = new McpClientError(
          startupSettled ? "MCP_TRANSPORT_ERROR" : "MCP_SPAWN_FAILED",
          startupSettled
            ? `MCP server process failed for ${JSON.stringify(this.spec.command)}`
            : `Failed to spawn MCP server command ${JSON.stringify(this.spec.command)}`,
          { cause },
        );
        this.fail(error);
        if (!startupSettled) {
          startupSettled = true;
          reject(error);
        }
      });

      child.once("exit", (code, signal) => {
        this.resolveExit?.();
        this.resolveExit = undefined;

        if (
          this.stateValue === "closing" ||
          this.stateValue === "closed" ||
          this.stateValue === "failed"
        ) {
          return;
        }

        const stderr = this.stderrBuffer.trim();
        const suffix = stderr.length > 0 ? `; stderr: ${stderr}` : "";
        const error = new McpClientError(
          "MCP_SERVER_EXITED",
          `MCP server exited before close (code=${String(code)}, signal=${String(signal)})${suffix}`,
          { details: { code, signal, stderr } },
        );
        this.fail(error);
        if (!startupSettled) {
          startupSettled = true;
          reject(error);
        }
      });

      child.once("close", () => {
        // `exit` normally settles this first. `close` is retained as a
        // defensive fallback for unusual ChildProcess implementations.
        this.resolveExit?.();
        this.resolveExit = undefined;
      });
    });

    return this.startPromise;
  }

  initialize(): Promise<McpInitializeResult> {
    if (this.stateValue === "initialized" && this.negotiated) {
      return Promise.resolve(this.negotiated);
    }
    if (this.initializePromise) return this.initializePromise;

    const attempt = this.initializeInternal();
    this.initializePromise = attempt;
    void attempt.then(
      () => {
        if (this.initializePromise === attempt) this.initializePromise = undefined;
      },
      () => {
        if (this.initializePromise === attempt) this.initializePromise = undefined;
      },
    );
    return attempt;
  }

  private async initializeInternal(): Promise<McpInitializeResult> {
    if (this.stateValue === "idle" || this.stateValue === "starting") {
      await this.start();
    }
    if (this.stateValue !== "running") {
      throw this.stateError();
    }
    this.stateValue = "initializing";

    try {
      const raw = await this.sendRequest(
        "initialize",
        {
          protocolVersion:
            this.supportedProtocolVersions[0] ?? mcpProtocolVersion,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
        { allowBeforeInitialize: true },
      );
      const result = this.parseResult(initializeResultSchema, raw, "initialize");

      if (!this.supportedProtocolVersions.includes(result.protocolVersion)) {
        throw new McpClientError(
          "MCP_UNSUPPORTED_PROTOCOL_VERSION",
          `MCP server selected unsupported protocol version ${JSON.stringify(result.protocolVersion)}`,
          {
            details: {
              selected: result.protocolVersion,
              supported: this.supportedProtocolVersions,
            },
          },
        );
      }

      await this.writeOrFail({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      if (this.stateValue !== "initializing") {
        throw this.stateError();
      }
      this.negotiated = result;
      this.stateValue = "initialized";
      return result;
    } catch (cause) {
      const error =
        cause instanceof McpClientError
          ? cause
          : new McpClientError(
              "MCP_PROTOCOL_ERROR",
              "MCP initialization failed",
              { cause },
            );
      const state = this.stateValue as McpClientState;
      if (
        !(["closing", "closed", "failed"] as McpClientState[]).includes(
          state,
        )
      ) {
        this.fail(error);
      }
      throw error;
    }
  }

  async ping(options: RequestOptions = {}): Promise<void> {
    await this.request("ping", {}, options);
  }

  async listTools(
    cursor?: string,
    options: RequestOptions = {},
  ): Promise<McpListToolsResult> {
    if (cursor !== undefined && typeof cursor !== "string") {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP tools/list cursor must be a string",
      );
    }
    const raw = await this.request(
      "tools/list",
      cursor === undefined ? {} : { cursor },
      options,
    );
    return this.parseResult(listToolsResultSchema, raw, "tools/list");
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<McpCallToolResult> {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP tool name must be a non-empty string",
      );
    }
    if (!isRecord(args)) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP tool arguments must be an object",
      );
    }
    const raw = await this.request(
      "tools/call",
      { name, arguments: args },
      options,
    );
    return this.parseResult(callToolResultSchema, raw, "tools/call");
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (typeof method !== "string" || method.trim().length === 0) {
      return Promise.reject(
        new McpClientError(
          "MCP_INVALID_ARGUMENT",
          "MCP request method must be a non-empty string",
        ),
      );
    }
    if (!isRecord(params)) {
      return Promise.reject(
        new McpClientError(
          "MCP_INVALID_ARGUMENT",
          "MCP request params must be an object",
        ),
      );
    }
    return this.sendRequest(method, params, {
      timeoutMs: options.timeoutMs,
      allowBeforeInitialize: false,
    });
  }

  async notify(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    this.assertInitialized();
    if (params !== undefined && !isRecord(params)) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "MCP notification params must be an object",
      );
    }
    const parsed = mcpNotification.safeParse({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (!parsed.success) {
      throw new McpClientError(
        "MCP_INVALID_ARGUMENT",
        "Invalid MCP notification",
        { details: parsed.error.issues },
      );
    }
    await this.writeOrFail(parsed.data);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.stateValue === "closed") {
      return;
    }
    if (this.stateValue === "idle") {
      this.stateValue = "closed";
      return;
    }

    const child = this.child;
    this.stateValue = "closing";
    this.rejectPending(
      new McpClientError("MCP_CLOSED", "MCP stdio client is closing"),
    );

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.signalProcessGroup("SIGTERM");
      this.stateValue = "closed";
      return;
    }

    try {
      child.stdin.end();
    } catch {
      // The process may have closed stdin between the state check and end().
    }

    if (await this.waitForExit(this.closeTimeoutMs)) {
      this.signalProcessGroup("SIGTERM");
      this.stateValue = "closed";
      return;
    }

    this.signalProcessGroup("SIGTERM");
    if (await this.waitForExit(this.closeTimeoutMs)) {
      this.signalProcessGroup("SIGTERM");
      this.stateValue = "closed";
      return;
    }

    this.signalProcessGroup("SIGKILL");
    if (await this.waitForExit(this.closeTimeoutMs)) {
      this.signalProcessGroup("SIGKILL");
      this.stateValue = "closed";
      return;
    }

    const error = new McpClientError(
      "MCP_CLOSE_TIMEOUT",
      `MCP server did not exit after close escalation (${this.closeTimeoutMs}ms per stage)`,
      { details: { pid: child.pid, command: this.spec.command } },
    );
    this.terminalError = error;
    this.stateValue = "failed";
    throw error;
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; allowBeforeInitialize: boolean },
  ): Promise<unknown> {
    if (options.allowBeforeInitialize) {
      if (
        this.stateValue !== "running" &&
        this.stateValue !== "initializing"
      ) {
        return Promise.reject(this.stateError());
      }
    } else {
      try {
        this.assertInitialized();
      } catch (error) {
        return Promise.reject(error);
      }
    }

    const timeoutMs = positiveInteger(
      "timeoutMs",
      options.timeoutMs ?? this.requestTimeoutMs,
    );
    const id = ++this.sequence;
    const message = {
      jsonrpc: "2.0" as const,
      id,
      method,
      params,
    };

    const parsed = mcpRequest.safeParse(message);
    if (!parsed.success) {
      return Promise.reject(
        new McpClientError("MCP_INVALID_ARGUMENT", "Invalid MCP request", {
          details: parsed.error.issues,
        }),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new McpClientError(
          "MCP_TIMEOUT",
          `MCP request ${method} timed out after ${timeoutMs}ms`,
          { details: { id, method, timeoutMs } },
        );
        reject(error);
        if (method === "initialize") {
          this.fail(error);
          return;
        }
        this.rememberIgnoredResponseId(id);
        if (method !== "initialize" && this.canWrite()) {
          void this.writeMessage({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason: "client timeout" },
          }).catch((cause: unknown) => {
            this.fail(
              cause instanceof McpClientError
                ? cause
                : new McpClientError(
                    "MCP_WRITE_FAILED",
                    "Failed to write MCP cancellation notification",
                    { cause },
                  ),
            );
          });
        }
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { method, resolve, reject, timer });
      void this.writeMessage(parsed.data).catch((cause: unknown) => {
        const error =
          cause instanceof McpClientError
            ? cause
            : new McpClientError(
                "MCP_WRITE_FAILED",
                `Failed to write MCP request ${method}`,
                { cause },
              );
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        if (error.code !== "MCP_INVALID_ARGUMENT") this.fail(error);
      });
    });
  }

  private writeMessage(message: unknown): Promise<void> {
    const child = this.child;
    if (!child || !this.canWrite()) {
      return Promise.reject(this.stateError());
    }

    let frame: string;
    try {
      frame = `${JSON.stringify(message)}\n`;
    } catch (cause) {
      return Promise.reject(
        new McpClientError(
          "MCP_INVALID_ARGUMENT",
          "MCP message is not JSON serializable",
          { cause },
        ),
      );
    }

    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(frame, "utf8", (cause?: Error | null) => {
          if (cause) {
            reject(
              new McpClientError(
                "MCP_WRITE_FAILED",
                "Failed to write to MCP server stdin",
                { cause },
              ),
            );
            return;
          }
          resolve();
        });
      } catch (cause) {
        reject(
          new McpClientError(
            "MCP_WRITE_FAILED",
            "Failed to write to MCP server stdin",
            { cause },
          ),
        );
      }
    });
  }

  private async writeOrFail(message: unknown): Promise<void> {
    try {
      await this.writeMessage(message);
    } catch (cause) {
      const error =
        cause instanceof McpClientError
          ? cause
          : new McpClientError(
              "MCP_WRITE_FAILED",
              "Failed to write MCP message",
              { cause },
            );
      if (error.code !== "MCP_INVALID_ARGUMENT") this.fail(error);
      throw error;
    }
  }

  private handleStdout(chunk: string): void {
    if (this.stateValue === "failed" || this.stateValue === "closed") return;
    this.stdoutBuffer += chunk;

    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) {
        if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
          this.fail(
            protocolError(`MCP stdout frame exceeded ${this.maxFrameBytes} bytes`),
          );
          return;
        }
        this.handleFrame(line);
        if (this.terminalError) return;
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxFrameBytes) {
      this.fail(
        protocolError(
          `MCP stdout frame exceeded ${this.maxFrameBytes} bytes before a newline`,
        ),
      );
    }
  }

  private handleFrame(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      this.fail(
        new McpClientError(
          "MCP_PROTOCOL_ERROR",
          "MCP server wrote malformed JSON to stdout",
          { cause, details: { frame: line.slice(0, 256) } },
        ),
      );
      return;
    }

    const response = mcpResponse.safeParse(raw);
    if (response.success) {
      this.handleResponse(response.data);
      return;
    }

    const request = mcpRequest.safeParse(raw);
    if (request.success) {
      const reply =
        request.data.method === "ping"
          ? {
              jsonrpc: "2.0" as const,
              id: request.data.id,
              result: {},
            }
          : {
              jsonrpc: "2.0" as const,
              id: request.data.id,
              error: {
                code: -32601,
                message: `Client method not supported: ${request.data.method}`,
              },
            };
      void this.writeMessage(reply).catch((cause: unknown) => {
        this.fail(
          cause instanceof McpClientError
            ? cause
            : protocolError("Failed to answer server request"),
        );
      });
      return;
    }

    const notification = mcpNotification.safeParse(raw);
    if (notification.success) {
      this.observeNotification(notification.data);
      return;
    }

    this.fail(
      protocolError("MCP server wrote an invalid JSON-RPC message", {
        frame: line.slice(0, 256),
        responseIssues: response.error.issues,
        notificationIssues: notification.error.issues,
        requestIssues: request.error.issues,
      }),
    );
  }

  private handleResponse(response: McpResponse): void {
    if (response.id === undefined) {
      this.fail(
        protocolError("MCP server returned an uncorrelated error response", {
          error: response.error,
        }),
      );
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      if (this.ignoredResponseIds.delete(response.id)) {
        return;
      }
      this.fail(
        protocolError(`MCP server returned unknown response id ${String(response.id)}`),
      );
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined) {
      pending.reject(
        new McpClientError(
          "MCP_RPC_ERROR",
          `MCP request ${pending.method} failed (${response.error.code}): ${response.error.message}`,
          {
            details: {
              id: response.id,
              method: pending.method,
              rpcCode: response.error.code,
              rpcData: response.error.data,
            },
          },
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private observeNotification(notification: McpNotification): void {
    try {
      const observed = this.onNotification?.(notification);
      if (observed && typeof observed.then === "function") {
        void Promise.resolve(observed).catch(() => undefined);
      }
    } catch {
      // Observer failures cannot corrupt the transport.
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`;
    const bytes = Buffer.byteLength(this.stderrBuffer, "utf8");
    if (bytes <= this.maxStderrBytes) return;
    this.stderrBuffer = Buffer.from(this.stderrBuffer, "utf8")
      .subarray(bytes - this.maxStderrBytes)
      .toString("utf8");
  }

  private parseResult<T>(schema: ZodType<T>, raw: unknown, method: string): T {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;

    const error = protocolError(
      `MCP response for ${method} did not match the expected schema`,
      { issues: parsed.error.issues },
    );
    this.fail(error);
    throw error;
  }

  private assertInitialized(): void {
    if (this.stateValue === "initialized") return;
    if (
      this.stateValue === "running" ||
      this.stateValue === "starting" ||
      this.stateValue === "initializing"
    ) {
      throw new McpClientError(
        "MCP_NOT_INITIALIZED",
        "MCP client must complete initialize before this operation",
      );
    }
    throw this.stateError();
  }

  private stateError(): McpClientError {
    if (this.terminalError) return this.terminalError;
    if (this.stateValue === "idle") {
      return new McpClientError(
        "MCP_NOT_STARTED",
        "MCP stdio client has not been started",
      );
    }
    return new McpClientError(
      "MCP_CLOSED",
      `MCP stdio client is ${this.stateValue}`,
    );
  }

  private canWrite(): boolean {
    const child = this.child;
    return Boolean(
      child &&
        (this.stateValue === "running" ||
          this.stateValue === "initializing" ||
          this.stateValue === "initialized") &&
        child.exitCode === null &&
        child.signalCode === null &&
        !child.stdin.destroyed,
    );
  }

  private rememberIgnoredResponseId(id: string | number): void {
    this.ignoredResponseIds.add(id);
    if (this.ignoredResponseIds.size <= MAX_IGNORED_RESPONSE_IDS) return;
    const oldest = this.ignoredResponseIds.values().next().value;
    if (oldest !== undefined) this.ignoredResponseIds.delete(oldest);
  }

  private rejectPending(error: McpClientError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: McpClientError, kill = true): void {
    if (
      this.stateValue === "closed" ||
      this.stateValue === "closing" ||
      this.stateValue === "failed"
    ) {
      return;
    }
    if (!this.terminalError) this.terminalError = error;
    this.stateValue = "failed";
    this.rejectPending(this.terminalError);

    if (kill) this.signalProcessGroup("SIGTERM");
  }

  private handleStreamError(
    stream: "stdin" | "stdout" | "stderr",
    cause: Error,
  ): void {
    if (this.stateValue === "closing" || this.stateValue === "closed") return;
    this.fail(
      new McpClientError(
        stream === "stdin" ? "MCP_WRITE_FAILED" : "MCP_TRANSPORT_ERROR",
        stream === "stdin"
          ? "MCP server closed its stdin"
          : `MCP server ${stream} stream failed`,
        { cause, details: { stream } },
      ),
    );
  }

  private signalProcessGroup(signal: NodeJS.Signals): boolean {
    const child = this.child;
    if (!child?.pid) return false;

    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ESRCH"
        ) {
          return false;
        }
        return false;
      }
    }

    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    const exitPromise = this.exitPromise;
    if (!exitPromise) return false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const exited = exitPromise.then(() => true as const);
    const result = await Promise.race([exited, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }
}

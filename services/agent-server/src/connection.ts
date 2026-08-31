import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_RPC_ERROR_CODES,
  AcpProtocolError,
  acpInitializeResultSchema,
  acpEvent,
  acpFailure,
  acpSuccess,
  decodeAcpMessage,
  type AcpCancelSessionParams,
  type AcpInitializeParams,
  type AcpNewSessionParams,
  type AcpPermissionResponseParams,
  type AcpPromptParams,
  type AcpRequest,
  type AcpRequestId,
} from "@harness/acp";
import {
  createEvent,
  redactEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import {
  runAgent,
  type PermissionRequest,
  type RunOptions,
  type RunResult,
} from "@harness/kernel";
import type { Model } from "@harness/models";
import { compileRules, type Decision } from "@harness/policy";
import type { EnforcedDecision } from "@harness/sandbox-runner";
import { loadTaskManifestFile, type TaskManifest } from "@harness/sdk";
import {
  openSqliteSession,
  setSessionStatus,
  type OpenedSession,
} from "@harness/sessions";
import {
  ToolRegistry,
  getToolExecutionBoundary,
  type Tool,
} from "@harness/tools";
import { openWorkspace } from "@harness/workspace";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createAgentSandboxTool,
  SANDBOX_EXEC_TOOL,
  type AgentSandboxOptions,
} from "./sandbox-tool";

export interface AgentSessionContext {
  sessionId: string;
  workspace: string;
  taskId?: string;
  manifest?: TaskManifest;
  modelName: string;
}

export interface AgentConnectionOptions {
  models: Record<string, () => Model>;
  defaultModel?: string;
  workspaceRoot?: string;
  tools?: (context: AgentSessionContext) => ToolRegistry;
  /** Enables the built-in Docker-backed `sandbox_exec` tool for task sessions. */
  sandbox?: AgentSandboxOptions;
  loadManifest?: (workspace: string, taskId: string) => Promise<TaskManifest>;
  /** Central SQLite store. `false` disables persistence for embedded tests. */
  sessionDbPath?: string | false;
  permissionTimeoutMs?: number;
  /** Hard resource cap for one WebSocket connection. */
  maxSessionsPerConnection?: number;
  /** Created sessions are closed if no prompt arrives within this window. */
  createdSessionTimeoutMs?: number;
  run?: (options: RunOptions) => Promise<RunResult>;
  now?: () => string;
  newId?: (prefix: string) => string;
  agentName?: string;
  agentVersion?: string;
}

const DEFAULT_AGENT_NAME = "harness-agent-server";
const DEFAULT_AGENT_VERSION = "0.3.0";

/** Validate the server identity and model registry against the ACP wire caps. */
export function validateAgentAdvertisement(
  options: Pick<
    AgentConnectionOptions,
    "agentName" | "agentVersion" | "defaultModel" | "models"
  >,
): void {
  const modelNames = Object.keys(options.models);
  if (modelNames.length === 0) {
    throw new Error("agent server needs at least one model");
  }
  if (
    options.defaultModel !== undefined &&
    !Object.hasOwn(options.models, options.defaultModel)
  ) {
    throw new Error(`unknown default model: ${options.defaultModel}`);
  }
  const advertisement = acpInitializeResultSchema.safeParse({
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentName: options.agentName ?? DEFAULT_AGENT_NAME,
    agentVersion: options.agentVersion ?? DEFAULT_AGENT_VERSION,
    capabilities: { streaming: true, permissioning: true, sessions: false },
    models: modelNames,
  });
  if (!advertisement.success) {
    const detail = advertisement.error.issues
      .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ACP agent advertisement: ${detail}`);
  }
}

type SessionStateName = "created" | "running" | "completed" | "failed" | "canceled";

interface PendingPermission {
  resolve(value: { decision: "allow" | "deny"; note?: string }): void;
  timer: ReturnType<typeof setTimeout>;
  request: PermissionRequest;
}

interface SessionState extends AgentSessionContext {
  state: SessionStateName;
  model: Model;
  tools: ToolRegistry;
  eventCount: number;
  appendQueue: Promise<void>;
  appendError?: unknown;
  store?: OpenedSession;
  abort: AbortController;
  pending: Map<string, PendingPermission>;
  resolvedPermissions: Set<string>;
  runPermissionGrants: Set<string>;
  sandboxRuns: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function requestId(raw: string): AcpRequestId | null {
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === "string" || (typeof parsed.id === "number" && Number.isInteger(parsed.id))
      ? parsed.id
      : null;
  } catch {
    return null;
  }
}

function boundedBudget(requested: number | undefined, manifestLimit: number | undefined): number | undefined {
  if (requested === undefined) return manifestLimit;
  if (manifestLimit === undefined) return requested;
  return Math.min(requested, manifestLimit);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/** Resolve every existing ancestor, including symlinks, before creating it. */
function canonicalProspectivePath(input: string): string {
  let cursor = resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function operationalError(
  code: ConstructorParameters<typeof AcpProtocolError>[0],
  message: string,
  rpcCode: number,
): AcpProtocolError {
  return new AcpProtocolError(code, message, rpcCode);
}

function unsafeTool(name: string, reason: string): AcpProtocolError {
  return operationalError(
    "ACP_INVALID_PARAMS",
    `tool ${JSON.stringify(name)} is not safe for agent-server host execution: ${reason}`,
    ACP_RPC_ERROR_CODES.invalidParams,
  );
}

function snapshotHostTools(source: ToolRegistry, workspace: string): ToolRegistry {
  const snapshot = new ToolRegistry();
  for (const tool of source.list()) {
    const boundary = getToolExecutionBoundary(tool);
    if (!boundary) {
      throw unsafeTool(tool.name, "no reviewed execution boundary");
    }
    if (boundary.kind === "workspace") {
      let boundaryRoot: string;
      try {
        boundaryRoot = realpathSync(resolve(boundary.root));
      } catch {
        throw unsafeTool(tool.name, "workspace boundary does not exist");
      }
      if (boundary.access !== "read" || boundaryRoot !== workspace) {
        throw unsafeTool(tool.name, "workspace boundary does not match this session");
      }
    } else if (boundary.kind === "sandbox") {
      let boundaryRoot: string;
      try {
        boundaryRoot = realpathSync(resolve(boundary.root));
      } catch {
        throw unsafeTool(tool.name, "sandbox workspace boundary does not exist");
      }
      if (boundaryRoot !== workspace) {
        throw unsafeTool(tool.name, "sandbox workspace boundary does not match this session");
      }
    } else if (boundary.kind !== "pure") {
      throw unsafeTool(tool.name, "unknown execution boundary");
    }

    // Capture the reviewed functions and scalar metadata. The injected
    // registry and tool object may subsequently be mutated by their owner;
    // neither mutation can change this session's executable surface.
    const authorization = tool.authorization?.bind(tool);
    const execute = tool.execute.bind(tool);
    const safeTool: Tool = Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(authorization ? { authorization } : {}),
      execute,
    });
    snapshot.add(safeTool);
  }
  return snapshot;
}

export class AgentConnection {
  private readonly sessions = new Map<string, SessionState>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly root: string;
  private readonly modelFactories: Map<string, () => Model>;
  private readonly modelNames: string[];
  private readonly defaultModel: string;
  private readonly sessionDbPath: string | undefined;
  private readonly permissionTimeoutMs: number;
  private readonly maxSessionsPerConnection: number;
  private readonly createdSessionTimeoutMs: number;
  private readonly run: (options: RunOptions) => Promise<RunResult>;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly send: (wire: string) => void,
    private readonly options: AgentConnectionOptions,
  ) {
    validateAgentAdvertisement(options);
    // Object.entries deliberately ignores inherited properties. Keeping the
    // snapshot in a Map also makes later lookups immune to prototype keys such
    // as `toString` and to mutation of the caller's object.
    this.modelFactories = new Map(Object.entries(options.models));
    this.modelNames = [...this.modelFactories.keys()];
    this.defaultModel = options.defaultModel ?? this.modelNames[0]!;
    this.root = realpathSync(resolve(options.workspaceRoot ?? process.cwd()));
    const configuredSessionDbPath = options.sessionDbPath === false
      ? undefined
      : options.sessionDbPath
        ? resolve(options.sessionDbPath)
        : options.sandbox
          ? join(
              tmpdir(),
              "harness-agent-server",
              createHash("sha256").update(this.root).digest("hex").slice(0, 24),
              "sessions.sqlite",
            )
          : join(this.root, "tasks", "runs", "agent-server.sqlite");
    this.sessionDbPath = configuredSessionDbPath
      ? canonicalProspectivePath(configuredSessionDbPath)
      : undefined;
    if (
      options.sandbox &&
      this.sessionDbPath &&
      pathIsWithin(this.root, this.sessionDbPath)
    ) {
      throw new Error(
        "sandbox-enabled agent-server sessionDbPath must be outside the workspace",
      );
    }
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 120_000;
    this.maxSessionsPerConnection = options.maxSessionsPerConnection ?? 32;
    this.createdSessionTimeoutMs = options.createdSessionTimeoutMs ?? 5 * 60_000;
    if (
      !Number.isInteger(this.maxSessionsPerConnection) ||
      this.maxSessionsPerConnection <= 0 ||
      !Number.isFinite(this.createdSessionTimeoutMs) ||
      this.createdSessionTimeoutMs <= 0
    ) {
      throw new Error("agent server session limits must be positive");
    }
    this.run = options.run ?? runAgent;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? ((prefix) => `${prefix}-${randomUUID()}`);
  }

  receive(raw: string): void {
    if (this.closed) return;
    const id = requestId(raw);
    let message;
    try {
      message = decodeAcpMessage(raw);
      if (!("method" in message) || !("id" in message)) {
        throw operationalError("ACP_INVALID_REQUEST", "ACP clients must send JSON-RPC requests", ACP_RPC_ERROR_CODES.invalidRequest);
      }
    } catch (error) {
      this.sendError(id, error);
      return;
    }
    let operation!: Promise<void>;
    operation = this.route(message)
      .then(
        (result) => this.sendWire(acpSuccess(message.id, result)),
        (error) => this.sendError(message.id, error),
      )
      .catch(() => this.close())
      .finally(() => this.inFlight.delete(operation));
    this.inFlight.add(operation);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      this.denyPending(session, "ACP client disconnected");
      session.abort.abort();
      if (session.state === "created") {
        session.state = "canceled";
        this.finishSession(session);
      }
    }
  }

  /** Wait until canceled prompts have finished cooperative tool cleanup. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async route(request: AcpRequest): Promise<unknown> {
    if (request.method === ACP_METHODS.initialize) {
      return this.initialize(request.params as AcpInitializeParams);
    }
    if (!this.initialized) {
      throw operationalError("ACP_NOT_INITIALIZED", "initialize must be called first", ACP_RPC_ERROR_CODES.notInitialized);
    }
    switch (request.method) {
      case ACP_METHODS.newSession:
        return this.newSession(request.params as AcpNewSessionParams);
      case ACP_METHODS.prompt:
        return this.prompt(request.params as AcpPromptParams);
      case ACP_METHODS.respondPermission:
        return this.respondPermission(request.params as AcpPermissionResponseParams);
      case ACP_METHODS.cancelSession:
        return this.cancelSession(request.params as AcpCancelSessionParams);
    }
  }

  private initialize(params: AcpInitializeParams): unknown {
    if (this.initialized) {
      throw operationalError("ACP_INVALID_REQUEST", "connection is already initialized", ACP_RPC_ERROR_CODES.invalidRequest);
    }
    if (params.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw operationalError(
        "ACP_PROTOCOL_VERSION",
        `unsupported ACP protocol version: ${params.protocolVersion}`,
        ACP_RPC_ERROR_CODES.protocolVersion,
      );
    }
    if (
      params.capabilities.streaming !== true ||
      params.capabilities.permissioning !== true
    ) {
      throw operationalError(
        "ACP_INVALID_PARAMS",
        "M3 clients must support streaming and permissioning",
        ACP_RPC_ERROR_CODES.invalidParams,
      );
    }
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentName: this.options.agentName ?? DEFAULT_AGENT_NAME,
      agentVersion: this.options.agentVersion ?? DEFAULT_AGENT_VERSION,
      capabilities: { streaming: true, permissioning: true, sessions: false },
      models: this.modelNames,
    };
  }

  private async newSession(params: AcpNewSessionParams): Promise<unknown> {
    if (this.sessions.size >= this.maxSessionsPerConnection) {
      throw operationalError(
        "ACP_SESSION_LIMIT",
        `connection session limit (${this.maxSessionsPerConnection}) reached`,
        ACP_RPC_ERROR_CODES.sessionLimit,
      );
    }
    let workspace: string;
    try {
      const lexical = openWorkspace(this.root).resolvePath(params.workspace);
      workspace = realpathSync(lexical);
      openWorkspace(this.root).resolvePath(workspace);
    } catch {
      throw operationalError("ACP_INVALID_PARAMS", "workspace must exist inside the configured root", ACP_RPC_ERROR_CODES.invalidParams);
    }
    const modelName = params.model ?? this.defaultModel;
    const modelFactory = this.modelFactories.get(modelName);
    if (!modelFactory) {
      throw operationalError("ACP_INVALID_PARAMS", `unknown model: ${modelName}`, ACP_RPC_ERROR_CODES.invalidParams);
    }
    let manifest: TaskManifest | undefined;
    if (params.taskId) {
      try {
        manifest = await (
          this.options.loadManifest ??
          ((root, taskId) => loadTaskManifestFile(join(root, "tasks", `${taskId}.yaml`)))
        )(workspace, params.taskId);
      } catch {
        throw operationalError(
          "ACP_INVALID_PARAMS",
          `task manifest ${JSON.stringify(params.taskId)} was not found or is invalid`,
          ACP_RPC_ERROR_CODES.invalidParams,
        );
      }
      if (manifest.id !== params.taskId) {
        throw operationalError(
          "ACP_INVALID_PARAMS",
          `task manifest id does not match ${JSON.stringify(params.taskId)}`,
          ACP_RPC_ERROR_CODES.invalidParams,
        );
      }
    }
    const sessionId = this.newId("sess");
    const context: AgentSessionContext = {
      sessionId,
      workspace,
      taskId: params.taskId,
      manifest,
      modelName,
    };
    const model = modelFactory();
    const tools = snapshotHostTools(
      this.options.tools?.(context) ?? new ToolRegistry(),
      workspace,
    );
    if (this.options.sandbox && manifest && tools.has(SANDBOX_EXEC_TOOL)) {
      throw unsafeTool(SANDBOX_EXEC_TOOL, "reserved built-in tool name");
    }
    const store = this.sessionDbPath
      ? openSqliteSession(this.sessionDbPath, { sessionId, taskId: params.taskId, createdAt: this.now() })
      : undefined;
    const state: SessionState = {
      ...context,
      state: "created",
      model,
      tools,
      eventCount: 0,
      appendQueue: Promise.resolve(),
      store,
      abort: new AbortController(),
      pending: new Map(),
      resolvedPermissions: new Set(),
      runPermissionGrants: new Set(),
      sandboxRuns: 0,
    };
    if (this.options.sandbox && manifest) {
      const sandboxRunPrefix = createHash("sha256")
        .update(sessionId)
        .digest("hex")
        .slice(0, 24);
      state.tools.add(createAgentSandboxTool({
        sessionId,
        workspace,
        manifest,
        options: this.options.sandbox,
        nextRunId: () => `session-${sandboxRunPrefix}-${++state.sandboxRuns}`,
        resolvePermission: (decision, callId) => this.resolveSandboxPermission(
          state,
          decision,
          callId,
        ),
        onDecision: (outcome) => this.recordSandboxDecision(state, outcome),
        onEvent: (event) => this.recordEvent(state, event),
      }));
    }
    state.idleTimer = setTimeout(() => {
      if (state.state !== "created") return;
      state.state = "canceled";
      state.abort.abort();
      this.finishSession(state);
    }, this.createdSessionTimeoutMs);
    state.idleTimer.unref();
    this.sessions.set(sessionId, state);
    return { sessionId };
  }

  private async prompt(params: AcpPromptParams): Promise<unknown> {
    const session = this.requireSession(params.sessionId);
    if (session.state !== "created") {
      throw operationalError(
        "ACP_SESSION_ALREADY_RUN",
        `session ${session.sessionId} already has a kernel run`,
        ACP_RPC_ERROR_CODES.sessionAlreadyRun,
      );
    }
    // Atomic before the first await: concurrent prompts cannot both start.
    session.state = "running";
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    const rules = compileRules(session.manifest?.permissions);
    const manifestBudget = session.manifest?.budget;
    let result: RunResult;
    try {
      result = await this.run({
        goal: params.content,
        sessionId: session.sessionId,
        workspace: session.workspace,
        taskId: session.taskId,
        model: session.model,
        tools: session.tools,
        budget: {
          maxModelTokens: boundedBudget(params.maxModelTokens, manifestBudget?.max_model_tokens),
          maxToolCalls: boundedBudget(params.maxToolCalls, manifestBudget?.max_tool_calls),
        },
        signal: session.abort.signal,
        onEvent: (event) => this.recordEvent(session, event),
        permission: {
          decide: (intent) => rules.decide(intent.action, intent.subject),
          resolve: (request) => this.awaitPermission(session, request),
        },
      });
      session.state = session.abort.signal.aborted
        ? "canceled"
        : result.status === "failed" ? "failed" : "completed";
    } catch (error) {
      session.state = session.appendError
        ? "failed"
        : session.abort.signal.aborted
          ? "canceled"
          : "failed";
      await session.appendQueue;
      this.finishSession(session);
      throw error;
    }
    await session.appendQueue;
    if (session.appendError) {
      session.state = "failed";
      this.finishSession(session);
      throw new Error("session event persistence failed");
    }
    this.finishSession(session);
    return {
      status: result.status,
      // M3 requires streaming clients and does not advertise replay. Avoid
      // duplicating the entire stream into one frame at prompt completion.
      events: [],
      finalText: result.text,
      usage: result.usage,
    };
  }

  private respondPermission(params: AcpPermissionResponseParams): unknown {
    const session = this.requireSession(params.sessionId);
    const pending = session.pending.get(params.permissionId);
    if (!pending) {
      if (session.resolvedPermissions.has(params.permissionId)) {
        throw operationalError(
          "ACP_PERMISSION_RESOLVED",
          `permission ${params.permissionId} was already resolved`,
          ACP_RPC_ERROR_CODES.permissionResolved,
        );
      }
      throw operationalError(
        "ACP_PERMISSION_NOT_FOUND",
        `permission ${params.permissionId} is not pending`,
        ACP_RPC_ERROR_CODES.permissionNotFound,
      );
    }
    clearTimeout(pending.timer);
    session.pending.delete(params.permissionId);
    session.resolvedPermissions.add(params.permissionId);
    if (params.decision === "allow" && pending.request.scope === "run") {
      session.runPermissionGrants.add(this.permissionGrantKey(pending.request));
    }
    pending.resolve({ decision: params.decision, note: params.note });
    return { accepted: true };
  }

  private cancelSession(params: AcpCancelSessionParams): unknown {
    const session = this.requireSession(params.sessionId);
    if (session.state === "completed" || session.state === "failed" || session.state === "canceled") {
      return { canceled: false };
    }
    this.denyPending(session, "session canceled");
    session.abort.abort();
    if (session.state === "created") {
      session.state = "canceled";
      this.finishSession(session);
    }
    return { canceled: true };
  }

  private awaitPermission(
    session: SessionState,
    request: PermissionRequest,
  ): Promise<{ decision: "allow" | "deny"; note?: string }> {
    if (session.abort.signal.aborted) {
      return Promise.resolve({ decision: "deny", note: "session canceled" });
    }
    return new Promise((resolvePermission) => {
      const timer = setTimeout(() => {
        session.pending.delete(request.permissionId);
        session.resolvedPermissions.add(request.permissionId);
        resolvePermission({ decision: "deny", note: "permission request timed out" });
      }, this.permissionTimeoutMs);
      session.pending.set(request.permissionId, {
        resolve: resolvePermission,
        timer,
        request,
      });
    });
  }

  private permissionGrantKey(
    request: Pick<PermissionRequest, "action" | "subject">,
  ): string {
    return JSON.stringify([request.action, request.subject ?? null]);
  }

  private async resolveSandboxPermission(
    session: SessionState,
    decision: Decision,
    callId: string,
  ): Promise<"allow" | "deny"> {
    this.recordEvent(session, createEvent("policy.decision", {
      action: decision.action,
      subject: decision.subject,
      effect: decision.effect,
      reason: decision.reason,
    }, { actor: "sandbox-runner", at: this.now() }));

    const request: PermissionRequest = {
      permissionId: this.newId("perm"),
      sessionId: session.sessionId,
      callId,
      action: decision.action,
      subject: decision.subject,
      scope: "run",
      reason: decision.reason,
    };
    if (session.runPermissionGrants.has(this.permissionGrantKey(request))) {
      return "allow";
    }

    this.recordEvent(session, createEvent("permission.requested", request, {
      actor: "sandbox-runner",
      at: this.now(),
    }));
    const resolution = await this.awaitPermission(session, request);
    this.recordEvent(session, createEvent("permission.resolved", {
      ...request,
      decision: resolution.decision,
      note: resolution.note,
    }, { actor: "operator", at: this.now() }));
    return resolution.decision;
  }

  private recordSandboxDecision(
    session: SessionState,
    outcome: EnforcedDecision,
  ): void {
    // Ask decisions are emitted before their permission request above.
    if (outcome.decision.effect === "ask") return;
    this.recordEvent(session, createEvent("policy.decision", {
      action: outcome.decision.action,
      subject: outcome.decision.subject,
      effect: outcome.decision.effect,
      reason: outcome.decision.reason,
    }, { actor: "sandbox-runner", at: this.now() }));
  }

  private denyPending(session: SessionState, note: string): void {
    for (const [permissionId, pending] of session.pending) {
      clearTimeout(pending.timer);
      session.resolvedPermissions.add(permissionId);
      pending.resolve({ decision: "deny", note });
    }
    session.pending.clear();
  }

  private recordEvent(session: SessionState, event: AnyHarnessEvent): void {
    let safe: AnyHarnessEvent;
    try {
      safe = redactEvent(event);
    } catch (error) {
      session.appendError ??= error;
      session.abort.abort();
      safe = createEvent("error", {
        code: "EVENT_REDACTION_FAILED",
        message: "an event could not be safely recorded",
        retryable: false,
      }, { actor: "agent-server", at: this.now() });
    }
    const seq = session.eventCount++;
    if (session.store) {
      // SqliteEventLog performs its append synchronously before returning its
      // Promise. Start it here so an allow decision is durably ordered before
      // the kernel can cross the following tool boundary; retain the queue to
      // aggregate completion/failure before the session closes.
      const pendingAppend = session.store.log.append(safe).catch((error) => {
          session.appendError ??= error;
          session.abort.abort();
        });
      session.appendQueue = session.appendQueue.then(async () => {
        await pendingAppend;
      });
    }
    try {
      this.sendWire(acpEvent({ sessionId: session.sessionId, seq, event: safe }));
    } catch (error) {
      session.appendError ??= error;
      session.abort.abort();
    }
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw operationalError("ACP_SESSION_NOT_FOUND", `unknown session: ${sessionId}`, ACP_RPC_ERROR_CODES.sessionNotFound);
    }
    return session;
  }

  private finishSession(session: SessionState): void {
    this.denyPending(session, "session finished");
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    try {
      if (session.store) {
        if (this.sessionDbPath) {
          setSessionStatus(this.sessionDbPath, session.sessionId, "closed", this.now());
        }
      }
    } finally {
      this.closeStore(session);
    }
  }

  private closeStore(session: SessionState): void {
    session.store?.close();
    session.store = undefined;
  }

  private sendError(id: AcpRequestId | null, error: unknown): void {
    if (error instanceof AcpProtocolError) {
      this.sendWire(acpFailure(id, error.rpcCode, error.message, { code: error.code }));
      return;
    }
    this.sendWire(acpFailure(id, ACP_RPC_ERROR_CODES.internalError, "agent server request failed"));
  }

  private sendWire(message: unknown): void {
    if (!this.closed) this.send(JSON.stringify(message));
  }
}

import { createEvent, type AnyHarnessEvent } from "@harness/events";
import {
  addUsage,
  emptyUsage,
  type ChatMessage,
  type Model,
  type ToolDefinition,
  type Usage,
} from "@harness/models";
import {
  ToolRegistry,
  type ToolPermissionIntent,
} from "@harness/tools";
import { randomUUID } from "node:crypto";

/**
 * The kernel is the language-level agent loop. It knows no transport, storage,
 * policy implementation, or terminal UI. Those boundaries inject decisions
 * and permission resolution while the kernel owns ordering and enforcement.
 */

export interface Budget {
  maxModelTokens?: number;
  maxToolCalls?: number;
}

const BUDGET_WARNING_THRESHOLD = 0.5;

export class BudgetExceededError extends Error {
  constructor(
    readonly metric: "tokens" | "tool_calls",
    readonly used: number,
    readonly limit: number,
  ) {
    super(`budget exceeded: ${metric} used=${used} limit=${limit}`);
    this.name = "BudgetExceededError";
  }
}

export class ToolExecutionError extends Error {
  constructor(readonly tool: string, cause?: unknown) {
    super(`tool "${tool}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ToolExecutionError";
  }
}

export class RunCanceledError extends Error {
  constructor() {
    super("agent run canceled");
    this.name = "RunCanceledError";
  }
}

export class InvalidModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelResponseError";
  }
}

export class InvalidToolResultError extends Error {
  constructor(message = "tool result is not a bounded JSON value") {
    super(message);
    this.name = "InvalidToolResultError";
  }
}

const MAX_TOOL_JSON_DEPTH = 64;
const MAX_TOOL_JSON_NODES = 10_000;
// Keep each tool.call/tool.result comfortably below the ACP 1 MiB frame cap,
// including its event envelope and JSON escaping.
const MAX_TOOL_JSON_BYTES = 256 * 1024;
const MAX_TOOL_TRANSCRIPT_JSON_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_CONTENT_JSON_BYTES = 512 * 1024;
const MAX_TOOL_CALLS_PER_TURN = 128;

export interface NormalizedToolJson {
  value: unknown;
  wire: string;
}

/** Clone untrusted model/tool values into a stable, bounded JSON tree. */
export function normalizeToolJson(input: unknown): NormalizedToolJson {
  const sourceRoot = input === undefined ? null : input;
  const primitive = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw new InvalidToolResultError();
  };
  if (typeof sourceRoot !== "object" || sourceRoot === null) {
    const value = primitive(sourceRoot);
    const wire = JSON.stringify(value);
    if (Buffer.byteLength(wire, "utf8") > MAX_TOOL_JSON_BYTES) {
      throw new InvalidToolResultError();
    }
    return { value, wire };
  }

  const makeContainer = (value: object): unknown[] | Record<string, unknown> => {
    if (Array.isArray(value)) return [];
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidToolResultError();
    }
    return Object.create(null) as Record<string, unknown>;
  };
  const root = makeContainer(sourceRoot);
  const seen = new WeakSet<object>([sourceRoot]);
  const stack: Array<{
    source: object;
    target: unknown[] | Record<string, unknown>;
    depth: number;
  }> = [{ source: sourceRoot, target: root, depth: 0 }];
  let nodes = 1;

  const dataEntries = (source: object): Array<[string, unknown]> => {
    const descriptors = Object.getOwnPropertyDescriptors(
      source,
    ) as unknown as PropertyDescriptorMap;
    if (Array.isArray(source)) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (
        !Number.isSafeInteger(length) ||
        (length as number) < 0 ||
        (length as number) > MAX_TOOL_JSON_NODES
      ) {
        throw new InvalidToolResultError();
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue;
        if (typeof key !== "string") throw new InvalidToolResultError();
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= (length as number) ||
          String(index) !== key
        ) {
          throw new InvalidToolResultError();
        }
      }
      return Array.from({ length: length as number }, (_unused, index) => {
        const key = String(index);
        const descriptor = descriptors[key];
        if (descriptor === undefined) return [key, null];
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new InvalidToolResultError();
        }
        return [key, descriptor.value];
      });
    }

    const entries: Array<[string, unknown]> = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new InvalidToolResultError();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new InvalidToolResultError();
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  };

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.depth >= MAX_TOOL_JSON_DEPTH) throw new InvalidToolResultError();
      const entries = dataEntries(frame.source);
      nodes += entries.length;
      if (nodes > MAX_TOOL_JSON_NODES) throw new InvalidToolResultError();
      for (const [key, raw] of entries) {
        let cloned: unknown;
        if (typeof raw !== "object" || raw === null) {
          cloned = primitive(raw);
        } else {
          if (seen.has(raw)) throw new InvalidToolResultError();
          seen.add(raw);
          cloned = makeContainer(raw);
          stack.push({
            source: raw,
            target: cloned as unknown[] | Record<string, unknown>,
            depth: frame.depth + 1,
          });
        }
        if (Array.isArray(frame.target)) frame.target[Number(key)] = cloned;
        else frame.target[key] = cloned;
      }
    }
  } catch (error) {
    if (error instanceof InvalidToolResultError) throw error;
    throw new InvalidToolResultError();
  }

  let wire: string;
  try {
    wire = JSON.stringify(root);
  } catch {
    throw new InvalidToolResultError();
  }
  if (Buffer.byteLength(wire, "utf8") > MAX_TOOL_JSON_BYTES) {
    throw new InvalidToolResultError();
  }
  return { value: root, wire };
}

function validateModelResponse(
  response: Awaited<ReturnType<Model["complete"]>>,
): void {
  try {
    if (
      response === null ||
      typeof response !== "object" ||
      typeof response.id !== "string" ||
      response.id.length === 0 ||
      response.id.length > 512 ||
      typeof response.content !== "string" ||
      Buffer.byteLength(JSON.stringify(response.content), "utf8") > MAX_MODEL_CONTENT_JSON_BYTES ||
      !Array.isArray(response.toolCalls) ||
      response.toolCalls.length > MAX_TOOL_CALLS_PER_TURN ||
      !["stop", "tool_calls", "length", "error"].includes(response.finishReason) ||
      response.usage === null ||
      typeof response.usage !== "object"
    ) {
      throw new Error();
    }
    for (const value of [
      response.usage.promptTokens,
      response.usage.completionTokens,
      response.usage.totalTokens,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error();
    }
    if (
      response.usage.totalTokens !==
      response.usage.promptTokens + response.usage.completionTokens
    ) {
      throw new Error();
    }
  } catch {
    throw new InvalidModelResponseError("model returned an invalid or oversized response");
  }
}

export interface PermissionDecision {
  effect: "allow" | "ask" | "deny";
  reason: string;
  ruleId?: string;
}

export interface PermissionRequest extends ToolPermissionIntent {
  permissionId: string;
  sessionId: string;
  callId: string;
  scope: "once" | "run";
  reason?: string;
}

export interface PermissionResolution {
  decision: "allow" | "deny";
  note?: string;
}

export interface PermissionController {
  /** Pure policy decision. The kernel enforces the returned effect. */
  decide(intent: ToolPermissionIntent): PermissionDecision;
  /** Resolve an `ask`. Missing or failed resolution is a denial. */
  resolve?(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionResolution | "allow" | "deny">;
}

export interface RunOptions {
  goal: string;
  model: Model;
  tools?: ToolRegistry;
  budget?: Budget;
  /** Hard cap on model turns. Defaults to 8. */
  maxSteps?: number;
  taskId?: string;
  sessionId?: string;
  workspace?: string;
  /**
   * Durable event sink. The kernel awaits this hook before advancing across a
   * model or tool boundary; rejection fails the run instead of leaving an
   * unaudited side effect behind.
   */
  onEvent?: (event: AnyHarnessEvent) => unknown;
  permission?: PermissionController;
  signal?: AbortSignal;
  now?: () => string;
  newId?: (prefix: string) => string;
}

export interface RunResult {
  status: "completed" | "failed";
  text: string;
  usage: Usage;
  steps: number;
  toolCalls: number;
  events: AnyHarnessEvent[];
}

function safeErrorCode(error: unknown): string {
  const candidate = (error as { code?: unknown } | undefined)?.code;
  return typeof candidate === "string" && /^[A-Z0-9_]{2,80}$/.test(candidate)
    ? candidate
    : "MODEL_COMPLETION_FAILED";
}

function normalizeResolution(
  value: PermissionResolution | "allow" | "deny",
): PermissionResolution {
  const normalized = typeof value === "string" ? { decision: value } : value;
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    (normalized.decision !== "allow" && normalized.decision !== "deny") ||
    (normalized.note !== undefined && (
      typeof normalized.note !== "string" || normalized.note.length > 4096
    ))
  ) {
    throw new Error("invalid permission resolution");
  }
  return normalized;
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new RunCanceledError();
  let onAbort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RunCanceledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const at = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const events: AnyHarnessEvent[] = [];
  const emit = async (event: AnyHarnessEvent): Promise<void> => {
    events.push(event);
    await opts.onEvent?.(event);
  };

  const budget = opts.budget ?? {};
  const maxSteps = opts.maxSteps ?? 8;
  const sessionId = opts.sessionId ?? newId("sess");
  const agentId = newId("agent");
  const model = opts.model;
  const tools = opts.tools ?? new ToolRegistry();
  const taskId = opts.taskId;
  const toolDefinitions: ToolDefinition[] = tools.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object" },
  }));

  let usage = emptyUsage();
  let toolCalls = 0;
  let steps = 0;
  let warnedTokens = false;
  let warnedCalls = false;
  let finalText = "";
  let done = false;
  let stopped = false;
  let toolTranscriptBytes = 0;
  const runPermissionGrants = new Set<string>();
  const messages: ChatMessage[] = [{ role: "user", content: opts.goal }];

  const permissionGrantKey = (intent: ToolPermissionIntent): string =>
    JSON.stringify([intent.action, intent.subject ?? null]);

  const budgetWarning = (metric: "tokens" | "tool_calls", used: number, limit: number) =>
    emit(createEvent("budget.warning", {
      taskId, metric, used, limit,
      pct: limit > 0 ? Math.round((used / limit) * 100) : 100,
    }, { at: at(), eventId: newId("evt"), actor: "kernel" }));

  const stop = async (
    status: "completed" | "failed" | "canceled" | "budget_exceeded",
    note?: string,
  ) => {
    if (stopped) return;
    stopped = true;
    await emit(createEvent("agent.stopped", {
      agentId, status, steps, toolCalls, note,
    }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
  };

  const cancelIfAborted = async () => {
    if (!opts.signal?.aborted) return;
    await stop("canceled", "abort signal received");
    throw new RunCanceledError();
  };

  await emit(createEvent("session.created", { sessionId, workspace: opts.workspace }, {
    at: at(), eventId: newId("evt"), actor: "kernel",
  }));
  await emit(createEvent("agent.started", {
    agentId, sessionId, taskId, model: model.name,
  }, { at: at(), eventId: newId("evt"), actor: "kernel" }));

  while (steps < maxSteps) {
    await cancelIfAborted();
    const tokenLimitBeforeRequest = budget.maxModelTokens;
    if (
      tokenLimitBeforeRequest !== undefined &&
      usage.totalTokens >= tokenLimitBeforeRequest
    ) {
      await budgetWarning("tokens", usage.totalTokens, tokenLimitBeforeRequest);
      await stop("budget_exceeded", `max_model_tokens=${tokenLimitBeforeRequest}`);
      throw new BudgetExceededError(
        "tokens",
        usage.totalTokens,
        tokenLimitBeforeRequest,
      );
    }
    steps++;
    const requestId = newId("req");
    await emit(createEvent("model.request", {
      requestId, model: model.name, messageCount: messages.length,
    }, { at: at(), eventId: newId("evt"), actor: "kernel" }));

    let response: Awaited<ReturnType<Model["complete"]>>;
    try {
      const remaining = budget.maxModelTokens === undefined
        ? undefined
        : budget.maxModelTokens - usage.totalTokens;
      response = await model.complete({
        messages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        maxTokens: remaining,
        signal: opts.signal,
      });
    } catch (error) {
      await emit(createEvent("model.response", {
        requestId,
        model: model.name,
        finishReason: "error",
        usage: emptyUsage(),
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      const canceled = opts.signal?.aborted || error instanceof RunCanceledError;
      await emit(createEvent("error", {
        code: canceled ? "RUN_CANCELED" : safeErrorCode(error),
        message: canceled
          ? "agent run canceled"
          : `model completion failed for ${model.name}`,
        retryable: canceled ? false : Boolean((error as { retryable?: unknown })?.retryable),
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop(canceled ? "canceled" : "failed", canceled ? "abort signal received" : "model completion failed");
      if (canceled) throw new RunCanceledError();
      throw error;
    }

    try {
      validateModelResponse(response);
    } catch (error) {
      await emit(createEvent("model.response", {
        requestId,
        model: model.name,
        finishReason: "error",
        usage: emptyUsage(),
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await emit(createEvent("error", {
        code: "MODEL_INVALID_RESPONSE",
        message: "model returned an invalid or oversized response",
        retryable: false,
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "invalid model response");
      throw error;
    }

    const accumulatedUsage = addUsage(usage, response.usage);
    if (
      !Number.isSafeInteger(accumulatedUsage.promptTokens) ||
      !Number.isSafeInteger(accumulatedUsage.completionTokens) ||
      !Number.isSafeInteger(accumulatedUsage.totalTokens)
    ) {
      await emit(createEvent("model.response", {
        requestId,
        model: model.name,
        finishReason: response.finishReason,
        usage: response.usage,
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await emit(createEvent("error", {
        code: "MODEL_INVALID_RESPONSE",
        message: "model usage overflowed safe budget accounting",
        retryable: false,
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "model usage overflowed safe budget accounting");
      throw new InvalidModelResponseError(
        "model usage overflowed safe budget accounting",
      );
    }
    usage = accumulatedUsage;
    await emit(createEvent("model.response", {
      requestId,
      model: model.name,
      finishReason: response.finishReason,
      usage: response.usage,
    }, { at: at(), eventId: newId("evt"), actor: "kernel" }));

    const tokenLimit = budget.maxModelTokens;
    if (tokenLimit !== undefined) {
      if (usage.totalTokens > tokenLimit) {
        await budgetWarning("tokens", usage.totalTokens, tokenLimit);
        await stop("budget_exceeded", `max_model_tokens=${tokenLimit}`);
        throw new BudgetExceededError("tokens", usage.totalTokens, tokenLimit);
      }
      if (!warnedTokens && usage.totalTokens >= tokenLimit * BUDGET_WARNING_THRESHOLD) {
        warnedTokens = true;
        await budgetWarning("tokens", usage.totalTokens, tokenLimit);
      }
    }

    const finishReasonMismatch =
      (response.finishReason === "tool_calls" && response.toolCalls.length === 0) ||
      (response.finishReason !== "tool_calls" && response.toolCalls.length > 0);
    if (finishReasonMismatch) {
      await emit(createEvent("error", {
        code: "MODEL_INVALID_RESPONSE",
        message: "model finish reason and tool calls are inconsistent",
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "invalid model response");
      throw new InvalidModelResponseError(
        "finishReason tool_calls requires calls, and calls require finishReason tool_calls",
      );
    }

    if (response.finishReason === "error") {
      await emit(createEvent("error", {
        code: "MODEL_INVALID_RESPONSE",
        message: "model returned an error finish reason",
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "model returned an error finish reason");
      throw new InvalidModelResponseError("model returned finishReason error");
    }

    if (response.finishReason === "length") {
      finalText = response.content;
      await emit(createEvent("error", {
        code: "MODEL_OUTPUT_TRUNCATED",
        message: "model output ended at the provider length limit",
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "model output truncated");
      break;
    }

    try {
      let argumentBytes = 0;
      response = {
        ...response,
        toolCalls: response.toolCalls.map((call) => {
          if (
            typeof call.id !== "string" || call.id.length === 0 || call.id.length > 512 ||
            typeof call.name !== "string" || call.name.length === 0 || call.name.length > 256
          ) {
            throw new InvalidToolResultError();
          }
          const normalized = normalizeToolJson(call.arguments);
          argumentBytes += Buffer.byteLength(normalized.wire, "utf8");
          if (
            toolTranscriptBytes + argumentBytes >
            MAX_TOOL_TRANSCRIPT_JSON_BYTES
          ) {
            throw new InvalidToolResultError();
          }
          return {
            ...call,
            arguments: normalized.value,
          };
        }),
      };
      toolTranscriptBytes += argumentBytes;
    } catch {
      await emit(createEvent("error", {
        code: "MODEL_INVALID_RESPONSE",
        message: "model returned tool arguments that are not bounded JSON",
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      await stop("failed", "invalid model tool arguments");
      throw new InvalidModelResponseError("tool arguments must be bounded JSON values");
    }

    if (response.toolCalls.length === 0) {
      finalText = response.content;
      await stop("completed");
      done = true;
      break;
    }

    if (
      tokenLimit !== undefined &&
      usage.totalTokens >= tokenLimit
    ) {
      await budgetWarning("tokens", usage.totalTokens, tokenLimit);
      await stop("budget_exceeded", `max_model_tokens=${tokenLimit}`);
      throw new BudgetExceededError("tokens", usage.totalTokens, tokenLimit);
    }

    messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });

    for (const call of response.toolCalls) {
      await cancelIfAborted();
      const callLimit = budget.maxToolCalls;
      if (callLimit !== undefined) {
        if (toolCalls >= callLimit) {
          await budgetWarning("tool_calls", toolCalls, callLimit);
          await stop("budget_exceeded", `max_tool_calls=${callLimit}`);
          throw new BudgetExceededError("tool_calls", toolCalls, callLimit);
        }
        if (!warnedCalls && toolCalls >= callLimit - 1) {
          warnedCalls = true;
          await budgetWarning("tool_calls", toolCalls, callLimit);
        }
      }

      const callId = newId("call");
      const started = Date.now();
      await emit(createEvent("tool.call", { callId, tool: call.name, input: call.arguments }, {
        at: at(), eventId: newId("evt"), actor: "kernel",
      }));

      const tool = tools.get(call.name);
      let ok = false;
      let output: unknown;
      let outputWire: string | undefined;
      let error: { code: string; message: string } | undefined;
      let canceledWhileAwaitingPermission = false;
      let canceledDuringTool = false;

      if (!tool) {
        error = { code: "TOOL_NOT_FOUND", message: `unknown tool: ${call.name}` };
      } else {
        const params = tool.parameters.safeParse(call.arguments);
        if (!params.success) {
          const first = params.error.issues[0];
          error = {
            code: "TOOL_BAD_INPUT",
            message: first
              ? `invalid input for ${call.name}: ${first.message} (${first.path.join(".")})`
              : `invalid input for ${call.name}`,
          };
        } else {
          let permitted = true;
          if (opts.permission) {
            let intent: ToolPermissionIntent | undefined;
            let decision: PermissionDecision | undefined;
            try {
              intent = tool.authorization?.(params.data) ?? {
                action: "tool.call",
                subject: call.name,
                scope: "once" as const,
              };
              if (
                !intent || typeof intent.action !== "string" || intent.action.length === 0 ||
                intent.action.length > 256 ||
                (intent.subject !== undefined && (
                  typeof intent.subject !== "string" || intent.subject.length > 4096
                )) ||
                (intent.scope !== undefined && intent.scope !== "once" && intent.scope !== "run")
              ) {
                throw new Error("invalid tool permission intent");
              }
              decision = opts.permission.decide(intent);
              if (
                !decision ||
                (decision.effect !== "allow" && decision.effect !== "ask" && decision.effect !== "deny") ||
                typeof decision.reason !== "string" || decision.reason.length > 4096 ||
                (decision.ruleId !== undefined && (
                  typeof decision.ruleId !== "string" || decision.ruleId.length > 256
                ))
              ) {
                throw new Error("invalid policy decision");
              }
            } catch {
              permitted = false;
              error = {
                code: "TOOL_AUTHORIZATION_FAILED",
                message: "tool authorization failed closed",
              };
              await emit(createEvent("error", {
                code: "TOOL_AUTHORIZATION_FAILED",
                message: `authorization failed for tool ${call.name}`,
                retryable: false,
              }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
            }

            if (intent && decision) {
              await emit(createEvent("policy.decision", {
                action: intent.action,
                subject: intent.subject,
                effect: decision.effect,
                reason: decision.reason,
                ruleId: decision.ruleId,
              }, { at: at(), eventId: newId("evt"), actor: "kernel" }));

              const grantKey = permissionGrantKey(intent);
              const hasRunGrant = (intent.scope ?? "once") === "run" &&
                runPermissionGrants.has(grantKey);

              if (decision.effect === "deny") {
                permitted = false;
                error = { code: "TOOL_POLICY_DENIED", message: decision.reason };
              } else if (decision.effect === "ask" && !hasRunGrant) {
              const request: PermissionRequest = {
                permissionId: newId("perm"),
                sessionId,
                callId,
                action: intent.action,
                subject: intent.subject,
                scope: intent.scope ?? "once",
                reason: decision.reason,
              };
              let resolutionPromise: Promise<PermissionResolution | "allow" | "deny">;
              try {
                resolutionPromise = opts.permission.resolve
                  ? opts.permission.resolve(request)
                  : Promise.resolve({ decision: "deny", note: "no permission resolver" });
              } catch {
                resolutionPromise = Promise.resolve({ decision: "deny", note: "permission resolver failed" });
              }
              await emit(createEvent("permission.requested", request, {
                at: at(), eventId: newId("evt"), actor: "kernel",
              }));
              let resolution: PermissionResolution;
              try {
                const value = await raceWithAbort(resolutionPromise, opts.signal);
                resolution = normalizeResolution(value);
              } catch (resolveError) {
                if (resolveError instanceof RunCanceledError || opts.signal?.aborted) {
                  canceledWhileAwaitingPermission = true;
                  resolution = {
                    decision: "deny",
                    note: "run canceled while awaiting permission",
                  };
                } else {
                  resolution = { decision: "deny", note: "permission resolver failed" };
                }
              }
              await emit(createEvent("permission.resolved", {
                permissionId: request.permissionId,
                sessionId: request.sessionId,
                callId: request.callId,
                action: request.action,
                subject: request.subject,
                scope: request.scope,
                decision: resolution.decision,
                note: resolution.note,
              }, { at: at(), eventId: newId("evt"), actor: "operator" }));
              if (resolution.decision !== "allow") {
                permitted = false;
                error = {
                  code: "TOOL_PERMISSION_DENIED",
                  message: resolution.note ?? "operator denied permission",
                };
              } else if (request.scope === "run") {
                runPermissionGrants.add(grantKey);
              }
              }
            }
          }

          if (permitted) {
            // The awaited event sink above is the durability fence: never
            // cross the tool side-effect boundary after journal failure.
            await cancelIfAborted();
            try {
              const rawOutput = await tool.execute(params.data, {
                signal: opts.signal,
                workspace: opts.workspace,
                sessionId,
                taskId,
                callId,
              });
              if (opts.signal?.aborted) {
                canceledDuringTool = true;
                error = { code: "TOOL_CANCELED", message: "tool canceled" };
              } else {
                const normalized = normalizeToolJson(rawOutput);
                const outputBytes = Buffer.byteLength(normalized.wire, "utf8");
                if (
                  toolTranscriptBytes + outputBytes >
                  MAX_TOOL_TRANSCRIPT_JSON_BYTES
                ) {
                  throw new InvalidToolResultError();
                }
                toolTranscriptBytes += outputBytes;
                output = normalized.value;
                outputWire = normalized.wire;
                ok = true;
              }
            } catch (executeError) {
              canceledDuringTool = Boolean(opts.signal?.aborted);
              error = canceledDuringTool
                ? { code: "TOOL_CANCELED", message: "tool canceled" }
                : executeError instanceof InvalidToolResultError
                  ? {
                      code: "TOOL_INVALID_RESULT",
                      message: "tool result is not a bounded JSON value",
                    }
                : {
                    code: "TOOL_EXECUTION_FAILED",
                    message: executeError instanceof Error ? executeError.message : String(executeError),
                  };
            }
          }
        }
      }

      toolCalls++;
      await emit(createEvent("tool.result", {
        callId,
        tool: call.name,
        ok,
        output,
        error,
        durationMs: Date.now() - started,
      }, { at: at(), eventId: newId("evt"), actor: "kernel" }));
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: ok
          ? outputWire!
          : JSON.stringify({ error: { code: error?.code, message: error?.message } }),
      });
      if (canceledWhileAwaitingPermission || canceledDuringTool) {
        await stop(
          "canceled",
          canceledWhileAwaitingPermission
            ? "abort signal received while awaiting permission"
            : "abort signal received during tool execution",
        );
        throw new RunCanceledError();
      }
    }
  }

  if (!done) await stop("failed", `max_steps=${maxSteps} reached without a final answer`);
  return {
    status: done ? "completed" : "failed",
    text: finalText,
    usage,
    steps,
    toolCalls,
    events,
  };
}

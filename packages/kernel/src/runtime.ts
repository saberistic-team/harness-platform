import { createEvent, type AnyHarnessEvent } from "@harness/events";
import {
  addUsage,
  emptyUsage,
  MAX_MODEL_TEXT_DELTA_CHARS,
  type ChatMessage,
  type CompletionResponse,
  type JsonValue,
  type ModelAdapter as ModelAdapterPort,
  type ModelEvent,
  type ModelRequest,
  type ToolDefinition,
  type ToolCall,
  type Usage,
} from "@harness/models";
import {
  getToolExecutionBoundary,
  ToolRegistry,
  type ToolPermissionIntent,
} from "@harness/tools";
import {
  InvalidToolResultError,
  normalizeToolJson,
  type PermissionController,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionResolution,
} from "./run";
import {
  appendMessage,
  buildModelContext,
  createMessageState,
  type VersionedMessageState,
} from "./state";

/** The minimal runtime emits the platform's one canonical event envelope. */
export type AgentEvent = AnyHarnessEvent;

/** Re-export the model port from @harness/models as part of the kernel API. */
export type ModelAdapter = ModelAdapterPort;

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: ToolError;
}

export interface ToolContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly workspace?: Workspace;
}

/**
 * Compatibility target for the Pi-like runtime.
 *
 * The existing @harness/tools interface remains supported. A later milestone
 * supplies the bounded adapter and keeps authorization outside this shape.
 */
export interface Tool {
  definition: ToolDefinition;
  execute(context: ToolContext, input: unknown): Promise<ToolResult>;
}

/**
 * A deliberately small session-facing port.
 *
 * Production code adapts this to SessionStore/EventLog; this is not a second
 * persistence implementation and therefore defines no competing sequencing,
 * deduplication, checkpoint, or fencing semantics.
 */
export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  readSession(sessionId: string): AsyncIterable<AgentEvent>;
}

export interface CommandRequest {
  argv: readonly [string, ...string[]];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface WorkspaceSnapshot {
  id: string;
  createdAt: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/**
 * Operational workspace compatibility target. The model never receives this
 * object directly; only reviewed bounded tools may invoke it.
 */
export interface Workspace {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  execute(command: CommandRequest): Promise<CommandResult>;
  diff(): Promise<string>;
  snapshot(): Promise<WorkspaceSnapshot>;
  dispose(): Promise<void>;
}

export interface RuntimeBudget {
  /** Maximum model-request rounds in one turn. Defaults to eight. */
  maxSteps?: number;
  /** Hard cumulative prompt + completion token limit. */
  maxModelTokens?: number;
  /** Hard limit on requested tool intentions, including invalid ones. */
  maxToolCalls?: number;
}

export interface RunInput {
  /** Caller-known identities make pre-consumption steering/cancellation safe. */
  runId: string;
  sessionId: string;
  turnId: string;
  input: string;
  /** Explicit audit/provider name; ModelAdapter deliberately has no name. */
  model: string;
  modelAdapter: ModelAdapter;
  eventStore: EventStore;
  /** Only registered pure tools are executable in M7. */
  tools?: ToolRegistry;
  /** Pure policy decision plus optional interactive ask resolver. */
  permission?: PermissionController;
  budget?: RuntimeBudget;
  /** Per-model-round wall-clock deadline. Defaults to 60 seconds. */
  modelTimeoutMs?: number;
  taskId?: string;
  workspace?: string;
  /** Prior replayed context; the input message is appended by the runtime. */
  context?: readonly ChatMessage[];
  system?: string;
  maxTokens?: number;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  now?: () => string;
  newId?: (prefix: string) => string;
}

export interface AgentRuntime {
  run(input: RunInput): AsyncIterable<AgentEvent>;
  steer(runId: string, message: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}

export type AgentRuntimeErrorCode =
  | "RUNTIME_INVALID_INPUT"
  | "RUNTIME_RUN_EXISTS"
  | "RUNTIME_RUN_NOT_FOUND"
  | "RUNTIME_RUN_TERMINAL"
  | "RUNTIME_STEERING_CLOSED"
  | "RUNTIME_EVENT_APPEND_FAILED"
  | "RUNTIME_MODEL_STREAM_INVALID"
  | "RUNTIME_MODEL_TIMEOUT"
  | "RUNTIME_BUDGET_EXCEEDED"
  | "RUNTIME_CONSUMER_INVALID";

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: AgentRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidRunInputError extends AgentRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("RUNTIME_INVALID_INPUT", message, options);
  }
}

export class RunAlreadyExistsError extends AgentRuntimeError {
  constructor(readonly runId: string) {
    super("RUNTIME_RUN_EXISTS", `run already exists: ${runId}`);
  }
}

export class RunNotFoundError extends AgentRuntimeError {
  constructor(readonly runId: string) {
    super("RUNTIME_RUN_NOT_FOUND", `unknown run: ${runId}`);
  }
}

export class RunTerminalError extends AgentRuntimeError {
  constructor(
    readonly runId: string,
    readonly status: RunStatus | "cancel_requested",
  ) {
    super("RUNTIME_RUN_TERMINAL", `run ${runId} is ${status}`);
  }
}

export class SteeringClosedError extends AgentRuntimeError {
  constructor(readonly runId: string) {
    super(
      "RUNTIME_STEERING_CLOSED",
      `run ${runId} has crossed its steering boundary`,
    );
  }
}

export class EventAppendError extends AgentRuntimeError {
  constructor(readonly eventType: AgentEvent["type"], cause: unknown) {
    super(
      "RUNTIME_EVENT_APPEND_FAILED",
      `failed to append ${eventType}`,
      { cause },
    );
  }
}

export class ModelStreamError extends AgentRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("RUNTIME_MODEL_STREAM_INVALID", message, options);
  }
}

export class ModelTimeoutError extends AgentRuntimeError {
  constructor(readonly timeoutMs: number) {
    super(
      "RUNTIME_MODEL_TIMEOUT",
      `model request timed out after ${timeoutMs}ms`,
    );
  }
}

export type RuntimeBudgetMetric = "steps" | "tokens" | "tool_calls";

export class RuntimeBudgetExceededError extends AgentRuntimeError {
  constructor(
    readonly metric: RuntimeBudgetMetric,
    readonly used: number,
    readonly limit: number,
  ) {
    super(
      "RUNTIME_BUDGET_EXCEEDED",
      `budget exceeded: ${metric} used=${used} limit=${limit}`,
    );
  }
}

export class RuntimeConsumerError extends AgentRuntimeError {
  constructor(message: string) {
    super("RUNTIME_CONSUMER_INVALID", message);
  }
}

type RunStatus =
  | "registered"
  | "active"
  | "completing"
  | "completed"
  | "failed"
  | "canceled"
  | "budget_exceeded";

type TerminalTurnStatus = "completed" | "failed" | "canceled" | "budget_exceeded";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
  settled(): boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (done) return;
      done = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (done) return;
      done = true;
      rejectPromise(reason);
    },
    settled: () => done,
  };
}

interface Delivery {
  event: AgentEvent;
  acknowledge?: () => void;
}

interface SteeringMessage {
  messageId: string;
  content: string;
}

interface RuntimeRunState {
  readonly kind: "live";
  readonly input: RunInput;
  readonly controller: AbortController;
  readonly admitted: Deferred<void>;
  readonly finished: Deferred<void>;
  readonly deliveries: Delivery[];
  readonly acknowledgements: Set<() => void>;
  readonly pendingSteering: SteeringMessage[];
  readonly runPermissionGrants: Set<string>;
  readonly warnedBudgets: Set<RuntimeBudgetMetric>;
  readonly seenModelCallIds: Set<string>;
  readonly toolDefinitions: readonly ToolDefinition[];
  status: RunStatus;
  cancelRequested: boolean;
  abandoned: boolean;
  iteratorClaimed: boolean;
  producerFinished: boolean;
  modelRequests: number;
  toolCalls: number;
  usage: Usage;
  messageState: VersionedMessageState;
  toolTranscriptBytes: number;
  agentId?: string;
  terminalPublished: boolean;
  steeringOpen: boolean;
  appendTail: Promise<void>;
  appendFailure?: EventAppendError;
  failure?: AgentRuntimeError;
  pendingModelPull?: Promise<IteratorResult<ModelEvent>>;
  wakeConsumer?: () => void;
  removeExternalAbort?: () => void;
}

interface RunTombstone {
  readonly kind: "terminal";
  readonly runId: string;
  readonly status: TerminalTurnStatus;
}

class CancellationRequested extends AgentRuntimeError {
  constructor() {
    super("RUNTIME_RUN_TERMINAL", "run cancellation requested");
  }
}

const MAX_ID_LENGTH = 256;
const MAX_INPUT_CHARS = 16 * 1024 * 1024;
const MAX_CONTEXT_MESSAGES = 10_000;
const MAX_STEERING_MESSAGES = 1_024;
const MAX_STEERING_CHARS = 256 * 1024;
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_RESPONSE = 128;
const MAX_TOOL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MODEL_TIMEOUT_MS = 60_000;
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;
const MODEL_CLEANUP_GRACE_MS = 100;
const BUDGET_WARNING_THRESHOLD = 0.5;

function assertId(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value.trim().length === 0
  ) {
    throw new InvalidRunInputError(`${name} must be a nonblank string of at most ${MAX_ID_LENGTH} characters`);
  }
}

function assertRunInput(input: RunInput): void {
  if (typeof input !== "object" || input === null) {
    throw new InvalidRunInputError("run input must be an object");
  }
  assertId(input.runId, "runId");
  assertId(input.sessionId, "sessionId");
  assertId(input.turnId, "turnId");
  assertId(input.model, "model");
  if (
    typeof input.input !== "string" ||
    input.input.length === 0 ||
    input.input.length > MAX_INPUT_CHARS
  ) {
    throw new InvalidRunInputError(`input must contain 1-${MAX_INPUT_CHARS} characters`);
  }
  if (!input.modelAdapter || typeof input.modelAdapter.stream !== "function") {
    throw new InvalidRunInputError("modelAdapter.stream is required");
  }
  if (
    !input.eventStore ||
    typeof input.eventStore.append !== "function" ||
    typeof input.eventStore.readSession !== "function"
  ) {
    throw new InvalidRunInputError("eventStore append/readSession are required");
  }
  if (input.context !== undefined && !Array.isArray(input.context)) {
    throw new InvalidRunInputError("context must be an array");
  }
  if ((input.context?.length ?? 0) > MAX_CONTEXT_MESSAGES) {
    throw new InvalidRunInputError(`context is limited to ${MAX_CONTEXT_MESSAGES} messages`);
  }
  if (
    input.maxTokens !== undefined &&
    (!Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0)
  ) {
    throw new InvalidRunInputError("maxTokens must be a positive safe integer");
  }
  if (
    input.modelTimeoutMs !== undefined &&
    (!Number.isSafeInteger(input.modelTimeoutMs) ||
      input.modelTimeoutMs <= 0 ||
      input.modelTimeoutMs > MAX_MODEL_TIMEOUT_MS)
  ) {
    throw new InvalidRunInputError(
      `modelTimeoutMs must be a safe integer between 1 and ${MAX_MODEL_TIMEOUT_MS}`,
    );
  }
  if (
    input.budget !== undefined &&
    (typeof input.budget !== "object" || input.budget === null || Array.isArray(input.budget))
  ) {
    throw new InvalidRunInputError("budget must be an object");
  }
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (
      !["maxSteps", "maxModelTokens", "maxToolCalls"].includes(name) ||
      !Number.isSafeInteger(value) ||
      (value as number) < 0
    ) {
      throw new InvalidRunInputError(
        `${name} must be a nonnegative safe integer runtime budget`,
      );
    }
  }
  if (
    input.tools !== undefined &&
    (typeof input.tools !== "object" ||
      input.tools === null ||
      typeof input.tools.list !== "function" ||
      typeof input.tools.get !== "function")
  ) {
    throw new InvalidRunInputError("tools must be a ToolRegistry");
  }
  if (
    input.permission !== undefined &&
    (typeof input.permission !== "object" ||
      input.permission === null ||
      typeof input.permission.decide !== "function" ||
      (input.permission.resolve !== undefined && typeof input.permission.resolve !== "function"))
  ) {
    throw new InvalidRunInputError("permission must provide decide and an optional resolve");
  }
  if (input.taskId !== undefined) assertId(input.taskId, "taskId");
  if (
    input.workspace !== undefined &&
    (typeof input.workspace !== "string" || input.workspace.length === 0)
  ) {
    throw new InvalidRunInputError("workspace must be a nonempty string");
  }
  if (input.system !== undefined && typeof input.system !== "string") {
    throw new InvalidRunInputError("system must be a string");
  }
  if (
    input.providerOptions !== undefined &&
    (typeof input.providerOptions !== "object" ||
      input.providerOptions === null ||
      Array.isArray(input.providerOptions))
  ) {
    throw new InvalidRunInputError("providerOptions must be an object");
  }
  if (input.now !== undefined && typeof input.now !== "function") {
    throw new InvalidRunInputError("now must be a function");
  }
  if (input.newId !== undefined && typeof input.newId !== "function") {
    throw new InvalidRunInputError("newId must be a function");
  }
  if (
    input.signal !== undefined &&
    (typeof input.signal !== "object" ||
      input.signal === null ||
      typeof input.signal.aborted !== "boolean" ||
      typeof input.signal.addEventListener !== "function" ||
      typeof input.signal.removeEventListener !== "function")
  ) {
    throw new InvalidRunInputError("signal must implement AbortSignal");
  }
}

function cloneUnknown(value: unknown, name: string): unknown {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new InvalidRunInputError(`${name} must be structured-cloneable`, { cause });
  }
}

function cloneContext(messages: readonly ChatMessage[] | undefined): ChatMessage[] {
  return (messages ?? []).map((message) => {
    if (!message || typeof message !== "object" || typeof message.content !== "string") {
      throw new InvalidRunInputError("every context message must have string content");
    }
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, content: message.content };
      case "assistant":
        if (message.toolCalls !== undefined && !Array.isArray(message.toolCalls)) {
          throw new InvalidRunInputError("assistant toolCalls must be an array");
        }
        return {
          role: "assistant",
          content: message.content,
          toolCalls: message.toolCalls?.map((call) => {
            if (!call || typeof call !== "object") {
              throw new InvalidRunInputError("every context tool call must be an object");
            }
            assertId(call.id, "context tool call id");
            assertId(call.name, "context tool call name");
            return {
              id: call.id,
              name: call.name,
              arguments: cloneUnknown(call.arguments, "context tool-call arguments"),
            };
          }),
        };
      case "tool":
        assertId(message.name, "context tool name");
        assertId(message.toolCallId, "context toolCallId");
        return {
          role: "tool",
          content: message.content,
          name: message.name,
          toolCallId: message.toolCallId,
        };
      default:
        throw new InvalidRunInputError("context contains an unknown message role");
    }
  });
}

function snapshotRunInput(input: RunInput): RunInput {
  assertRunInput(input);
  const context = cloneContext(input.context);
  const providerOptions = input.providerOptions === undefined
    ? undefined
    : cloneUnknown(input.providerOptions, "providerOptions") as Record<string, unknown>;
  const modelAdapter = input.modelAdapter;
  const eventStore = input.eventStore;
  const tools = new ToolRegistry(input.tools?.list() ?? []);
  const permission = input.permission === undefined
    ? undefined
    : {
        decide: input.permission.decide.bind(input.permission),
        resolve: input.permission.resolve?.bind(input.permission),
      };

  return {
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    input: input.input,
    model: input.model,
    modelAdapter: {
      stream: modelAdapter.stream.bind(modelAdapter),
    },
    eventStore: {
      append: eventStore.append.bind(eventStore),
      readSession: eventStore.readSession.bind(eventStore),
    },
    tools,
    permission,
    budget: input.budget === undefined ? undefined : { ...input.budget },
    modelTimeoutMs: input.modelTimeoutMs,
    taskId: input.taskId,
    workspace: input.workspace,
    context,
    system: input.system,
    maxTokens: input.maxTokens,
    providerOptions,
    signal: input.signal,
    now: input.now,
    newId: input.newId,
  };
}

function snapshotDataRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelStreamError(`${label} must be a plain data object`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw new ModelStreamError(`${label} could not be inspected`, { cause });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelStreamError(`${label} must be a plain data object`);
  }
  const allowed = new Set(keys);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ModelStreamError(`${label} contains an unknown field`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ModelStreamError(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      throw new ModelStreamError(`${label}.${key} is required`);
    }
  }
  return snapshot;
}

function snapshotDenseArray(
  value: unknown,
  label: string,
  maxLength: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new ModelStreamError(`${label} must be an array`);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
  } catch (cause) {
    throw new ModelStreamError(`${label} could not be inspected`, { cause });
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw new ModelStreamError(`${label} has an invalid length`);
  }
  if ((length as number) > maxLength) {
    throw new ModelStreamError(`${label} exceeds the runtime limit`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ModelStreamError(`${label}[${index}] must be an ordinary array item`);
    }
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => {
    if (typeof key === "symbol") return true;
    if (key === "length") return false;
    const index = Number(key);
    return !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= (length as number) ||
      String(index) !== key;
  })) {
    throw new ModelStreamError(`${label} contains a named or symbol property`);
  }
  return result;
}

function freezeNormalizedJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) freezeNormalizedJson(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      freezeNormalizedJson(item);
    }
  }
  return Object.freeze(value);
}

function normalizeImmutableToolJson(
  value: unknown,
): ReturnType<typeof normalizeToolJson> {
  const normalized = normalizeToolJson(value);
  return {
    value: freezeNormalizedJson(normalized.value),
    wire: normalized.wire,
  };
}

function snapshotPureToolDefinitions(
  tools: ToolRegistry | undefined,
): readonly ToolDefinition[] {
  try {
    return Object.freeze((tools ?? new ToolRegistry())
      .list()
      .filter((tool) => getToolExecutionBoundary(tool)?.kind === "pure")
      .map((tool) => {
        assertId(tool.name, "tool name");
        if (typeof tool.description !== "string") {
          throw new InvalidRunInputError("tool description must be a string");
        }
        const inputSchema = normalizeImmutableToolJson(
          tool.inputSchema ?? { type: "object" },
        ).value;
        if (
          typeof inputSchema !== "object" ||
          inputSchema === null ||
          Array.isArray(inputSchema)
        ) {
          throw new InvalidRunInputError("tool inputSchema must be a JSON object");
        }
        return Object.freeze({
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchema as ToolDefinition["inputSchema"],
        });
      }));
  } catch (cause) {
    if (cause instanceof InvalidRunInputError) throw cause;
    throw new InvalidRunInputError(
      "pure tool definitions must contain bounded ordinary JSON",
      { cause },
    );
  }
}

type ModelEventSnapshot =
  | { readonly type: "text.delta"; readonly delta: unknown }
  | { readonly type: "tool.call"; readonly call: unknown }
  | { readonly type: "response.completed"; readonly response: unknown };

/** Capture one untrusted frame exactly once before inspecting or persisting it. */
function snapshotModelEvent(value: unknown): ModelEventSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelStreamError("model stream emitted a non-object event");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw new ModelStreamError("model stream event could not be inspected", { cause });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelStreamError("model stream event must be a plain data object");
  }

  const typeDescriptor = descriptors.type;
  if (
    !typeDescriptor ||
    !("value" in typeDescriptor) ||
    !typeDescriptor.enumerable
  ) {
    throw new ModelStreamError("model stream event.type must be an enumerable data property");
  }

  const type = typeDescriptor.value;
  const payloadKey = type === "text.delta"
    ? "delta"
    : type === "tool.call"
      ? "call"
      : type === "response.completed"
        ? "response"
        : undefined;
  if (payloadKey === undefined) {
    throw new ModelStreamError("model stream emitted an unknown event type");
  }

  const allowed = new Set(["type", payloadKey]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new ModelStreamError("model stream event contains an unknown field");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ModelStreamError(
        `model stream event.${key} must be an enumerable data property`,
      );
    }
  }
  const payloadDescriptor = descriptors[payloadKey];
  if (
    !payloadDescriptor ||
    !("value" in payloadDescriptor) ||
    !payloadDescriptor.enumerable
  ) {
    throw new ModelStreamError(`model stream event.${payloadKey} is required`);
  }

  switch (type) {
    case "text.delta":
      return { type, delta: payloadDescriptor.value };
    case "tool.call":
      return { type, call: payloadDescriptor.value };
    case "response.completed":
      return { type, response: payloadDescriptor.value };
  }
  throw new ModelStreamError("model stream emitted an unknown event type");
}

function snapshotIteratorResult(value: unknown): IteratorResult<ModelEvent> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelStreamError("model iterator returned a non-object result");
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (cause) {
    throw new ModelStreamError("model iterator result could not be inspected", { cause });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelStreamError("model iterator result must be a plain data object");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (key !== "done" && key !== "value")) {
      throw new ModelStreamError("model iterator result contains an unknown field");
    }
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new ModelStreamError(
        `model iterator result.${key} must be an enumerable data property`,
      );
    }
  }
  const doneDescriptor = descriptors.done;
  if (
    !doneDescriptor ||
    !("value" in doneDescriptor) ||
    typeof doneDescriptor.value !== "boolean"
  ) {
    throw new ModelStreamError("model iterator result.done must be a boolean data property");
  }
  const valueDescriptor = descriptors.value;
  if (!doneDescriptor.value && !valueDescriptor) {
    throw new ModelStreamError("model iterator result.value is required when done is false");
  }
  return doneDescriptor.value
    ? { done: true, value: valueDescriptor && "value" in valueDescriptor
        ? valueDescriptor.value as undefined
        : undefined }
    : { done: false, value: valueDescriptor && "value" in valueDescriptor
        ? valueDescriptor.value as ModelEvent
        : undefined as never };
}

function normalizeStreamedToolCall(
  call: unknown,
  callIds: Set<string>,
  label = "streamed tool intention",
): { call: ToolCall; argumentBytes: number } {
  const snapshot = snapshotDataRecord(
    call,
    ["id", "name", "arguments"],
    label,
  );
  if (
    typeof snapshot.id !== "string" ||
    snapshot.id.length === 0 ||
    snapshot.id.length > MAX_ID_LENGTH ||
    typeof snapshot.name !== "string" ||
    snapshot.name.length === 0 ||
    snapshot.name.length > MAX_ID_LENGTH ||
    callIds.has(snapshot.id)
  ) {
    throw new ModelStreamError(`${label} is invalid or duplicated`);
  }
  let normalized;
  try {
    normalized = normalizeImmutableToolJson(snapshot.arguments);
  } catch (cause) {
    throw new ModelStreamError(`${label} arguments must be bounded JSON`, { cause });
  }
  const normalizedCall: ToolCall = Object.freeze({
    id: snapshot.id,
    name: snapshot.name,
    arguments: normalized.value,
  });
  callIds.add(normalizedCall.id);
  return {
    call: normalizedCall,
    argumentBytes: Buffer.byteLength(normalized.wire, "utf8"),
  };
}

function normalizeCompletion(
  response: unknown,
  streamedText: string,
  streamedToolCalls: readonly ToolCall[],
): CompletionResponse {
  const snapshot = snapshotDataRecord(
    response,
    ["id", "content", "toolCalls", "usage", "finishReason"],
    "model completion",
  );
  const rawCalls = snapshotDenseArray(
    snapshot.toolCalls,
    "model completion.toolCalls",
    MAX_TOOL_CALLS_PER_RESPONSE,
  );
  const usage = snapshotDataRecord(
    snapshot.usage,
    ["promptTokens", "completionTokens", "totalTokens"],
    "model completion.usage",
  );
  if (
    typeof snapshot.id !== "string" ||
    snapshot.id.length === 0 ||
    snapshot.id.length > MAX_ID_LENGTH ||
    typeof snapshot.content !== "string" ||
    snapshot.content.length > MAX_RESPONSE_CHARS ||
    rawCalls.length > MAX_TOOL_CALLS_PER_RESPONSE ||
    typeof snapshot.finishReason !== "string" ||
    !["stop", "tool_calls", "length", "error"].includes(snapshot.finishReason) ||
    !Number.isSafeInteger(usage.promptTokens) ||
    (usage.promptTokens as number) < 0 ||
    !Number.isSafeInteger(usage.completionTokens) ||
    (usage.completionTokens as number) < 0 ||
    !Number.isSafeInteger(usage.totalTokens) ||
    (usage.totalTokens as number) < 0 ||
    usage.totalTokens !==
      (usage.promptTokens as number) + (usage.completionTokens as number)
  ) {
    throw new ModelStreamError("model stream returned an invalid completion");
  }
  if (streamedText.length > 0 && streamedText !== snapshot.content) {
    throw new ModelStreamError("model text deltas do not match completed content");
  }
  const finishReason = snapshot.finishReason as CompletionResponse["finishReason"];
  const finishMismatch =
    (finishReason === "tool_calls" && rawCalls.length === 0) ||
    (finishReason !== "tool_calls" && rawCalls.length > 0);
  if (finishMismatch) {
    throw new ModelStreamError("model finish reason and tool intentions are inconsistent");
  }

  const callIds = new Set<string>();
  let argumentBytes = 0;
  const normalizedCalls = rawCalls.map((call): ToolCall => {
    const normalized = normalizeStreamedToolCall(
      call,
      callIds,
      "completed tool intention",
    );
    argumentBytes += normalized.argumentBytes;
    if (argumentBytes > MAX_TOOL_TRANSCRIPT_BYTES) {
      throw new ModelStreamError("model tool arguments exceeded the transcript limit");
    }
    return normalized.call;
  });

  if (streamedToolCalls.length !== normalizedCalls.length) {
    throw new ModelStreamError("streamed tool intentions do not match the completion");
  }
  for (let index = 0; index < normalizedCalls.length; index++) {
    const streamed = streamedToolCalls[index];
    const completed = normalizedCalls[index];
    if (!streamed || !completed) {
      throw new ModelStreamError("streamed tool intentions are incomplete");
    }
    if (
      streamed.id !== completed.id ||
      streamed.name !== completed.name ||
      !equalToolJson(streamed.arguments, completed.arguments)
    ) {
      throw new ModelStreamError("streamed tool intentions do not match the completion");
    }
  }

  return {
    id: snapshot.id,
    content: snapshot.content,
    toolCalls: normalizedCalls,
    usage: {
      promptTokens: usage.promptTokens as number,
      completionTokens: usage.completionTokens as number,
      totalTokens: usage.totalTokens as number,
    },
    finishReason,
  };
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function normalizePermissionIntent(value: unknown): ToolPermissionIntent {
  if (!isPlainRecord(value)) throw new Error("invalid tool permission intent");
  const { action, subject, scope } = value;
  if (
    typeof action !== "string" ||
    action.length === 0 ||
    action.length > MAX_ID_LENGTH ||
    (subject !== undefined && (typeof subject !== "string" || subject.length > 4096)) ||
    (scope !== undefined && scope !== "once" && scope !== "run")
  ) {
    throw new Error("invalid tool permission intent");
  }
  return Object.freeze({
    action,
    subject: subject as string | undefined,
    scope: scope as "once" | "run" | undefined,
  });
}

function normalizePermissionDecision(value: unknown): PermissionDecision {
  if (!isPlainRecord(value)) throw new Error("invalid policy decision");
  const { effect, reason, ruleId } = value;
  if (
    (effect !== "allow" && effect !== "ask" && effect !== "deny") ||
    typeof reason !== "string" ||
    reason.length > 4096 ||
    (ruleId !== undefined &&
      (typeof ruleId !== "string" || ruleId.length === 0 || ruleId.length > MAX_ID_LENGTH))
  ) {
    throw new Error("invalid policy decision");
  }
  return Object.freeze({
    effect,
    reason,
    ruleId: ruleId as string | undefined,
  });
}

function normalizePermissionResolution(
  value: PermissionResolution | "allow" | "deny",
): PermissionResolution {
  const resolution = typeof value === "string" ? { decision: value } : value;
  if (
    !isPlainRecord(resolution) ||
    (resolution.decision !== "allow" && resolution.decision !== "deny") ||
    (resolution.note !== undefined &&
      (typeof resolution.note !== "string" || resolution.note.length > 4096))
  ) {
    throw new Error("invalid permission resolution");
  }
  return Object.freeze({
    decision: resolution.decision,
    note: resolution.note as string | undefined,
  });
}

function permissionGrantKey(intent: ToolPermissionIntent): string {
  return JSON.stringify([intent.action, intent.subject ?? null]);
}

function toolObservation(
  ok: boolean,
  outputWire: string | undefined,
  error: ToolError | undefined,
): string {
  return ok
    ? outputWire ?? "null"
    : JSON.stringify({ error: { code: error?.code, message: error?.message } });
}

function observeAndRejectThenable(value: unknown, boundary: string): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return;
  }
  const then = (value as { then?: unknown }).then;
  if (typeof then !== "function") return;
  void Promise.resolve(value).catch(() => undefined);
  throw new Error(`${boundary} must be synchronous`);
}

function equalToolJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => equalToolJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && equalToolJson(leftRecord[key], rightRecord[key])
    );
}

/**
 * Deterministic streaming runtime. Durable events are the sole authority for
 * crossing model, policy, permission, and pure-tool boundaries.
 */
export class MinimalAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<string, RuntimeRunState | RunTombstone>();

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const snapshot = snapshotRunInput(input);
    if (this.runs.has(snapshot.runId)) throw new RunAlreadyExistsError(snapshot.runId);
    const toolDefinitions = snapshotPureToolDefinitions(snapshot.tools);

    const state: RuntimeRunState = {
      kind: "live",
      input: snapshot,
      controller: new AbortController(),
      admitted: deferred<void>(),
      finished: deferred<void>(),
      deliveries: [],
      acknowledgements: new Set(),
      pendingSteering: [],
      runPermissionGrants: new Set(),
      warnedBudgets: new Set(),
      seenModelCallIds: new Set(),
      toolDefinitions,
      status: "registered",
      cancelRequested: false,
      abandoned: false,
      iteratorClaimed: false,
      producerFinished: false,
      modelRequests: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      messageState: createMessageState(snapshot.context),
      toolTranscriptBytes: 0,
      terminalPublished: false,
      steeringOpen: true,
      appendTail: Promise.resolve(),
    };
    // These promises are intentionally observed here so a caller that delays
    // iteration or steering never causes an unhandled rejection.
    void state.admitted.promise.catch(() => undefined);
    this.runs.set(snapshot.runId, state);

    if (snapshot.signal) {
      const onAbort = () => {
        void this.requestCancellation(state, true).catch(() => undefined);
      };
      try {
        snapshot.signal.addEventListener("abort", onAbort, { once: true });
        state.removeExternalAbort = () => {
          try {
            snapshot.signal?.removeEventListener("abort", onAbort);
          } catch {
            // A caller-owned signal cannot prevent runtime finalization.
          }
        };
        if (snapshot.signal.aborted) onAbort();
      } catch (cause) {
        const failure = new InvalidRunInputError(
          "signal event subscription failed",
          { cause },
        );
        try {
          snapshot.signal.removeEventListener("abort", onAbort);
        } catch {
          // Best-effort cleanup of a structurally invalid signal.
        }
        state.failure = failure;
        state.status = "failed";
        state.producerFinished = true;
        state.admitted.reject(failure);
        state.finished.resolve(undefined);
        this.runs.delete(snapshot.runId);
        this.wake(state);
        throw failure;
      }
    }

    void this.produce(state).catch((error: unknown) => {
      this.containEscapedProducerFailure(state, error);
    });
    return this.iterableFor(state);
  }

  private containEscapedProducerFailure(
    state: RuntimeRunState,
    error: unknown,
  ): void {
    const failure = error instanceof AgentRuntimeError
      ? error
      : new ModelStreamError("runtime producer failed", { cause: error });
    if (
      state.status !== "completed" &&
      state.status !== "canceled" &&
      state.status !== "budget_exceeded"
    ) {
      state.status = "failed";
      state.failure = failure;
    }
    if (!state.admitted.settled()) state.admitted.reject(failure);
    state.producerFinished = true;
    this.runs.set(state.input.runId, {
      kind: "terminal",
      runId: state.input.runId,
      status: state.status === "completed" ||
        state.status === "canceled" ||
        state.status === "budget_exceeded"
        ? state.status
        : "failed",
    });
    state.finished.resolve(undefined);
    this.releaseAcknowledgements(state);
    this.wake(state);
  }

  async steer(runId: string, message: string): Promise<void> {
    const state = this.lookup(runId);
    if (
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > MAX_STEERING_CHARS
    ) {
      throw new InvalidRunInputError(`steering message must contain 1-${MAX_STEERING_CHARS} characters`);
    }

    await state.admitted.promise;
    this.assertControllable(state);
    let event!: AgentEvent;

    await this.serialize(state, async () => {
      this.assertControllable(state);
      if (!state.steeringOpen) throw new SteeringClosedError(state.input.runId);
      if (state.pendingSteering.length >= MAX_STEERING_MESSAGES) {
        throw new InvalidRunInputError(`a run may queue at most ${MAX_STEERING_MESSAGES} steering messages`);
      }
      const messageId = this.newId(state, "msg");
      event = createEvent("steering.queued", {
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        messageId,
        content: message,
      }, this.eventOptions(state));
      await this.appendRaw(state, event);
      state.pendingSteering.push({ messageId, content: message });
    });
    this.enqueue(state, { event });
  }

  async cancel(runId: string): Promise<void> {
    assertId(runId, "runId");
    const entry = this.runs.get(runId);
    if (!entry) throw new RunNotFoundError(runId);
    if (entry.kind === "terminal") {
      if (entry.status === "canceled") return;
      throw new RunTerminalError(runId, entry.status);
    }
    const state = entry;
    if (state.status === "canceled") return;
    if (state.cancelRequested) {
      await state.finished.promise;
      if (state.failure) throw state.failure;
      return;
    }
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "budget_exceeded" ||
      state.status === "completing"
    ) {
      throw new RunTerminalError(runId, state.status);
    }
    await this.requestCancellation(state, false);
  }

  private lookup(runId: string): RuntimeRunState {
    assertId(runId, "runId");
    const entry = this.runs.get(runId);
    if (!entry) throw new RunNotFoundError(runId);
    if (entry.kind === "terminal") {
      throw new RunTerminalError(runId, entry.status);
    }
    return entry;
  }

  private assertControllable(state: RuntimeRunState): void {
    if (state.cancelRequested) {
      throw new RunTerminalError(state.input.runId, "cancel_requested");
    }
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "canceled" ||
      state.status === "budget_exceeded" ||
      state.status === "completing"
    ) {
      throw new RunTerminalError(state.input.runId, state.status);
    }
  }

  private async requestCancellation(
    state: RuntimeRunState,
    external: boolean,
  ): Promise<void> {
    if (state.status === "canceled") return;
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "budget_exceeded" ||
      state.status === "completing"
    ) {
      if (external) {
        await state.finished.promise;
        if (state.appendFailure) throw state.appendFailure;
        return;
      }
      throw new RunTerminalError(state.input.runId, state.status);
    }
    if (!state.cancelRequested) {
      state.cancelRequested = true;
      const canceled = new CancellationRequested();
      state.controller.abort(canceled);
      this.releaseAcknowledgements(state);
      this.wake(state);
    }
    await state.finished.promise;
    if (state.failure) throw state.failure;
  }

  private iterableFor(state: RuntimeRunState): AsyncIterable<AgentEvent> {
    const runtime = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        if (state.iteratorClaimed) {
          throw new RuntimeConsumerError(`run ${state.input.runId} has a single-use event stream`);
        }
        state.iteratorClaimed = true;
        let closed = false;
        let nextPending = false;
        let previousAcknowledge: (() => void) | undefined;

        const abandon = async (): Promise<void> => {
          if (closed) return;
          closed = true;
          previousAcknowledge?.();
          previousAcknowledge = undefined;
          state.abandoned = true;
          state.deliveries.length = 0;
          await runtime.requestCancellation(state, true);
        };

        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (closed) return { done: true, value: undefined };
            if (nextPending) {
              throw new RuntimeConsumerError("concurrent next() calls are not supported");
            }
            nextPending = true;
            try {
              previousAcknowledge?.();
              previousAcknowledge = undefined;
              const delivery = await runtime.nextDelivery(state);
              if (!delivery) {
                closed = true;
                return { done: true, value: undefined };
              }
              previousAcknowledge = delivery.acknowledge;
              return { done: false, value: delivery.event };
            } catch (error) {
              closed = true;
              throw error;
            } finally {
              nextPending = false;
            }
          },
          async return(): Promise<IteratorResult<AgentEvent>> {
            await abandon();
            return { done: true, value: undefined };
          },
          async throw(error?: unknown): Promise<IteratorResult<AgentEvent>> {
            await abandon();
            throw error;
          },
        };
      },
    };
  }

  private async nextDelivery(state: RuntimeRunState): Promise<Delivery | undefined> {
    while (true) {
      const delivery = state.deliveries.shift();
      if (delivery) return delivery;
      if (state.producerFinished) {
        if (state.failure) throw state.failure;
        return undefined;
      }
      const available = deferred<void>();
      state.wakeConsumer = () => available.resolve(undefined);
      await available.promise;
      if (state.wakeConsumer) state.wakeConsumer = undefined;
    }
  }

  private wake(state: RuntimeRunState): void {
    state.wakeConsumer?.();
    state.wakeConsumer = undefined;
  }

  private enqueue(state: RuntimeRunState, delivery: Delivery): void {
    if (state.abandoned) return;
    state.deliveries.push(delivery);
    this.wake(state);
  }

  private releaseAcknowledgements(state: RuntimeRunState): void {
    for (const acknowledge of [...state.acknowledgements]) acknowledge();
  }

  private createAcknowledgement(state: RuntimeRunState): {
    acknowledge: () => void;
    promise: Promise<void>;
  } {
    const ack = deferred<void>();
    const acknowledge = () => {
      if (ack.settled()) return;
      state.acknowledgements.delete(acknowledge);
      ack.resolve(undefined);
    };
    state.acknowledgements.add(acknowledge);
    if (state.cancelRequested || state.abandoned || state.appendFailure) acknowledge();
    return { acknowledge, promise: ack.promise };
  }

  private async publish(
    state: RuntimeRunState,
    event: AgentEvent,
    allowCanceled = false,
    onConsumed?: () => void,
  ): Promise<void> {
    await this.serialize(state, () => this.appendRaw(state, event));
    const ack = this.createAcknowledgement(state);
    const acknowledge = onConsumed === undefined
      ? ack.acknowledge
      : () => {
          try {
            if (!state.cancelRequested && !state.controller.signal.aborted) {
              onConsumed();
            }
          } finally {
            ack.acknowledge();
          }
        };
    this.enqueue(state, { event, acknowledge });
    if (state.abandoned) ack.acknowledge();
    await ack.promise;
    if (!allowCanceled) this.assertMayProduce(state);
  }

  private async publishBudgetWarning(
    state: RuntimeRunState,
    metric: RuntimeBudgetMetric,
    used: number,
    limit: number,
    force = false,
  ): Promise<void> {
    if (!force && state.warnedBudgets.has(metric)) return;
    state.warnedBudgets.add(metric);
    await this.publish(state, createEvent("budget.warning", {
      taskId: state.input.taskId,
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      metric,
      used,
      limit,
      pct: limit > 0 ? Math.round((used / limit) * 100) : 100,
    }, this.eventOptions(state)));
  }

  private async publishTerminal(
    state: RuntimeRunState,
    status: TerminalTurnStatus,
    outputMessageId?: string,
    note?: string,
  ): Promise<void> {
    if (state.terminalPublished) return;
    const turnEvent = createEvent("turn.completed", {
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      status,
      outputMessageId,
      modelRequests: state.modelRequests,
      toolCalls: state.toolCalls,
      usage: state.usage,
      stateVersion: state.messageState.version,
      messageRevision: state.messageState.revision,
      note,
    }, this.eventOptions(state));
    const stoppedEvent = createEvent("agent.stopped", {
      agentId: state.agentId ?? this.newId(state, "agent"),
      status,
      steps: state.modelRequests,
      toolCalls: state.toolCalls,
      note,
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
    }, this.eventOptions(state));
    state.terminalPublished = true;
    state.status = "completing";
    await this.serialize(state, () => this.appendRaw(state, turnEvent));
    this.enqueue(state, { event: turnEvent });

    await this.serialize(state, () => this.appendRaw(state, stoppedEvent));
    state.status = status;
    this.enqueue(state, { event: stoppedEvent });
  }

  /**
   * Publish one terminal pair. A transient event-construction failure happens
   * before the terminal latch and may be retried once as a failed outcome.
   * Durable append failures are never retried because the store may already
   * contain the attempted event.
   */
  private async finalizeTerminal(
    state: RuntimeRunState,
    status: TerminalTurnStatus,
    outputMessageId?: string,
    note?: string,
  ): Promise<void> {
    try {
      await this.publishTerminal(state, status, outputMessageId, note);
      return;
    } catch (error) {
      const failure = state.appendFailure ??
        (error instanceof AgentRuntimeError
          ? error
          : new ModelStreamError("terminal event construction failed", { cause: error }));
      state.status = "failed";
      state.failure = failure;
      if (state.appendFailure || state.terminalPublished) return;

      try {
        await this.publishTerminal(state, "failed", undefined, failure.message);
      } catch (retryError) {
        state.status = "failed";
        state.failure = state.appendFailure ??
          (retryError instanceof AgentRuntimeError
            ? retryError
            : new ModelStreamError("terminal event construction failed", {
                cause: retryError,
              }));
      }
    }
  }

  private serialize<T>(
    state: RuntimeRunState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = state.appendTail.then(async () => {
      if (state.appendFailure) throw state.appendFailure;
      return await operation();
    });
    state.appendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async appendRaw(state: RuntimeRunState, event: AgentEvent): Promise<void> {
    try {
      await state.input.eventStore.append(event);
    } catch (cause) {
      const failure = cause instanceof EventAppendError
        ? cause
        : new EventAppendError(event.type, cause);
      state.appendFailure = failure;
      state.controller.abort(failure);
      this.releaseAcknowledgements(state);
      this.wake(state);
      throw failure;
    }
  }

  private assertMayProduce(state: RuntimeRunState): void {
    if (state.appendFailure) throw state.appendFailure;
    if (state.cancelRequested || state.controller.signal.aborted) {
      throw new CancellationRequested();
    }
  }

  private eventOptions(state: RuntimeRunState): {
    eventId: string;
    at: string;
    actor: string;
  } {
    return {
      eventId: this.newId(state, "evt"),
      at: (state.input.now ?? (() => new Date().toISOString()))(),
      actor: "kernel",
    };
  }

  private newId(state: RuntimeRunState, prefix: string): string {
    const id = (state.input.newId ?? ((kind: string) => `${kind}-${crypto.randomUUID()}`))(prefix);
    assertId(id, `${prefix} id`);
    return id;
  }

  private async nextModelEvent(
    state: RuntimeRunState,
    next: () => PromiseLike<IteratorResult<ModelEvent>> | IteratorResult<ModelEvent>,
    signal: AbortSignal,
  ): Promise<IteratorResult<ModelEvent>> {
    const interruption = (): AgentRuntimeError =>
      signal.reason instanceof AgentRuntimeError
        ? signal.reason
        : state.cancelRequested
          ? new CancellationRequested()
          : new ModelStreamError("model request aborted");
    if (signal.aborted) {
      throw interruption();
    }

    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw interruption();
      return next();
    });
    state.pendingModelPull = pending;
    void pending.catch(() => undefined);

    let rejectInterrupted!: (reason: AgentRuntimeError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const onAbort = () => {
      rejectInterrupted(interruption());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const result = await Promise.race([pending, interrupted]);
      if (state.pendingModelPull === pending) state.pendingModelPull = undefined;
      return snapshotIteratorResult(result);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async closeModelIterator(
    state: RuntimeRunState,
    iterator: AsyncIterator<ModelEvent> | undefined,
    interrupt?: () => void,
  ): Promise<void> {
    const pending = state.pendingModelPull;
    let closing: Promise<unknown> | undefined;
    if (iterator) {
      try {
        const returnIterator = iterator.return;
        if (typeof returnIterator === "function") {
          closing = Promise.resolve(returnIterator.call(iterator)).catch(() => undefined);
        }
      } catch {
        // Cancellation/failure cleanup must not replace the primary outcome.
      }
    }
    try {
      interrupt?.();
    } catch {
      // Cleanup interruption is best effort and cannot replace the outcome.
    }
    const cleanup = Promise.allSettled([
      ...(pending ? [pending] : []),
      ...(closing ? [closing] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, MODEL_CLEANUP_GRACE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      state.pendingModelPull = undefined;
    }
  }

  private async waitForBoundary<T>(
    state: RuntimeRunState,
    operation: Promise<T>,
  ): Promise<T> {
    const signal = state.controller.signal;
    void operation.catch(() => undefined);
    if (signal.aborted) throw new CancellationRequested();
    let rejectCanceled!: () => void;
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectCanceled = () => reject(new CancellationRequested());
    });
    const onAbort = () => rejectCanceled();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([operation, canceled]);
    } catch (error) {
      if (!signal.aborted) throw error;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation.then(() => undefined, () => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, MODEL_CLEANUP_GRACE_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      throw new CancellationRequested();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private pureToolDefinitions(state: RuntimeRunState): ToolDefinition[] {
    return [...state.toolDefinitions];
  }

  private async checkModelRequestBudgets(state: RuntimeRunState): Promise<void> {
    const stepLimit = state.input.budget?.maxSteps ?? DEFAULT_MAX_STEPS;
    if (state.modelRequests >= stepLimit) {
      await this.publishBudgetWarning(
        state,
        "steps",
        state.modelRequests,
        stepLimit,
        true,
      );
      throw new RuntimeBudgetExceededError(
        "steps",
        state.modelRequests,
        stepLimit,
      );
    }
    const nextStep = state.modelRequests + 1;
    if (
      stepLimit > 0 &&
      nextStep >= Math.max(1, Math.ceil(stepLimit * BUDGET_WARNING_THRESHOLD))
    ) {
      await this.publishBudgetWarning(state, "steps", nextStep, stepLimit);
    }

    const tokenLimit = state.input.budget?.maxModelTokens;
    if (tokenLimit !== undefined && state.usage.totalTokens >= tokenLimit) {
      await this.publishBudgetWarning(
        state,
        "tokens",
        state.usage.totalTokens,
        tokenLimit,
        true,
      );
      throw new RuntimeBudgetExceededError(
        "tokens",
        state.usage.totalTokens,
        tokenLimit,
      );
    }
  }

  private async requestModelRound(state: RuntimeRunState): Promise<{
    requestId: string;
    outputMessageId: string;
    response: CompletionResponse;
  }> {
    await this.checkModelRequestBudgets(state);

    const requestId = this.newId(state, "req");
    const outputMessageId = this.newId(state, "msg");
    const toolDefinitions = this.pureToolDefinitions(state);
    let requestContext!: ReturnType<typeof buildModelContext>;
    let requestEvent!: AgentEvent;

    await this.serialize(state, async () => {
      this.assertMayProduce(state);
      state.steeringOpen = false;
      const steeringCount = state.pendingSteering.length;
      for (const steering of state.pendingSteering.slice(0, steeringCount)) {
        state.messageState = appendMessage(state.messageState, {
          role: "user",
          content: steering.content,
        });
      }
      requestContext = buildModelContext(state.messageState, toolDefinitions);
      requestEvent = createEvent("model.request", {
        requestId,
        model: state.input.model,
        messageCount: requestContext.messages.length,
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        step: state.modelRequests + 1,
        contextVersion: requestContext.version,
        messageRevision: requestContext.messageRevision,
      }, this.eventOptions(state));
      await this.appendRaw(state, requestEvent);
      state.pendingSteering.splice(0, steeringCount);
    });
    const requestAck = this.createAcknowledgement(state);
    this.enqueue(state, { event: requestEvent, acknowledge: requestAck.acknowledge });
    await requestAck.promise;
    this.assertMayProduce(state);
    state.modelRequests++;

    const requestController = new AbortController();
    const relayRunAbort = () => {
      requestController.abort(state.controller.signal.reason);
    };
    state.controller.signal.addEventListener("abort", relayRunAbort, { once: true });
    if (state.controller.signal.aborted) relayRunAbort();
    const timeoutMs = state.input.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      requestController.abort(new ModelTimeoutError(timeoutMs));
    }, timeoutMs);

    const tokenLimit = state.input.budget?.maxModelTokens;
    const remainingBudget = tokenLimit === undefined
      ? undefined
      : tokenLimit - state.usage.totalTokens;
    const maxTokens = state.input.maxTokens === undefined
      ? remainingBudget
      : remainingBudget === undefined
        ? state.input.maxTokens
        : Math.min(state.input.maxTokens, remainingBudget);
    const request: ModelRequest = {
      messages: [...requestContext.messages],
      tools: requestContext.tools.length > 0
        ? [...requestContext.tools]
        : undefined,
      model: state.input.model,
      system: state.input.system,
      maxTokens,
      providerOptions: state.input.providerOptions === undefined
        ? undefined
        : cloneUnknown(
            state.input.providerOptions,
            "providerOptions",
          ) as Record<string, unknown>,
      signal: requestController.signal,
      contextVersion: requestContext.version,
      messageRevision: requestContext.messageRevision,
    };

    let modelIterator: AsyncIterator<ModelEvent> | undefined;
    let streamedText = "";
    const streamedToolCalls: ToolCall[] = [];
    const streamedToolCallIds = new Set<string>();
    let streamedArgumentBytes = 0;
    let toolPhase = false;
    let sequence = 0;
    let completed: CompletionResponse | undefined;
    try {
      this.assertMayProduce(state);
      const stream: unknown = state.input.modelAdapter.stream(request);
      observeAndRejectThenable(stream, "modelAdapter.stream");
      if (
        !stream ||
        (typeof stream !== "object" && typeof stream !== "function")
      ) {
        throw new ModelStreamError("modelAdapter.stream must return an AsyncIterable");
      }
      const iteratorFactory = (stream as AsyncIterable<ModelEvent>)[Symbol.asyncIterator];
      if (typeof iteratorFactory !== "function") {
        throw new ModelStreamError("modelAdapter.stream must return an AsyncIterable");
      }
      const iterator: unknown = iteratorFactory.call(stream);
      observeAndRejectThenable(iterator, "model stream async iterator factory");
      const modelNextMethod = iterator &&
        (typeof iterator === "object" || typeof iterator === "function")
        ? (iterator as AsyncIterator<ModelEvent>).next
        : undefined;
      if (
        !iterator ||
        (typeof iterator !== "object" && typeof iterator !== "function") ||
        typeof modelNextMethod !== "function"
      ) {
        throw new ModelStreamError("model stream must return an AsyncIterator");
      }
      modelIterator = iterator as AsyncIterator<ModelEvent>;
      const modelNext = modelNextMethod.bind(modelIterator);
      while (true) {
        this.assertMayProduce(state);
        const next = await this.nextModelEvent(
          state,
          modelNext,
          requestController.signal,
        );
        if (next.done) break;
        const modelEvent = snapshotModelEvent(next.value);
        switch (modelEvent.type) {
          case "text.delta": {
            if (
              toolPhase ||
              typeof modelEvent.delta !== "string" ||
              modelEvent.delta.length === 0 ||
              modelEvent.delta.length > MAX_MODEL_TEXT_DELTA_CHARS
            ) {
              throw new ModelStreamError(
                "text.delta must be nonempty, bounded, and precede tool intentions",
              );
            }
            streamedText += modelEvent.delta;
            if (streamedText.length > MAX_RESPONSE_CHARS) {
              throw new ModelStreamError("streamed model text exceeds the runtime limit");
            }
            await this.publish(state, createEvent("message.delta", {
              runId: state.input.runId,
              sessionId: state.input.sessionId,
              turnId: state.input.turnId,
              requestId,
              messageId: outputMessageId,
              role: "assistant",
              sequence,
              delta: modelEvent.delta,
            }, this.eventOptions(state)));
            sequence++;
            break;
          }
          case "tool.call": {
            toolPhase = true;
            const normalized = normalizeStreamedToolCall(
              modelEvent.call,
              streamedToolCallIds,
            );
            streamedArgumentBytes += normalized.argumentBytes;
            if (streamedArgumentBytes > MAX_TOOL_TRANSCRIPT_BYTES) {
              throw new ModelStreamError("streamed tool arguments exceeded the transcript limit");
            }
            streamedToolCalls.push(normalized.call);
            if (streamedToolCalls.length > MAX_TOOL_CALLS_PER_RESPONSE) {
              throw new ModelStreamError("model emitted too many tool intentions");
            }
            break;
          }
          case "response.completed":
            completed = normalizeCompletion(
              modelEvent.response,
              streamedText,
              streamedToolCalls,
            );
            break;
          default:
            throw new ModelStreamError("model stream emitted an unknown event type");
        }
        if (completed) break;
      }
    } catch (error) {
      const abortReason = requestController.signal.reason;
      if (abortReason instanceof ModelTimeoutError) throw abortReason;
      if (
        state.cancelRequested ||
        state.controller.signal.aborted ||
        error instanceof CancellationRequested
      ) {
        throw new CancellationRequested();
      }
      if (error instanceof AgentRuntimeError) throw error;
      throw new ModelStreamError("model stream failed", { cause: error });
    } finally {
      try {
        await this.closeModelIterator(state, modelIterator, () => {
          if (!requestController.signal.aborted) {
            requestController.abort(new ModelStreamError("model request stream closed"));
          }
        });
      } finally {
        clearTimeout(timeout);
        state.controller.signal.removeEventListener("abort", relayRunAbort);
      }
    }

    if (!completed) {
      throw new ModelStreamError("model stream ended without response.completed");
    }

    let transcriptBytes = 0;
    const roundCallIds = new Set<string>();
    for (const call of completed.toolCalls) {
      if (state.seenModelCallIds.has(call.id) || roundCallIds.has(call.id)) {
        throw new ModelStreamError("model reused a tool intention id");
      }
      roundCallIds.add(call.id);
      transcriptBytes += Buffer.byteLength(normalizeToolJson(call.arguments).wire, "utf8");
    }
    if (state.toolTranscriptBytes + transcriptBytes > MAX_TOOL_TRANSCRIPT_BYTES) {
      throw new ModelStreamError("tool transcript exceeded the runtime limit");
    }
    for (const callId of roundCallIds) state.seenModelCallIds.add(callId);
    state.toolTranscriptBytes += transcriptBytes;

    const accumulatedUsage = addUsage(state.usage, completed.usage);
    if (
      !Number.isSafeInteger(accumulatedUsage.promptTokens) ||
      !Number.isSafeInteger(accumulatedUsage.completionTokens) ||
      !Number.isSafeInteger(accumulatedUsage.totalTokens) ||
      accumulatedUsage.totalTokens !==
        accumulatedUsage.promptTokens + accumulatedUsage.completionTokens
    ) {
      throw new ModelStreamError("model usage overflowed safe budget accounting");
    }
    state.usage = accumulatedUsage;

    await this.publish(state, createEvent("model.response", {
      requestId,
      model: state.input.model,
      finishReason: completed.finishReason,
      usage: completed.usage,
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
    }, this.eventOptions(state)));

    state.messageState = appendMessage(state.messageState, {
      role: "assistant",
      content: completed.content,
      toolCalls: completed.toolCalls.length > 0 ? completed.toolCalls : undefined,
    });
    await this.publish(state, createEvent("message.completed", {
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      requestId,
      messageId: outputMessageId,
      role: "assistant",
      content: completed.content,
      finishReason: completed.finishReason,
      stateVersion: state.messageState.version,
      messageRevision: state.messageState.revision,
    }, this.eventOptions(state)), false, completed.finishReason === "tool_calls"
      ? undefined
      : () => {
          state.status = "completing";
        });

    return { requestId, outputMessageId, response: completed };
  }

  private async publishToolObservation(
    state: RuntimeRunState,
    runtimeCallId: string,
    call: ToolCall,
    result: {
      ok: boolean;
      output?: unknown;
      outputWire?: string;
      error?: ToolError;
    },
    allowCanceled = false,
  ): Promise<void> {
    await this.publish(state, createEvent("tool.result", {
      callId: runtimeCallId,
      tool: call.name,
      ok: result.ok,
      output: result.output,
      error: result.error,
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
    }, this.eventOptions(state)), allowCanceled);

    const observation = toolObservation(
      result.ok,
      result.outputWire,
      result.error,
    );
    state.messageState = appendMessage(state.messageState, {
      role: "tool",
      content: observation,
      name: call.name,
      toolCallId: call.id,
    });
    await this.publish(state, createEvent("message.completed", {
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      messageId: this.newId(state, "msg"),
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: observation,
      stateVersion: state.messageState.version,
      messageRevision: state.messageState.revision,
    }, this.eventOptions(state)), allowCanceled);
  }

  private policyEventData(
    state: RuntimeRunState,
    callId: string,
    intent: ToolPermissionIntent,
    decision: PermissionDecision,
  ) {
    const decisionData = {
      action: intent.action,
      subject: intent.subject,
      effect: decision.effect,
      reason: decision.reason,
      ruleId: decision.ruleId,
    } as const;
    return {
      taskId: state.input.taskId,
      sessionId: state.input.sessionId,
      runId: state.input.runId,
      turnId: state.input.turnId,
      callId,
      ...decisionData,
    };
  }

  private async processToolCall(
    state: RuntimeRunState,
    requestId: string,
    call: ToolCall,
  ): Promise<void> {
    const callLimit = state.input.budget?.maxToolCalls;
    const nextCall = state.toolCalls + 1;
    const runtimeCallId = this.newId(state, "call");
    state.toolCalls = nextCall;
    await this.publish(state, createEvent("tool.call", {
      callId: runtimeCallId,
      tool: call.name,
      input: call.arguments,
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      requestId,
      modelCallId: call.id,
    }, this.eventOptions(state)));

    if (callLimit !== undefined && nextCall > callLimit) {
      await this.publishBudgetWarning(
        state,
        "tool_calls",
        nextCall,
        callLimit,
        true,
      );
      throw new RuntimeBudgetExceededError(
        "tool_calls",
        nextCall,
        callLimit,
      );
    }
    if (
      callLimit !== undefined &&
      callLimit > 0 &&
      nextCall >= Math.max(1, Math.ceil(callLimit * BUDGET_WARNING_THRESHOLD))
    ) {
      await this.publishBudgetWarning(state, "tool_calls", nextCall, callLimit);
    }

    const tool = state.input.tools?.get(call.name);
    if (!tool) {
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: {
          code: "TOOL_NOT_FOUND",
          message: `unknown tool: ${call.name}`,
        },
      });
      return;
    }

    let parsed: ReturnType<typeof tool.parameters.safeParse>;
    try {
      const parsedValue: unknown = tool.parameters.safeParse(call.arguments);
      observeAndRejectThenable(parsedValue, "tool parameter validation");
      parsed = parsedValue as ReturnType<typeof tool.parameters.safeParse>;
    } catch {
      parsed = { success: false } as ReturnType<typeof tool.parameters.safeParse>;
    }
    if (!parsed.success) {
      const issue = "error" in parsed ? parsed.error.issues[0] : undefined;
      const detail = issue
        ? `${issue.message}${issue.path.length > 0 ? ` (${issue.path.join(".")})` : ""}`
        : "schema validation failed";
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: {
          code: "TOOL_BAD_INPUT",
          message: `invalid input for ${call.name}: ${detail}`.slice(0, 4096),
        },
      });
      return;
    }

    let validatedInput: unknown;
    try {
      validatedInput = normalizeImmutableToolJson(parsed.data).value;
    } catch {
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: {
          code: "TOOL_BAD_INPUT",
          message: `validated input for ${call.name} is not bounded JSON`,
        },
      });
      return;
    }

    const defaultIntent: ToolPermissionIntent = {
      action: "tool.call",
      subject: call.name,
      scope: "once",
    };
    let intent = defaultIntent;
    let decision: PermissionDecision | undefined;
    let denialCode = "TOOL_POLICY_DENIED";
    try {
      const authorization: unknown =
        tool.authorization?.(validatedInput) ?? defaultIntent;
      observeAndRejectThenable(authorization, "tool authorization");
      intent = normalizePermissionIntent(authorization);
    } catch {
      decision = {
        effect: "deny",
        reason: "tool authorization failed closed",
        ruleId: "runtime.authorization.invalid",
      };
      denialCode = "TOOL_AUTHORIZATION_FAILED";
      intent = defaultIntent;
    }

    if (decision === undefined) {
      if (getToolExecutionBoundary(tool)?.kind !== "pure") {
        decision = {
          effect: "deny",
          reason: "M7 permits only reviewed pure tools",
          ruleId: "runtime.m7.pure_only",
        };
        denialCode = "TOOL_NOT_PURE";
      } else if (!state.input.permission) {
        decision = {
          effect: "allow",
          reason: "reviewed pure tool",
          ruleId: "runtime.m7.pure",
        };
      } else {
        try {
          const policyDecision: unknown = state.input.permission.decide(intent);
          observeAndRejectThenable(policyDecision, "policy decision");
          decision = normalizePermissionDecision(policyDecision);
        } catch {
          decision = {
            effect: "deny",
            reason: "policy decision failed closed",
            ruleId: "runtime.policy.invalid",
          };
          denialCode = "TOOL_AUTHORIZATION_FAILED";
        }
      }
    }

    if (decision === undefined) {
      throw new ModelStreamError("runtime failed to derive a policy decision");
    }

    await this.publish(state, createEvent(
      "policy.decision",
      this.policyEventData(state, runtimeCallId, intent, decision),
      this.eventOptions(state),
    ));

    const scope = intent.scope ?? "once";
    const grantKey = permissionGrantKey(intent);
    const hasRunGrant = scope === "run" && state.runPermissionGrants.has(grantKey);
    if (decision.effect === "deny") {
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: { code: denialCode, message: decision.reason },
      });
      return;
    }

    if (decision.effect === "ask" && !hasRunGrant) {
      const request: PermissionRequest = Object.freeze({
        permissionId: this.newId(state, "perm"),
        sessionId: state.input.sessionId,
        callId: runtimeCallId,
        action: intent.action,
        subject: intent.subject,
        scope,
        reason: decision.reason,
      });
      await this.publish(state, createEvent("permission.requested", {
        ...request,
        runId: state.input.runId,
        turnId: state.input.turnId,
      }, this.eventOptions(state)));

      let resolution: PermissionResolution;
      let resolutionActor = "kernel";
      let canceledWhileWaiting = false;
      try {
        const hasResolver = state.input.permission?.resolve !== undefined;
        const operation = hasResolver
          ? Promise.resolve(
              state.input.permission!.resolve!(request, state.controller.signal),
            )
          : Promise.resolve<PermissionResolution>({
              decision: "deny",
              note: "no permission resolver",
            });
        resolution = normalizePermissionResolution(
          await this.waitForBoundary(state, operation),
        );
        if (hasResolver) resolutionActor = "operator";
      } catch (error) {
        if (
          error instanceof CancellationRequested ||
          state.cancelRequested ||
          state.controller.signal.aborted
        ) {
          canceledWhileWaiting = true;
          resolution = {
            decision: "deny",
            note: "run canceled while awaiting permission",
          };
        } else {
          resolution = {
            decision: "deny",
            note: "permission resolver failed closed",
          };
        }
      }

      try {
        await this.publish(state, createEvent("permission.resolved", {
          permissionId: request.permissionId,
          sessionId: request.sessionId,
          runId: state.input.runId,
          turnId: state.input.turnId,
          callId: request.callId,
          action: request.action,
          subject: request.subject,
          scope: request.scope,
          decision: resolution.decision,
          note: resolution.note,
        }, { ...this.eventOptions(state), actor: resolutionActor }), canceledWhileWaiting);
      } catch (error) {
        if (
          !state.appendFailure &&
          (error instanceof CancellationRequested ||
            state.cancelRequested ||
            state.controller.signal.aborted)
        ) {
          await this.publishToolObservation(state, runtimeCallId, call, {
            ok: false,
            error: { code: "TOOL_CANCELED", message: "tool canceled" },
          }, true);
          throw new CancellationRequested();
        }
        throw error;
      }

      if (canceledWhileWaiting) {
        await this.publishToolObservation(state, runtimeCallId, call, {
          ok: false,
          error: { code: "TOOL_CANCELED", message: "tool canceled" },
        }, true);
        throw new CancellationRequested();
      }
      if (resolution.decision !== "allow") {
        await this.publishToolObservation(state, runtimeCallId, call, {
          ok: false,
          error: {
            code: "TOOL_PERMISSION_DENIED",
            message: resolution.note ?? "operator denied permission",
          },
        });
        return;
      }
      if (scope === "run") state.runPermissionGrants.add(grantKey);
    }

    this.assertMayProduce(state);
    let rawOutput: unknown;
    try {
      let execution: Promise<unknown>;
      try {
        execution = Promise.resolve(tool.execute(validatedInput, {
          signal: state.controller.signal,
          workspace: state.input.workspace,
          sessionId: state.input.sessionId,
          taskId: state.input.taskId,
          callId: runtimeCallId,
        }));
      } catch (error) {
        execution = Promise.reject(error);
      }
      rawOutput = await this.waitForBoundary(state, execution);
    } catch (error) {
      if (
        error instanceof CancellationRequested ||
        state.cancelRequested ||
        state.controller.signal.aborted
      ) {
        await this.publishToolObservation(state, runtimeCallId, call, {
          ok: false,
          error: { code: "TOOL_CANCELED", message: "tool canceled" },
        }, true);
        throw new CancellationRequested();
      }
      const message = error instanceof Error && error.message.length > 0
        ? error.message.slice(0, 4000)
        : "tool execution failed";
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: `tool ${call.name} failed: ${message}`.slice(0, 4096),
        },
      });
      return;
    }

    let normalized: ReturnType<typeof normalizeToolJson>;
    try {
      normalized = normalizeImmutableToolJson(rawOutput);
      const outputBytes = Buffer.byteLength(normalized.wire, "utf8");
      if (state.toolTranscriptBytes + outputBytes > MAX_TOOL_TRANSCRIPT_BYTES) {
        throw new InvalidToolResultError();
      }
      state.toolTranscriptBytes += outputBytes;
    } catch {
      await this.publishToolObservation(state, runtimeCallId, call, {
        ok: false,
        error: {
          code: "TOOL_INVALID_RESULT",
          message: "tool result is not bounded JSON",
        },
      });
      return;
    }

    await this.publishToolObservation(state, runtimeCallId, call, {
      ok: true,
      output: normalized.value,
      outputWire: normalized.wire,
    });
  }

  private async runRounds(state: RuntimeRunState): Promise<string> {
    while (true) {
      const round = await this.requestModelRound(state);
      const tokenLimit = state.input.budget?.maxModelTokens;
      if (tokenLimit !== undefined) {
        const hardStop =
          state.usage.totalTokens > tokenLimit ||
          (round.response.toolCalls.length > 0 &&
            state.usage.totalTokens >= tokenLimit);
        if (hardStop) {
          await this.publishBudgetWarning(
            state,
            "tokens",
            state.usage.totalTokens,
            tokenLimit,
            true,
          );
          throw new RuntimeBudgetExceededError(
            "tokens",
            state.usage.totalTokens,
            tokenLimit,
          );
        }
        if (
          tokenLimit > 0 &&
          state.usage.totalTokens >= tokenLimit * BUDGET_WARNING_THRESHOLD
        ) {
          await this.publishBudgetWarning(
            state,
            "tokens",
            state.usage.totalTokens,
            tokenLimit,
          );
        }
      }

      if (round.response.finishReason === "length") {
        throw new ModelStreamError("model output ended at the provider length limit");
      }
      if (round.response.finishReason === "error") {
        throw new ModelStreamError("model returned an error finish reason");
      }
      if (round.response.finishReason === "stop") {
        return round.outputMessageId;
      }
      for (const call of round.response.toolCalls) {
        await this.processToolCall(state, round.requestId, call);
      }
    }
  }

  private async produce(state: RuntimeRunState): Promise<void> {
    try {
      state.agentId = this.newId(state, "agent");
      const agentStarted = createEvent("agent.started", {
        agentId: state.agentId,
        sessionId: state.input.sessionId,
        taskId: state.input.taskId,
        model: state.input.model,
        runId: state.input.runId,
        turnId: state.input.turnId,
      }, this.eventOptions(state));
      const agentStartedAck = this.createAcknowledgement(state);
      await this.serialize(state, () => this.appendRaw(state, agentStarted));
      this.enqueue(state, {
        event: agentStarted,
        acknowledge: agentStartedAck.acknowledge,
      });

      const inputMessageId = this.newId(state, "msg");
      const started = createEvent("turn.started", {
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        inputMessageId,
      }, this.eventOptions(state));
      const startedAck = this.createAcknowledgement(state);
      await this.serialize(state, () => this.appendRaw(state, started));
      this.enqueue(state, { event: started, acknowledge: startedAck.acknowledge });

      state.messageState = appendMessage(state.messageState, {
        role: "user",
        content: state.input.input,
      });
      const userMessage = createEvent("message.completed", {
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        messageId: inputMessageId,
        role: "user",
        content: state.input.input,
        stateVersion: state.messageState.version,
        messageRevision: state.messageState.revision,
      }, this.eventOptions(state));
      const userAck = this.createAcknowledgement(state);
      await this.serialize(state, () => this.appendRaw(state, userMessage));
      this.enqueue(state, { event: userMessage, acknowledge: userAck.acknowledge });
      state.status = "active";
      state.admitted.resolve(undefined);

      if (state.cancelRequested || state.abandoned) {
        agentStartedAck.acknowledge();
        startedAck.acknowledge();
        userAck.acknowledge();
      }
      await userAck.promise;
      this.assertMayProduce(state);

      const outputMessageId = await this.runRounds(state);

      // Completion wins synchronously after the final backpressure boundary.
      this.assertMayProduce(state);
      await this.finalizeTerminal(state, "completed", outputMessageId);
    } catch (error) {
      if (state.appendFailure) {
        state.status = "failed";
        state.failure = state.appendFailure;
        state.admitted.reject(state.appendFailure);
      } else if (
        state.cancelRequested ||
        error instanceof CancellationRequested ||
        state.controller.signal.aborted
      ) {
        await this.finalizeTerminal(state, "canceled", undefined, "run canceled");
      } else if (error instanceof RuntimeBudgetExceededError) {
        state.failure = error;
        await this.finalizeTerminal(
          state,
          "budget_exceeded",
          undefined,
          `${error.metric} budget exhausted (${error.used}/${error.limit})`,
        );
      } else {
        const failure = error instanceof AgentRuntimeError
          ? error
          : new ModelStreamError("model stream failed", { cause: error });
        state.failure = failure;
        await this.finalizeTerminal(state, "failed", undefined, failure.message);
      }
    } finally {
      state.removeExternalAbort?.();
      if (!state.admitted.settled()) {
        state.admitted.reject(
          state.failure ?? new RunTerminalError(state.input.runId, state.status),
        );
      }
      state.producerFinished = true;
      const terminalStatus: TerminalTurnStatus =
        state.status === "completed" ||
        state.status === "canceled" ||
        state.status === "budget_exceeded"
          ? state.status
          : "failed";
      this.runs.set(state.input.runId, {
        kind: "terminal",
        runId: state.input.runId,
        status: terminalStatus,
      });
      state.finished.resolve(undefined);
      this.releaseAcknowledgements(state);
      this.wake(state);
    }
  }
}

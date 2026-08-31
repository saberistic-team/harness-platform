import { createEvent, type AnyHarnessEvent } from "@harness/events";
import {
  type ChatMessage,
  type CompletionResponse,
  type JsonValue,
  type ModelAdapter as ModelAdapterPort,
  type ModelEvent,
  type ModelRequest,
  type ToolDefinition,
} from "@harness/models";

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
      `run ${runId} has crossed its final M6 steering boundary`,
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
  | "canceled";

type TerminalTurnStatus = "completed" | "failed" | "canceled";

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
  status: RunStatus;
  cancelRequested: boolean;
  abandoned: boolean;
  iteratorClaimed: boolean;
  producerFinished: boolean;
  modelRequests: number;
  toolCalls: number;
  steeringOpen: boolean;
  appendTail: Promise<void>;
  appendFailure?: EventAppendError;
  failure?: AgentRuntimeError;
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
    context,
    system: input.system,
    maxTokens: input.maxTokens,
    providerOptions,
    signal: input.signal,
    now: input.now,
    newId: input.newId,
  };
}

function assertCompletion(response: CompletionResponse, streamedText: string): void {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.id !== "string" ||
    response.id.length === 0 ||
    typeof response.content !== "string" ||
    response.content.length > MAX_RESPONSE_CHARS ||
    !Array.isArray(response.toolCalls) ||
    response.toolCalls.length !== 0 ||
    response.finishReason !== "stop" ||
    !response.usage ||
    !Number.isSafeInteger(response.usage.promptTokens) ||
    response.usage.promptTokens < 0 ||
    !Number.isSafeInteger(response.usage.completionTokens) ||
    response.usage.completionTokens < 0 ||
    !Number.isSafeInteger(response.usage.totalTokens) ||
    response.usage.totalTokens < 0 ||
    response.usage.totalTokens !==
      response.usage.promptTokens + response.usage.completionTokens
  ) {
    throw new ModelStreamError("model stream returned an invalid M6 text completion");
  }
  if (streamedText.length > 0 && streamedText !== response.content) {
    throw new ModelStreamError("model text deltas do not match completed content");
  }
}

/**
 * Additive M6 runtime. It intentionally supports one text-only model request;
 * the policy-gated multi-round tool loop remains the M7 implementation task.
 */
export class MinimalAgentRuntime implements AgentRuntime {
  private readonly runs = new Map<string, RuntimeRunState | RunTombstone>();

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const snapshot = snapshotRunInput(input);
    if (this.runs.has(snapshot.runId)) throw new RunAlreadyExistsError(snapshot.runId);

    const state: RuntimeRunState = {
      kind: "live",
      input: snapshot,
      controller: new AbortController(),
      admitted: deferred<void>(),
      finished: deferred<void>(),
      deliveries: [],
      acknowledgements: new Set(),
      pendingSteering: [],
      status: "registered",
      cancelRequested: false,
      abandoned: false,
      iteratorClaimed: false,
      producerFinished: false,
      modelRequests: 0,
      toolCalls: 0,
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
      snapshot.signal.addEventListener("abort", onAbort, { once: true });
      state.removeExternalAbort = () => snapshot.signal?.removeEventListener("abort", onAbort);
      if (snapshot.signal.aborted) onAbort();
    }

    void this.produce(state);
    return this.iterableFor(state);
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
    if (state.status === "completed" || state.status === "failed" || state.status === "completing") {
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
  ): Promise<void> {
    await this.serialize(state, () => this.appendRaw(state, event));
    const ack = this.createAcknowledgement(state);
    this.enqueue(state, { event, acknowledge: ack.acknowledge });
    if (state.abandoned) ack.acknowledge();
    await ack.promise;
    this.assertMayProduce(state);
  }

  private async publishTerminal(
    state: RuntimeRunState,
    status: TerminalTurnStatus,
    outputMessageId?: string,
  ): Promise<void> {
    state.status = "completing";
    const event = createEvent("turn.completed", {
      runId: state.input.runId,
      sessionId: state.input.sessionId,
      turnId: state.input.turnId,
      status,
      outputMessageId,
      modelRequests: state.modelRequests,
      toolCalls: state.toolCalls,
    }, this.eventOptions(state));
    await this.serialize(state, () => this.appendRaw(state, event));
    state.status = status;
    this.enqueue(state, { event });
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
    iterator: AsyncIterator<ModelEvent>,
  ): Promise<IteratorResult<ModelEvent>> {
    const pending = Promise.resolve().then(() => iterator.next());
    void pending.catch(() => undefined);
    const signal = state.controller.signal;
    if (signal.aborted) {
      throw signal.reason instanceof AgentRuntimeError
        ? signal.reason
        : new CancellationRequested();
    }

    let rejectInterrupted!: (reason: AgentRuntimeError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    const onAbort = () => {
      rejectInterrupted(
        signal.reason instanceof AgentRuntimeError
          ? signal.reason
          : new CancellationRequested(),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([pending, interrupted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private closeModelIterator(iterator: AsyncIterator<ModelEvent> | undefined): void {
    if (!iterator?.return) return;
    try {
      const closing = iterator.return();
      void Promise.resolve(closing).catch(() => undefined);
    } catch {
      // Cancellation/failure cleanup must not replace the primary outcome.
    }
  }

  private async produce(state: RuntimeRunState): Promise<void> {
    let modelIterator: AsyncIterator<ModelEvent> | undefined;
    try {
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

      const userMessage = createEvent("message.completed", {
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        messageId: inputMessageId,
        role: "user",
        content: state.input.input,
      }, this.eventOptions(state));
      const userAck = this.createAcknowledgement(state);
      await this.serialize(state, () => this.appendRaw(state, userMessage));
      this.enqueue(state, { event: userMessage, acknowledge: userAck.acknowledge });
      state.status = "active";
      state.admitted.resolve(undefined);

      if (state.cancelRequested || state.abandoned) {
        startedAck.acknowledge();
        userAck.acknowledge();
      }
      await userAck.promise;
      this.assertMayProduce(state);

      const context = cloneContext(state.input.context);
      context.push({ role: "user", content: state.input.input });
      const requestId = this.newId(state, "req");
      let requestMessages!: ChatMessage[];
      let requestEvent!: AgentEvent;

      await this.serialize(state, async () => {
        this.assertMayProduce(state);
        state.steeringOpen = false;
        const steeringCount = state.pendingSteering.length;
        const steering = state.pendingSteering.slice(0, steeringCount);
        requestMessages = [
          ...context,
          ...steering.map(({ content }) => ({ role: "user" as const, content })),
        ];
        requestEvent = createEvent("model.request", {
          requestId,
          model: state.input.model,
          messageCount: requestMessages.length,
        }, this.eventOptions(state));
        await this.appendRaw(state, requestEvent);
        state.pendingSteering.splice(0, steeringCount);
      });
      const requestAck = this.createAcknowledgement(state);
      this.enqueue(state, { event: requestEvent, acknowledge: requestAck.acknowledge });
      await requestAck.promise;
      this.assertMayProduce(state);
      state.modelRequests++;

      const request: ModelRequest = {
        messages: requestMessages,
        model: state.input.model,
        system: state.input.system,
        maxTokens: state.input.maxTokens,
        providerOptions: state.input.providerOptions,
        signal: state.controller.signal,
      };
      const stream = state.input.modelAdapter.stream(request);
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw new ModelStreamError("modelAdapter.stream must return an AsyncIterable");
      }
      modelIterator = stream[Symbol.asyncIterator]();

      const outputMessageId = this.newId(state, "msg");
      let streamedText = "";
      let sequence = 0;
      let completed: CompletionResponse | undefined;

      while (true) {
        this.assertMayProduce(state);
        const next = await this.nextModelEvent(state, modelIterator);
        if (next.done) break;
        const modelEvent = next.value as ModelEvent;
        if (!modelEvent || typeof modelEvent !== "object") {
          throw new ModelStreamError("model stream emitted a non-object event");
        }
        if (completed) {
          throw new ModelStreamError("model stream emitted an event after response.completed");
        }
        if (modelEvent.type === "text.delta") {
          if (typeof modelEvent.delta !== "string" || modelEvent.delta.length === 0) {
            throw new ModelStreamError("text.delta must contain nonempty text");
          }
          streamedText += modelEvent.delta;
          if (streamedText.length > MAX_RESPONSE_CHARS) {
            throw new ModelStreamError("streamed model text exceeds the runtime limit");
          }
          const delta = createEvent("message.delta", {
            runId: state.input.runId,
            sessionId: state.input.sessionId,
            turnId: state.input.turnId,
            requestId,
            messageId: outputMessageId,
            role: "assistant",
            sequence,
            delta: modelEvent.delta,
          }, this.eventOptions(state));
          sequence++;
          await this.publish(state, delta);
        } else if (modelEvent.type === "response.completed") {
          completed = modelEvent.response;
          break;
        } else {
          throw new ModelStreamError("model stream emitted an unknown event type");
        }
      }

      if (!completed) throw new ModelStreamError("model stream ended without response.completed");
      assertCompletion(completed, streamedText);

      const responseEvent = createEvent("model.response", {
        requestId,
        model: state.input.model,
        finishReason: completed.finishReason,
        usage: completed.usage,
      }, this.eventOptions(state));
      await this.publish(state, responseEvent);

      const assistantMessage = createEvent("message.completed", {
        runId: state.input.runId,
        sessionId: state.input.sessionId,
        turnId: state.input.turnId,
        requestId,
        messageId: outputMessageId,
        role: "assistant",
        content: completed.content,
        finishReason: completed.finishReason,
      }, this.eventOptions(state));
      await this.publish(state, assistantMessage);

      // Completion wins synchronously after the final backpressure boundary.
      this.assertMayProduce(state);
      await this.publishTerminal(state, "completed", outputMessageId);
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
        try {
          await this.publishTerminal(state, "canceled");
        } catch (terminalError) {
          state.status = "failed";
          state.failure = terminalError instanceof AgentRuntimeError
            ? terminalError
            : new EventAppendError("turn.completed", terminalError);
        }
      } else {
        const failure = error instanceof AgentRuntimeError
          ? error
          : new ModelStreamError("model stream failed", { cause: error });
        state.failure = failure;
        try {
          await this.publishTerminal(state, "failed");
        } catch (terminalError) {
          state.status = "failed";
          state.failure = terminalError instanceof AgentRuntimeError
            ? terminalError
            : failure;
        }
      }
    } finally {
      this.closeModelIterator(modelIterator);
      state.removeExternalAbort?.();
      if (!state.admitted.settled()) {
        state.admitted.reject(
          state.failure ?? new RunTerminalError(state.input.runId, state.status),
        );
      }
      state.producerFinished = true;
      const terminalStatus: TerminalTurnStatus =
        state.status === "completed" || state.status === "canceled"
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

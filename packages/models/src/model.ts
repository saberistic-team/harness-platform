/**
 * Model protocol — one interface, many implementations.
 *
 * Every harness (kernel, tests, evaluations, the fake model used for
 * dogfooding) speaks this interface, so real providers can be swapped in
 * without touching the agent loop.
 */

export interface SystemChatMessage {
  role: "system";
  content: string;
}

export interface UserChatMessage {
  role: "user";
  content: string;
}

export interface AssistantChatMessage {
  role: "assistant";
  content: string;
  /** Tool calls made by this assistant turn, retained in conversation history. */
  toolCalls?: readonly ToolCall[];
}

export interface ToolChatMessage {
  role: "tool";
  content: string;
  /** The tool this result belongs to. */
  name: string;
  /** Id of the model's tool call. */
  toolCallId: string;
}

export type ChatMessage =
  | SystemChatMessage
  | UserChatMessage
  | AssistantChatMessage
  | ToolChatMessage;

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** JSON value accepted by provider-neutral tool schemas and options. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Provider-neutral function tool definition.
 *
 * Runtime tool implementations remain in `@harness/tools`; models receive
 * only the JSON Schema needed to advertise a tool to a provider.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "error";

/** Provider-neutral input for the original completion-based model API. */
export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  model?: string;
  maxTokens?: number;
  system?: string;
  /** Free-form passthrough for provider-specific knobs. */
  providerOptions?: Record<string, unknown>;
  /** Optional caller cancellation, independent of provider timeouts. */
  signal?: AbortSignal;
}

/**
 * Versioned streaming request used by the minimal runtime.
 *
 * The fields are optional while M6 callers migrate; M7 runtime requests always
 * provide them together. `contextVersion` identifies the context contract,
 * while `messageRevision` identifies the immutable message snapshot used for
 * this request. Legacy `Model.complete()` callers keep their original shape.
 */
export interface ModelRequest extends CompletionRequest {
  contextVersion?: 1;
  messageRevision?: number;
}

export interface CompletionResponse {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

/**
 * Maximum JavaScript string length of one model text delta.
 *
 * This matches the canonical `message.delta` event payload boundary. Model
 * adapters should omit empty provider chunks and split larger chunks before
 * yielding them.
 */
export const MAX_MODEL_TEXT_DELTA_CHARS = 1024 * 1024;

/**
 * An incremental assistant-text fragment, in provider delivery order.
 * `delta` must be nonempty and no longer than MAX_MODEL_TEXT_DELTA_CHARS.
 */
export interface ModelTextDeltaEvent {
  type: "text.delta";
  delta: string;
}

/** A complete model-requested tool intention, in provider delivery order. */
export interface ModelToolCallEvent {
  type: "tool.call";
  call: ToolCall;
}

/**
 * The terminal event of every successful model stream.
 *
 * Tool calls remain in the completed provider-neutral response for legacy
 * completion parity. Streaming adapters also emit them as ordered tool.call
 * events; runtimes validate both representations agree and execute them once.
 */
export interface ModelResponseCompletedEvent {
  type: "response.completed";
  response: CompletionResponse;
}

/** Strict model-stream vocabulary supported by the minimal kernel. */
export type ModelEvent =
  | ModelTextDeltaEvent
  | ModelToolCallEvent
  | ModelResponseCompletedEvent;

/** Async streaming model boundary owned by the minimal kernel. */
export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

/**
 * Normalize provider text chunks to the ModelTextDeltaEvent contract without
 * changing their concatenated content.
 */
export function normalizeModelTextDeltas(
  deltas: readonly string[],
): string[] {
  const normalized: string[] = [];
  for (const delta of deltas) {
    for (
      let offset = 0;
      offset < delta.length;
      offset += MAX_MODEL_TEXT_DELTA_CHARS
    ) {
      normalized.push(delta.slice(offset, offset + MAX_MODEL_TEXT_DELTA_CHARS));
    }
  }
  return normalized;
}

export interface Model {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * Deterministic token estimator used when a provider does not report
 * usage (and by the fake model). Not a billing-grade count — it is a
 * stable, documented approximation so budgets work offline.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

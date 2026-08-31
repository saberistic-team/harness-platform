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
  toolCalls?: ToolCall[];
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

export interface CompletionResponse {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
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

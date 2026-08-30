/**
 * Model protocol — one interface, many implementations.
 *
 * Every harness (kernel, tests, evaluations, the fake model used for
 * dogfooding) speaks this interface, so real providers can be swapped in
 * without touching the agent loop.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on `tool` messages: the tool this result belongs to. */
  name?: string;
  /** Present on `tool` messages: id of the model's tool call. */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "error";

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  system?: string;
  /** Free-form passthrough for provider-specific knobs. */
  providerOptions?: Record<string, unknown>;
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

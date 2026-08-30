import {
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type Model,
  type ToolCall,
  type Usage,
  estimateTokens,
  emptyUsage,
  addUsage,
} from "./model";

/**
 * A single scripted turn of a FakeModel:
 *  - `content`  — assistant text for the turn
 *  - `toolCalls`— tool calls issued in this turn
 *  - `usage`    — explicit token accounting; if omitted it is a
 *                 deterministic estimate derived from the request and
 *                 the scripted output (see estimateTokens)
 *  - `finishReason` — defaults to "tool_calls" when toolCalls are
 *                 present, otherwise "stop"
 */
export interface ScriptedTurn {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  finishReason?: FinishReason;
}

/**
 * Deterministic in-memory model for tests, evaluations, and offline
 * dogfooding of the harness itself.
 *
 *  - Replays a queue of ScriptedTurns in order.
 *  - When the queue is empty it returns a fixed ack so loops terminate.
 *  - Records every request it receives (for assertions).
 *  - Fully offline: no network, no clock, no randomness.
 */
export class FakeModel implements Model {
  readonly name = "fake-model/v1";
  /** Every request handed to this model, in order. */
  readonly requests: CompletionRequest[] = [];
  private readonly queue: ScriptedTurn[];

  constructor(initial: readonly ScriptedTurn[] = []) {
    this.queue = [...initial];
  }

  /** Queue further turns to be replayed in order. */
  queue(...turns: ScriptedTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  get pendingTurns(): number {
    return this.queue.length;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request);
    const seq = this.requests.length;
    const turn = this.queue.shift() ?? { content: `[fake-model] ack #${seq}` };

    const prompt =
      (request.system ? request.system + "\n" : "") +
      request.messages.map((m) => m.content).join("\n");
    const scriptedCompletion = [
      turn.content ?? "",
      ...(turn.toolCalls ?? []).map((tc) => JSON.stringify(tc.arguments ?? {})),
    ].join("\n");
    const usage =
      turn.usage ??
      addUsage(
        { ...emptyUsage(), promptTokens: estimateTokens(prompt) },
        { ...emptyUsage(), completionTokens: estimateTokens(scriptedCompletion) },
      );

    return {
      id: `fake-${seq}`,
      content: turn.content ?? "",
      toolCalls: turn.toolCalls ?? [],
      usage,
      finishReason:
        turn.finishReason ??
        (turn.toolCalls && turn.toolCalls.length > 0 ? "tool_calls" : "stop"),
    };
  }
}

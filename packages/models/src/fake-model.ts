import {
  type CompletionRequest,
  type CompletionResponse,
  type FinishReason,
  type Model,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
  type Usage,
  estimateTokens,
  normalizeModelTextDeltas,
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
  /**
   * Optional deterministic streaming chunks. When present they must
   * concatenate exactly to `content`; if content is omitted, their joined
   * value becomes the completed response content.
   */
  textDeltas?: readonly string[];
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
export class FakeModel implements Model, ModelAdapter {
  readonly name = "fake-model/v1";
  /** Every request handed to this model, in order. */
  readonly requests: CompletionRequest[] = [];
  private readonly queue: ScriptedTurn[];

  constructor(initial: readonly ScriptedTurn[] = []) {
    this.queue = [...initial];
  }

  /** Queue further turns to be replayed in order. */
  enqueue(...turns: ScriptedTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  get pendingTurns(): number {
    return this.queue.length;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return this.takeTurn(request).response;
  }

  /**
   * Stream a scripted turn in deterministic chunk order and terminate with
   * the same provider-neutral response returned by complete().
   */
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const { response, textDeltas } = this.takeTurn(request);
    for (const delta of textDeltas) {
      request.signal?.throwIfAborted();
      yield { type: "text.delta", delta };
    }
    request.signal?.throwIfAborted();
    yield { type: "response.completed", response };
  }

  private takeTurn(
    request: ModelRequest,
  ): { response: CompletionResponse; textDeltas: readonly string[] } {
    request.signal?.throwIfAborted();
    this.requests.push(request);
    const seq = this.requests.length;
    const turn = this.queue.shift() ?? { content: `[fake-model] ack #${seq}` };
    const scriptedDeltaContent = turn.textDeltas?.join("");
    const content = turn.content ?? scriptedDeltaContent ?? "";
    if (scriptedDeltaContent !== undefined && scriptedDeltaContent !== content) {
      throw new Error("scripted text deltas must concatenate to response content");
    }
    const textDeltas = normalizeModelTextDeltas(
      turn.textDeltas ?? (content.length > 0 ? [content] : []),
    );
    let usage: Usage;

    const prompt =
      (request.system ? request.system + "\n" : "") +
      request.messages.map((m) => m.content).join("\n");
    const scriptedCompletion = [
      content,
      ...(turn.toolCalls ?? []).map((tc) => JSON.stringify(tc.arguments ?? {})),
    ].join("\n");
    if (turn.usage) {
      const u = turn.usage;
      usage = {
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens || u.promptTokens + u.completionTokens,
      };
    } else {
      const P = estimateTokens(prompt);
      const C = estimateTokens(scriptedCompletion);
      usage = { promptTokens: P, completionTokens: C, totalTokens: P + C };
    }

    return {
      textDeltas,
      response: {
        id: `fake-${seq}`,
        content,
        toolCalls: turn.toolCalls ?? [],
        usage,
        finishReason:
          turn.finishReason ??
          (turn.toolCalls && turn.toolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    };
  }
}

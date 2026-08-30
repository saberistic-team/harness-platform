import {
  createEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import {
  type ChatMessage,
  type Model,
  type Usage,
} from "@harness/models";
import { ToolRegistry } from "@harness/tools";
import { randomUUID } from "node:crypto";

/**
 * The kernel is the language-level agent loop. It deliberately knows
 * nothing about network, storage, or hosting:
 *
 *   goal + model + tools + budget  ──>  event stream + final text
 *
 * Everything observable is emitted as a typed harness event, so the
 * same loop can run locally, in the sandbox, or in the eval harness
 * with zero code changes.
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
  constructor(
    readonly tool: string,
    cause?: unknown,
  ) {
    super(
      `tool "${tool}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ToolExecutionError";
  }
}

export interface RunOptions {
  goal: string;
  model: Model;
  tools?: ToolRegistry;
  budget?: Budget;
  /** Hard cap on model turns. Defaults to 8. */
  maxSteps?: number;
  /** Task id stamped onto events (maps to the task manifest). */
  taskId?: string;
  /** Session id stamped onto events. */
  sessionId?: string;
  /** Observe events as they are produced. */
  onEvent?: (event: AnyHarnessEvent) => void;
  /** Injectable clock/id for deterministic tests. */
  now?: () => string;
  newId?: (prefix: string) => string;
}

export interface RunResult {
  text: string;
  usage: Usage;
  steps: number;
  toolCalls: number;
  events: AnyHarnessEvent[];
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const at = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? ((p: string) => `${p}-${randomUUID()}`);

  const events: AnyHarnessEvent[] = [];
  const emit = (event: AnyHarnessEvent) => {
    events.push(event);
    opts.onEvent?.(event);
  };

  const budget = opts.budget ?? {};
  const maxSteps = opts.maxSteps ?? 8;
  const sessionId = opts.sessionId ?? newId("sess");
  const agentId = newId("agent");
  const model = opts.model;
  const tools = opts.tools ?? new ToolRegistry();
  const taskId = opts.taskId;

  let spentTokens = 0;
  let toolCalls = 0;
  let steps = 0;
  let warnedTokens = false;
  let warnedCalls = false;
  let finalText = "";

  const messages: ChatMessage[] = [{ role: "user", content: opts.goal }];

  const budgetWarning = (
    metric: "tokens" | "tool_calls",
    used: number,
    limit: number,
  ) =>
    emit(
      createEvent(
        "budget.warning",
        {
          taskId,
          metric,
          used,
          limit,
          pct: limit > 0 ? Math.round((used / limit) * 100) : 100,
        },
        { at: at(), eventId: newId("evt"), actor: "kernel" },
      ),
    );

  const stop = (
    status: "completed" | "failed" | "canceled" | "budget_exceeded",
    note?: string,
  ) =>
    emit(
      createEvent(
        "agent.stopped",
        { agentId, status, steps, toolCalls, note },
        { at: at(), eventId: newId("evt"), actor: "kernel" },
      ),
    );

  emit(
    createEvent(
      "session.created",
      { sessionId },
      { at: at(), eventId: newId("evt"), actor: "kernel" },
    ),
  );
  emit(
    createEvent(
      "agent.started",
      { agentId, sessionId, taskId, model: model.name },
      { at: at(), eventId: newId("evt"), actor: "kernel" },
    ),
  );

  while (steps < maxSteps) {
    steps++;
    const requestId = newId("req");

    emit(
      createEvent(
        "model.request",
        { requestId, model: model.name, messageCount: messages.length },
        { at: at(), eventId: newId("evt"), actor: "kernel" },
      ),
    );

    const response = await model.complete({ messages });
    spentTokens += response.usage.totalTokens;

    emit(
      createEvent(
        "model.response",
        {
          requestId,
          model: model.name,
          finishReason: response.finishReason,
          usage: response.usage,
        },
        { at: at(), eventId: newId("evt"), actor: "kernel" },
      ),
    );

    // Budget: tokens. Warn once past 50%, hard-stop when exceeded.
    const tokenLimit = budget.maxModelTokens;
    if (tokenLimit !== undefined) {
      if (spentTokens > tokenLimit) {
        budgetWarning("tokens", spentTokens, tokenLimit);
        stop("budget_exceeded", `max_model_tokens=${tokenLimit}`);
        throw new BudgetExceededError("tokens", spentTokens, tokenLimit);
      }
      if (!warnedTokens && spentTokens >= tokenLimit * BUDGET_WARNING_THRESHOLD) {
        warnedTokens = true;
        budgetWarning("tokens", spentTokens, tokenLimit);
      }
    }

    if (response.toolCalls.length === 0) {
      finalText = response.content;
      stop("completed");
      break;
    }

    // Tool calls.
    for (const call of response.toolCalls) {
      const callLimit = budget.maxToolCalls;
      if (callLimit !== undefined) {
        if (toolCalls >= callLimit) {
          budgetWarning("tool_calls", toolCalls, callLimit);
          stop("budget_exceeded", `max_tool_calls=${callLimit}`);
          throw new BudgetExceededError("tool_calls", toolCalls, callLimit);
        }
        if (!warnedCalls && toolCalls >= callLimit - 1) {
          warnedCalls = true;
          budgetWarning("tool_calls", toolCalls, callLimit);
        }
      }

      const callId = newId("call");
      const t0 = Date.now();
      emit(
        createEvent(
          "tool.call",
          { callId, tool: call.name, input: call.arguments },
          { at: at(), eventId: newId("evt"), actor: "kernel" },
        ),
      );

      const tool = tools.get(call.name);
      let ok = false;
      let output: unknown;
      let error: { code: string; message: string } | undefined;

      if (tool === undefined) {
        error = { code: "TOOL_NOT_FOUND", message: `unknown tool: ${call.name}` };
      } else {
        try {
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
            output = await tool.execute(params.data);
            ok = true;
          }
        } catch (err) {
          error = {
            code: "TOOL_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      toolCalls++;
      const durationMs = Date.now() - t0;

      emit(
        createEvent(
          "tool.result",
          { callId, tool: call.name, ok, output, error, durationMs },
          { at: at(), eventId: newId("evt"), actor: "kernel" },
        ),
      );

      // Feed the result back as a `tool` message.
      messages.push({
        role: "assistant",
        content: "",
      });
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: ok
          ? JSON.stringify(output ?? null)
          : JSON.stringify({ error: { code: error?.code, message: error?.message } }),
      });
    }
  }

  // Step budget exhausted: the model never produced a final answer.
  stop("failed", `max_steps=${maxSteps} reached without a final answer`);

  return {
    text: finalText,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: spentTokens },
    steps,
    toolCalls,
    events,
  };
}

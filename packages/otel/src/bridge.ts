import {
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { Counter } from "@opentelemetry/api";
import type { AnyHarnessEvent } from "@harness/events";

/**
 * The event bridge: harness events -> OpenTelemetry spans + metrics.
 *
 * The bridge is the ONLY place that knows both dialects, and it is
 * stateless with respect to the harness: feed it a stream of
 * `@harness/events` events in order and it produces:
 *
 *   session.created    -> span `harness.session` (the run root)
 *   agent.started      -> attributes on the run span
 *   model.request      -> span `harness.model.request` (per requestId)
 *   model.response     -> closes it + counters (turns, tokens)
 *   tool.call          -> span `harness.tool.call` (per callId)
 *   tool.result        -> closes it + counter (tool, ok)
 *   budget.warning     -> counter + run-span event (audit trail)
 *   policy.decision    -> run-span event
 *   agent.stopped      -> closes the run span (status, steps, toolCalls)
 *   error              -> recordException on the run span
 *
 * Kernel-side and CLI-side emit the same events, so the SAME bridge
 * wires "kernel -> CLI -> collector" with no per-caller code.
 */
export interface BridgeCounters {
  modelTurns: Counter;
  modelTokens: Counter;
  toolCalls: Counter;
  budgetWarnings: Counter;
}

export class EventBridge {
  private readonly sessions = new Map<string, Span>();
  private readonly modelSpans = new Map<string, Span>();
  private readonly toolSpans = new Map<string, Span>();
  private activeSession: Span | undefined;
  private readonly counters?: BridgeCounters;

  constructor(
    private readonly tracer: Tracer,
    meter?: Meter,
  ) {
    if (meter) {
      this.counters = {
        modelTurns: meter.createCounter("harness.model.turns"),
        modelTokens: meter.createCounter("harness.model.tokens", {
          description: "total tokens per model response",
        }),
        toolCalls: meter.createCounter("harness.tool.calls"),
        budgetWarnings: meter.createCounter("harness.budget.warnings"),
      };
    }
  }

  /** Start a span; when a session is active it becomes its child, so
   *  the whole run (kernel or CLI) lands in ONE trace. */
  private startChild(name: string, attributes: Attributes): Span {
    if (this.activeSession) {
      return context.with(
        trace.setSpan(context.active(), this.activeSession),
        () => this.tracer.startSpan(name, { attributes }),
      );
    }
    return this.tracer.startSpan(name, { attributes });
  }

  /** Route one harness event into spans/metrics. Never throws: an
   *  observability hiccup must not kill the run it is observing. */
  onEvent(event: AnyHarnessEvent): void {
    try {
      this.route(event);
    } catch {
      // Observability is best-effort by definition; the event stream
      // itself remains the source of truth.
    }
  }

  private route(event: AnyHarnessEvent): void {
    switch (event.type) {
      case "session.created": {
        const span = this.tracer.startSpan("harness.session", {
          attributes: { "harness.session.id": event.data.sessionId },
        });
        this.sessions.set(event.data.sessionId, span);
        this.activeSession = span;
        return;
      }
      case "agent.started": {
        this.activeSession?.setAttribute("harness.agent.id", event.data.agentId);
        if (event.data.taskId) {
          this.activeSession?.setAttribute("harness.task.id", event.data.taskId);
        }
        this.activeSession?.setAttribute("harness.model", event.data.model);
        return;
      }
      case "model.request": {
        const span = this.startChild("harness.model.request", {
          "harness.model": event.data.model,
          "harness.messages": event.data.messageCount,
        });
        this.modelSpans.set(event.data.requestId, span);
        return;
      }
      case "model.response": {
        const span = this.modelSpans.get(event.data.requestId);
        span?.setAttribute("harness.finish_reason", event.data.finishReason);
        span?.setAttribute(
          "harness.usage.total_tokens",
          event.data.usage.totalTokens,
        );
        if (event.data.finishReason === "error") {
          span?.setStatus({ code: SpanStatusCode.ERROR });
        }
        span?.end();
        this.modelSpans.delete(event.data.requestId);
        this.counters?.modelTurns.add(1, {
          "harness.model": event.data.model,
          "harness.finish_reason": event.data.finishReason,
        });
        this.counters?.modelTokens.add(event.data.usage.totalTokens, {
          "harness.model": event.data.model,
        });
        return;
      }
      case "tool.call": {
        const span = this.startChild("harness.tool.call", {
          "harness.tool": event.data.tool,
        });
        this.toolSpans.set(event.data.callId, span);
        return;
      }
      case "tool.result": {
        const span = this.toolSpans.get(event.data.callId);
        span?.setAttribute("harness.ok", event.data.ok);
        if (event.data.durationMs !== undefined) {
          span?.setAttribute("harness.duration_ms", event.data.durationMs);
        }
        if (!event.data.ok) {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.data.error?.message ?? "tool failed",
          });
        }
        span?.end();
        this.toolSpans.delete(event.data.callId);
        this.counters?.toolCalls.add(1, {
          "harness.tool": event.data.tool,
          "harness.ok": event.data.ok,
        });
        return;
      }
      case "budget.warning": {
        this.activeSession?.addEvent("budget.warning", {
          "harness.metric": event.data.metric,
          "harness.pct": event.data.pct,
        });
        this.counters?.budgetWarnings.add(1, { "harness.metric": event.data.metric });
        return;
      }
      case "policy.decision": {
        this.activeSession?.addEvent("policy.decision", {
          "harness.action": event.data.action,
          "harness.effect": event.data.effect,
        });
        return;
      }
      case "task.updated": {
        this.activeSession?.addEvent("task.updated", {
          "harness.phase": event.data.phase,
        });
        return;
      }
      case "run.recorded": {
        this.activeSession?.addEvent("run.recorded", {
          "harness.status": event.data.status,
        });
        return;
      }
      case "agent.stopped": {
        const span = this.activeSession;
        span?.setAttribute("harness.status", event.data.status);
        span?.setAttribute("harness.steps", event.data.steps);
        span?.setAttribute("harness.tool_calls", event.data.toolCalls);
        if (event.data.status === "completed") {
          span?.setStatus({ code: SpanStatusCode.OK });
        } else {
          span?.setStatus({
            code: SpanStatusCode.ERROR,
            message: event.data.note ?? `stopped: ${event.data.status}`,
          });
        }
        span?.end();
        this.activeSession = undefined;
        return;
      }
      case "error": {
        this.activeSession?.recordException({
          name: event.data.code,
          message: event.data.message,
        });
        this.activeSession?.addEvent("error", {
          "harness.code": event.data.code,
          "harness.retryable": event.data.retryable ?? false,
        });
        return;
      }
    }
  }
}

export type { AnyHarnessEvent };

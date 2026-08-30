import { z } from "zod";

/**
 * Event envelope versioning rules (see EVENTS.md):
 *  - `v` is the ENVELOPE version, not the payload version.
 *  - A platform must declare which envelope versions it can decode
 *    (SUPPORTED_EVENT_VERSIONS). Unknown versions are a typed error,
 *    never a silent best-effort parse.
 *  - Payload schemas are keyed by `type`; adding a field is an additive
 *    (optional) field on the existing type. Removing or re-typing a
 *    field requires a new event type.
 */
export const CURRENT_EVENT_VERSION = 1;
export const SUPPORTED_EVENT_VERSIONS: readonly number[] = [1];

const id = z.string().min(1);
const iso = z.string().min(1, "'at' must be an ISO-8601 timestamp");
const usage = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

function envelope(type: string, data: z.ZodTypeAny) {
  return z.object({
    v: z.literal(CURRENT_EVENT_VERSION, {
      message: `expected envelope version ${CURRENT_EVENT_VERSION}`,
    }),
    type: z.literal(type),
    eventId: id,
    at: iso,
    actor: id.optional(),
    data,
  });
}

export const sessionCreated = envelope(
  "session.created",
  z.object({ sessionId: id, workspace: id.optional() }),
);

export const agentStarted = envelope(
  "agent.started",
  z.object({
    agentId: id,
    sessionId: id,
    taskId: id.optional(),
    model: id,
  }),
);

export const agentStopped = envelope(
  "agent.stopped",
  z.object({
    agentId: id,
    status: z.enum(["completed", "failed", "canceled", "budget_exceeded"]),
    steps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    note: z.string().optional(),
  }),
);

export const modelRequest = envelope(
  "model.request",
  z.object({
    requestId: id,
    model: id,
    messageCount: z.number().int().positive(),
  }),
);

export const modelResponse = envelope(
  "model.response",
  z.object({
    requestId: id,
    model: id,
    finishReason: z.enum(["stop", "tool_calls", "length", "error"]),
    usage,
  }),
);

export const toolCall = envelope(
  "tool.call",
  z.object({
    callId: id,
    tool: id,
    input: z.unknown(),
  }),
);

export const toolResult = envelope(
  "tool.result",
  z.object({
    callId: id,
    tool: id,
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z
      .object({ code: id, message: z.string() })
      .optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
);

export const taskUpdated = envelope(
  "task.updated",
  z.object({
    taskId: id,
    phase: z.enum([
      "planned",
      "running",
      "verifying",
      "delivered",
      "blocked",
    ]),
    note: z.string().optional(),
  }),
);

export const budgetWarning = envelope(
  "budget.warning",
  z.object({
    taskId: id.optional(),
    metric: z.enum(["tokens", "tool_calls"]),
    used: z.number().nonnegative(),
    limit: z.number().nonnegative(),
    pct: z.number().min(0),
  }),
);

export const policyDecision = envelope(
  "policy.decision",
  z.object({
    action: id,
    subject: z.string().optional(),
    effect: z.enum(["allow", "ask", "deny"]),
    reason: z.string().optional(),
    ruleId: id.optional(),
  }),
);

export const runRecorded = envelope(
  "run.recorded",
  z.object({
    runId: id,
    taskId: id,
    status: z.enum(["passed", "failed", "blocked"]),
    reportPath: id,
  }),
);

export const errorEvent = envelope(
  "error",
  z.object({
    code: id,
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
);

/**
 * All event schemas, keyed by wire `type`. The key `type` is the
 * discriminator — a stable logical namespace, not a version number.
 */
export const eventSchemas = {
  "session.created": sessionCreated,
  "agent.started": agentStarted,
  "agent.stopped": agentStopped,
  "model.request": modelRequest,
  "model.response": modelResponse,
  "tool.call": toolCall,
  "tool.result": toolResult,
  "task.updated": taskUpdated,
  "budget.warning": budgetWarning,
  "policy.decision": policyDecision,
  "run.recorded": runRecorded,
  "error": errorEvent,
} as const;

export type EventType = keyof typeof eventSchemas;

export type TypedEvent<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;

/** Payload type for a given event type. */
export type EventData<T extends EventType> = TypedEvent<T>["data"];

export type AnyHarnessEvent = {
  [K in EventType]: TypedEvent<K>
}[EventType];

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(eventSchemas, value);
}

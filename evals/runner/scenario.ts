import { z } from "zod";
import { isEventType } from "@harness/events";

/**
 * Scenario DSL (M1 subset — validated and extended by @harness/sdk in
 * M2). A scenario is an eval test case: it names the task(s) it
 * exercises and the observable invariants a correct golden run must
 * produce.
 *
 * Design rule (evals/scenarios/README.md): scenarios assert on EVENTS
 * and the RUN SUMMARY only — never kernel internals — so they stay
 * stable across kernel refactors.
 */

export const runStatusSchema = z.enum([
  "completed",
  "failed",
  "canceled",
  "budget_exceeded",
]);

const scalar = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * A single event invariant. `type` is required; any `data.<path>`
 * key asserts a nested value on the event payload, e.g.
 * `data.status: completed` — exactly the shape in
 * evals/scenarios/README.md.
 */
const rawEventInvariant = z
  .object({ type: z.string().min(1) })
  .passthrough();

const eventInvariant = rawEventInvariant.superRefine((inv, ctx) => {
  if (!isEventType(inv.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: `unknown event type "${inv.type}" (rule 4: typed error, no silent fallback)`,
    });
  }
  for (const [key, value] of Object.entries(inv)) {
    if (key === "type") continue;
    if (!key.startsWith("data.")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `event invariant key must be "type" or "data.<path>" (got "${key}")`,
      });
      continue;
    }
    if (value !== null && !scalar.safeParse(value).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "data.<path> values must be scalars",
      });
    }
  }
});

export const eventInvariantSchema = eventInvariant;

export interface EventInvariant {
  type: string;
  /** dotted path -> expected scalar value. */
  data: Record<string, unknown>;
}

/** Normalize a raw invariant into {type, data} form. */
export function toEventInvariant(raw: Record<string, unknown>): EventInvariant {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "type") continue;
    if (key.startsWith("data.")) data[key.slice("data.".length)] = value;
  }
  return { type: String(raw.type), data };
}

export const runExpectSchema = z
  .object({
    /** Final status from the last `agent.stopped` event. */
    status: runStatusSchema.optional(),
    /** Exact model-turn count. */
    steps: z.number().int().nonnegative().optional(),
    /** Exact tool-call count. */
    toolCalls: z.number().int().nonnegative().optional(),
    /** The final assistant text must contain this substring. */
    textContains: z.string().min(1).optional(),
    /** True if any `budget.warning` was observed. */
    emittedBudgetWarning: z.boolean().optional(),
  })
  .strict();

export const scenarioExpectSchema = z
  .object({
    run: runExpectSchema.optional(),
    /** Ordered list of invariants the stream must contain (subsequence). */
    events: z.array(eventInvariantSchema).min(1).optional(),
    /**
     * Exit-gate invariants, checked against the run report when one is
     * supplied to the runner (harness run -> evals --report <file>).
     */
    report: z
      .object({
        status: z.enum(["passed", "failed", "blocked"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (e) =>
      e.run !== undefined ||
      (e.events?.length ?? 0) > 0 ||
      e.report !== undefined,
    { message: "expect must declare at least one invariant (run, events or report)" },
  );

export const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "scenario id must be kebab-case"),
    /** Kebab ids of task manifests this scenario exercises. */
    uses_tasks: z.array(z.string().min(1)).min(1),
    /**
     * The FakeModel script: one entry per model turn. Drives the
     * golden run deterministically and offline.
     */
    script: z
      .array(
        z
          .object({
            content: z.string().optional(),
            finishReason: z
              .enum(["stop", "tool_calls", "length", "error"])
              .optional(),
            toolCalls: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    name: z.string().min(1),
                    arguments: z.unknown(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .default([]),
    expect: scenarioExpectSchema,
  })
  .strict();

export type RunStatus = z.infer<typeof runStatusSchema>;
export type ScenarioExpect = z.infer<typeof scenarioExpectSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;

export class ScenarioParseError extends Error {
  constructor(
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      `invalid scenario: ${issues
        .map((i) => `${i.path || "<root>"} ${i.message}`)
        .join("; ")}`,
    );
    this.name = "ScenarioParseError";
  }
}

export function decodeScenario(doc: unknown): Scenario {
  const res = scenarioSchema.safeParse(doc);
  if (!res.success) {
    throw new ScenarioParseError(
      res.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return res.data;
}

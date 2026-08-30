import { z } from "zod";

/**
 * The RUN REPORT is the structured, machine-readable outcome of a
 * harness run (the "exit gate" artifact). One per (task, attempt).
 */

export const RUN_REPORT_SCHEMA = "run-report/v1";

const identifier = z.string().min(1);

export const runReportTestsSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  /** Parsed from the test runner when available. */
  total: z.number().int().nonnegative().optional(),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  outputTail: z.string().default(""),
});

export const runReportSchema = z.object({
  schema: z.literal(RUN_REPORT_SCHEMA),
  task: z.object({
    id: identifier,
    title: z.string().min(1),
    path: identifier,
  }),
  status: z.enum(["passed", "failed", "blocked"]),
  startedAt: identifier,
  finishedAt: identifier,
  branch: identifier,
  policy: z.object({
    changedPathsOk: z.boolean(),
    changedPaths: z.array(z.string()),
    violations: z.array(z.string()),
  }),
  tests: runReportTestsSchema.optional(),
  modelUsage: z
    .object({
      totalModelTokens: z.number().nonnegative(),
      totalToolCalls: z.number(),
      steps: z.number(),
    })
    .optional(),
  /** Serialized harness events (wire JSON strings) for the run itself. */
  events: z.array(z.string()),
  deliverables: z.object({
    pullRequest: z.string().optional(),
    artifacts: z.array(z.string()).default([]),
    reportPath: identifier,
  }),
});

export type RunReport = z.infer<typeof runReportSchema>;

export class RunReportError extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = "RunReportError";
  }
}

export function validateRunReport(doc: unknown): RunReport {
  const result = runReportSchema.safeParse(doc);
  if (!result.success) {
    throw new RunReportError(
      `invalid run report: ${result.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

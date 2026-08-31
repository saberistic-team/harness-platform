import { z } from "zod";
import { deserializeEvent } from "@harness/events";

/**
 * The RUN REPORT is the structured, machine-readable outcome of a
 * harness run (the "exit gate" artifact). One per (task, attempt).
 */

/** Historical display/import format; it is not a current exit-gate attestation. */
export const RUN_REPORT_SCHEMA = "run-report/v1";
/** Current exit-gate format with mandatory attempt and commit evidence. */
export const CURRENT_RUN_REPORT_SCHEMA = "run-report/v2";
export const RUN_PREFLIGHT_REPORT_SCHEMA = "run-preflight-report/v1";

const identifier = z.string().min(1);

function sameUniqueStrings(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  if (leftSet.size !== rightSet.size) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

export const runFailureStageSchema = z.enum([
  "manifest",
  "git",
  "policy",
  "builder",
  "tests",
  "evidence",
  "report",
]);

export type RunFailureStage = z.infer<typeof runFailureStageSchema>;

export const runReportIssueSchema = z
  .object({
    path: z.string(),
    message: z.string().min(1),
  })
  .strict();

export type RunReportIssue = z.infer<typeof runReportIssueSchema>;

export const runReportFailureSchema = z
  .object({
    stage: runFailureStageSchema,
    code: identifier,
    message: z.string().min(1),
    issues: z.array(runReportIssueSchema).optional(),
  })
  .strict();

export type RunReportFailure = z.infer<typeof runReportFailureSchema>;

export const runReportBuilderSchema = z
  .object({
    /** Stable identity of the TaskAgent adapter (for example, upstream Pi). */
    name: identifier,
    ok: z.boolean(),
    durationMs: z.number().nonnegative(),
    exitCode: z.number().int().optional(),
    outputTail: z.string().default(""),
  })
  .strict();

export const runReportGitChangeSchema = z
  .object({
    origin: z.enum(["committed", "staged", "unstaged", "untracked"]),
    status: identifier,
    path: identifier,
    oldPath: identifier.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    const pairStatus = change.status.startsWith("R") || change.status.startsWith("C");
    if (pairStatus !== (change.oldPath !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oldPath"],
        message: "must be present exactly for rename/copy status records",
      });
    }
  });

export const runReportGitSnapshotSchema = z
  .object({
    changes: z.array(runReportGitChangeSchema),
    policyPaths: z.array(identifier),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expectedPaths = snapshot.changes.flatMap((change) => [
      change.path,
      ...(change.status.startsWith("R") && change.oldPath ? [change.oldPath] : []),
    ]);
    if (!sameUniqueStrings(snapshot.policyPaths, [...new Set(expectedPaths)])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policyPaths"],
        message: "must equal the write-relevant paths represented by changes",
      });
    }
  });

/** Immutable Git attestation plus the deltas evaluated by the path gate. */
export const runReportGitSchema = z
  .object({
    repositoryRoot: identifier,
    mode: z.enum(["local", "ci"]),
    expectedBranch: identifier,
    actualBranch: identifier.optional(),
    detached: z.boolean(),
    headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    baseRef: identifier,
    baseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    mergeBaseSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    preTest: runReportGitSnapshotSchema,
    postTest: runReportGitSnapshotSchema.optional(),
  })
  .strict();

export type RunReportBuilder = z.infer<typeof runReportBuilderSchema>;
export type RunReportGitChange = z.infer<typeof runReportGitChangeSchema>;
export type RunReportGitSnapshot = z.infer<typeof runReportGitSnapshotSchema>;
export type RunReportGit = z.infer<typeof runReportGitSchema>;

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
}).strict();

export const runReportSchema = z.object({
  schema: z.union([
    z.literal(RUN_REPORT_SCHEMA),
    z.literal(CURRENT_RUN_REPORT_SCHEMA),
  ]),
  /** Stable identity for this attempt; mandatory for current v2 reports. */
  runId: identifier.optional(),
  task: z.object({
    id: identifier,
    title: z.string().min(1),
    path: identifier,
  }).strict(),
  status: z.enum(["passed", "failed", "blocked"]),
  startedAt: identifier,
  finishedAt: identifier,
  branch: identifier,
  policy: z.object({
    changedPathsOk: z.boolean(),
    changedPaths: z.array(z.string()),
    violations: z.array(z.string()),
  }).strict(),
  tests: runReportTestsSchema.optional(),
  builder: runReportBuilderSchema.optional(),
  git: runReportGitSchema.optional(),
  failure: runReportFailureSchema.optional(),
  /** Ordered failure trail; `failure` remains the primary compatibility field. */
  failures: z.array(runReportFailureSchema).min(1).optional(),
  modelUsage: z
    .object({
      totalModelTokens: z.number().int().nonnegative(),
      totalToolCalls: z.number().int().nonnegative(),
      steps: z.number().int().nonnegative(),
    })
    .strict()
    .optional(),
  /** Serialized harness events (wire JSON strings) for the run itself. */
  events: z.array(z.string()),
  deliverables: z.object({
    pullRequest: z.string().optional(),
    artifacts: z.array(z.string()).default([]),
    reportPath: identifier,
    /** True only after the report has been atomically committed to reportPath. */
    reportWritten: z.boolean().optional(),
    /** Id of the session whose event stream is the run's evidence. */
    sessionId: identifier.optional(),
  }).strict(),
}).strict().superRefine((report, context) => {
  // v1 remains readable for historical UI/eval data but is explicitly not a
  // current gate attestation. Only v2 receives coherence validation.
  if (report.schema === RUN_REPORT_SCHEMA) return;

  const expectedBranch = `tasks/${report.task.id}`;
  if (report.branch !== expectedBranch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["branch"],
      message: `must equal ${expectedBranch}`,
    });
  }

  const scopeOk = report.policy.violations.length === 0;
  if (report.policy.changedPathsOk !== scopeOk) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["policy", "changedPathsOk"],
      message: "must agree with whether violations is empty",
    });
  }
  for (const violation of report.policy.violations) {
    if (!report.policy.changedPaths.includes(violation)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "violations"],
        message: `violation ${JSON.stringify(violation)} is absent from changedPaths`,
      });
    }
  }

  if (report.tests && report.tests.ok !== (report.tests.exitCode === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tests", "ok"],
      message: "must agree with exitCode",
    });
  }
  if (report.builder?.ok && report.builder.exitCode !== undefined && report.builder.exitCode !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["builder", "ok"],
      message: "cannot be true when exitCode is nonzero",
    });
  }

  // v2 cannot opt out of strict checks by omitting
  // additive fields because the schema literal is the discriminator.
  if (report.runId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runId"],
      message: "a current report requires a runId",
    });
  }
  if (report.deliverables.reportWritten === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["deliverables", "reportWritten"],
      message: "a current report requires reportWritten",
    });
  }

  if (report.git && report.git.expectedBranch !== report.branch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "expectedBranch"],
      message: "must agree with the report branch",
    });
  }
  if (report.git && report.git.detached === (report.git.actualBranch !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "detached"],
      message: "must agree with actualBranch presence",
    });
  }
  if (report.git?.mode === "local" && report.git.detached) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "detached"],
      message: "local reports cannot use detached Git evidence",
    });
  }
  if (
    report.git?.mode === "local" &&
    !/^refs\/(?:heads|remotes\/origin)\/(?:main|master|trunk|develop)$/u.test(
      report.git.baseRef,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "baseRef"],
      message: "local baseRef must be a canonical allow-listed mainish ref",
    });
  }
  if (report.git?.mode === "ci" && report.git.baseRef !== report.git.baseSha) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "baseRef"],
      message: "CI baseRef must be the attested immutable baseSha",
    });
  }
  if (report.git?.actualBranch !== undefined && report.git.actualBranch !== report.branch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "actualBranch"],
      message: "must agree with the report branch",
    });
  }
  const primaryFailure = report.failure;
  if (primaryFailure && report.failures && !report.failures.some((failure) =>
    failure.stage === primaryFailure.stage &&
    failure.code === primaryFailure.code &&
    failure.message === primaryFailure.message
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failures"],
      message: "must contain the primary failure",
    });
  }
  if ((report.failure === undefined) !== (report.failures === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure"],
      message: "new reports must provide failure and failures together",
    });
  }

  if (report.git) {
    const gitPolicyPaths = [
      ...report.git.preTest.policyPaths,
      ...(report.git.postTest?.policyPaths ?? []),
    ];
    if (!sameUniqueStrings(report.policy.changedPaths, [...new Set(gitPolicyPaths)])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy", "changedPaths"],
        message: "must equal the union of Git pre/post policy paths without duplicates",
      });
    }
  }

  const decodedEvents = report.events.flatMap((wire, index) => {
    try {
      return [deserializeEvent(wire)];
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["events", index],
        message: `must be a valid harness event: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
  });
  for (const [index, event] of decodedEvents.entries()) {
    if (event.type !== "policy.decision") continue;
    const attributed = "taskId" in event.data ? event.data : undefined;
    if (
      attributed === undefined ||
      attributed.taskId !== report.task.id ||
      attributed.runId !== report.runId ||
      (
        report.deliverables.sessionId !== undefined &&
        attributed.sessionId !== report.deliverables.sessionId
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["events", index],
        message: "current policy decisions must carry matching task/session/run attribution",
      });
    }
  }
  const receipts = decodedEvents.flatMap((event) =>
    event.type === "run.recorded" ? [event.data] : []
  );
  const matchingReceipts = receipts.filter((receipt) =>
    receipt.runId === report.runId &&
    receipt.taskId === report.task.id &&
    receipt.status === report.status &&
    receipt.reportPath === report.deliverables.reportPath
  );
  if (
    report.deliverables.reportWritten &&
    (receipts.length !== 1 || matchingReceipts.length !== 1)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["events"],
      message: "a committed report must contain exactly one run.recorded receipt and it must match",
    });
  }
  if (!report.deliverables.reportWritten && receipts.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["events"],
      message: "an uncommitted report cannot contain run.recorded",
    });
  }

  if (report.status === "passed") {
    if (!report.tests?.ok) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tests"],
        message: "a passed report requires successful tests",
      });
    }
    if (!report.git?.postTest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["git", "postTest"],
        message: "a passed report requires post-test Git evidence",
      });
    }
    if (!scopeOk || report.failure || report.builder?.ok === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "passed contradicts policy, builder, or failure evidence",
      });
    }
    if (!report.deliverables.reportWritten || !report.deliverables.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliverables"],
        message: "a passed report requires committed report and session evidence",
      });
    }
  } else if (!report.failure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure"],
      message: "a failed or blocked report requires a structured failure",
    });
  }
});

export type RunReport = z.infer<typeof runReportSchema>;

const runPreflightTaskSchema = z
  .object({
    id: identifier,
    title: z.string().min(1),
  })
  .strict();

const runPreflightDeliverablesSchema = z
  .object({
    pullRequest: z.string().optional(),
    artifacts: z.array(z.string()).default([]),
    reportPath: identifier,
    reportWritten: z.boolean().optional(),
    sessionId: identifier.optional(),
  })
  .strict();

const runPreflightCommon = {
  schema: z.literal(RUN_PREFLIGHT_REPORT_SCHEMA),
  manifestPath: identifier,
  runId: identifier,
  sessionId: identifier,
  status: z.literal("failed"),
  startedAt: identifier,
  finishedAt: identifier,
  branch: identifier.optional(),
  /** Ordered complete failure trail for current producers. */
  failures: z.array(runReportFailureSchema).min(1).optional(),
  events: z.array(z.string()),
  deliverables: runPreflightDeliverablesSchema,
} as const;

const manifestPreflightReportSchema = z
  .object({
    ...runPreflightCommon,
    task: runPreflightTaskSchema.optional(),
    error: runReportFailureSchema.extend({
      stage: z.literal("manifest"),
    }),
  })
  .strict();

const gitPreflightReportSchema = z
  .object({
    ...runPreflightCommon,
    // Branch selection may fail before the authoritative branch manifest can
    // be read, so task identity is present only when it was validated.
    task: runPreflightTaskSchema.optional(),
    error: runReportFailureSchema.extend({
      stage: z.literal("git"),
    }),
  })
  .strict();

/**
 * Evidence for attempts that fail before all fields required by run-report/v2
 * can be trusted. A manifest failure may not have a task identity; a Git
 * failure usually happens after manifest validation. When an existing branch
 * must be selected before its manifest can be read, task identity is omitted.
 */
export const runPreflightReportSchema = z.union([
  manifestPreflightReportSchema,
  gitPreflightReportSchema,
]).superRefine((report, context) => {
  if (report.deliverables.reportWritten === undefined) return;
  if (!report.failures) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failures"],
      message: "a current preflight report requires the complete failure trail",
    });
    return;
  }
  if (!report.failures.some((failure) =>
    failure.stage === report.error.stage &&
    failure.code === report.error.code &&
    failure.message === report.error.message
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failures"],
      message: "must contain the primary preflight error",
    });
  }
});

export type RunPreflightReport = z.infer<typeof runPreflightReportSchema>;

export const reportArtifactSchema = z.union([
  runReportSchema,
  runPreflightReportSchema,
]);

export type ReportArtifact = z.infer<typeof reportArtifactSchema>;

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

export function validateRunPreflightReport(doc: unknown): RunPreflightReport {
  const result = runPreflightReportSchema.safeParse(doc);
  if (!result.success) {
    throw new RunReportError(
      `invalid run preflight report: ${result.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

/** Validate either a normal run report or an early preflight-failure report. */
export function validateReportArtifact(doc: unknown): ReportArtifact {
  const result = reportArtifactSchema.safeParse(doc);
  if (!result.success) {
    throw new RunReportError(
      `invalid report artifact: ${result.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

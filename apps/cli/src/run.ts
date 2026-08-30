import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createEvent, deserializeEvent, serializeEvent } from "@harness/events";
import { openSqliteSession } from "@harness/sessions";
import {
  RUN_REPORT_SCHEMA,
  validateRunReport,
  type RunReport,
} from "@harness/sdk";
import { loadTaskManifestFile, type TaskManifest } from "@harness/sdk";
import { compileRules, pathAllowed } from "@harness/policy";
import {
  createHarnessTelemetry,
  telemetryFromEnv,
  type HarnessTelemetry,
} from "@harness/otel";
import {
  changedPaths,
  currentBranch,
  ensureBranch,
  isMainish,
} from "./git";

export interface RunArgs {
  cwd: string;
  manifestPath: string;
  branch?: string;
  testCommand?: string;
  testTimeoutMs?: number;
  /** Pull-Request URL to record as the delivery link (CI provides it). */
  prUrl?: string;
}

export interface RunOutcome {
  exitCode: number;
  report: RunReport;
  reportPath: string;
}

const DEFAULT_TEST_COMMAND = "pnpm test";

function parseTestSummary(output: string): {
  total?: number;
  passed?: number;
  failed?: number;
} {
  // Jest: "Tests:       3 failed, 12 passed, 15 total"
  // Vitest: "Tests  15 passed (15)" or the lines in default reporter
  let total: number | undefined;
  let passed: number | undefined;
  let failed: number | undefined;
  const jest = output.match(
    /Tests:\s+(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/i,
  );
  if (jest) {
    failed = Number(jest[1]);
    passed = Number(jest[2]);
    total = Number(jest[3]);
  } else {
    // Prefer runner lines like vitest's "Tests  40 passed (40)" /
    // "Tests  1 failed | 39 passed (40)" over "Test Files ..." lines.
    const f = output.match(/Tests\s+(\d+)\s+failed/i);
    const p = output.match(/Tests\s+(\d+)\s+passed/i);
    if (f) failed = Number(f[1]);
    if (p) passed = Number(p[1]);
    if (passed !== undefined && failed !== undefined) total = passed + failed;
    else if (passed !== undefined) total = passed;
    else if (failed !== undefined) total = failed;
  }
  return { total, passed, failed };
}

/**
 * The exit-gate run:
 *
 *   1. load + validate the task manifest (schema gate)
 *   2. pin the work to a task branch           (git gate)
 *   3. check changed paths against allowed_paths (policy gate)
 *   4. run the test command                    (quality gate)
 *   5. emit a validated, structured run report (evidence gate)
 *
 * Any gate failing yields a non-zero exit code and a matching status
 * in the report (`blocked` for policy violations, `failed` for test
 * failures).
 */
export async function runTask(args: RunArgs): Promise<RunOutcome> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const cwd = resolve(args.cwd);
  const manifestFile = resolve(cwd, args.manifestPath);

  const manifest: TaskManifest = await loadTaskManifestFile(
    manifestFile,
  );

  // Gate 2: branch. When an explicit branch is pinned (CI: the PR's
  // head ref; the CI checkout is already that ref and the repo may be
  // detached HEAD), it is recorded as-is. Locally, mainish branches
  // isolate the work on tasks/<id>.
  let branch: string;
  if (args.branch) {
    branch = args.branch;
  } else {
    const baseBranch = currentBranch(cwd);
    branch = isMainish(baseBranch) ? `tasks/${manifest.id}` : baseBranch;
    ensureBranch(cwd, branch);
  }

  // Gate 3: policy — changed paths must stay inside allowed_paths.
  // The manifest file itself is the task's contract (input, not output)
  // and is exempt from the allow-list.
  const changed = changedPaths(cwd);
  const relManifest = manifestFile.startsWith(cwd)
    ? manifestFile.slice(cwd.length).replace(/^\//, "")
    : manifestFile;
  const violations = changed.filter(
    (p) => p !== relManifest && !pathAllowed(manifest.allowed_paths, p),
  );
  const policyCheck = { ok: violations.length === 0, violations };

  // Log the decision for the exec gate we use (the test command) — the
  // decision is part of the audit trail even though we run it directly.
  // Enforced through the rule compiler: the same compiled decision table
  // the sandbox-runner will use (see compileRules in @harness/policy).
  const execDecision = compileRules(manifest.permissions).decide(
    "process.exec",
    args.testCommand ?? DEFAULT_TEST_COMMAND,
  );

  const events: string[] = [];
  const eventOpts = () => ({
    at: new Date().toISOString(),
    actor: "harness-cli",
  });

  // M2 OpenTelemetry wiring: the CLI's own event stream (task.updated,
  // policy.decision, run.recorded, error) goes through the SAME bridge
  // as the kernel's, so "harness run" lands in the collector alongside
  // `pnpm evals` runs. Off unless HARNESS_OTEL=1 / OTEL_* are set, so
  // the default gate lane stays dependency-free.
  let telemetry: HarnessTelemetry | undefined;
  const otelOpts = telemetryFromEnv();
  if (otelOpts !== null) {
    try {
      telemetry = await createHarnessTelemetry(otelOpts);
    } catch (err) {
      console.error(
        `otel: telemetry disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const push = (e: import("@harness/events").AnyHarnessEvent) => {
    events.push(serializeEvent(e));
    telemetry?.bridge.onEvent(e);
  };

  const reportDir = join(cwd, "tasks", "runs");
  mkdirSync(reportDir, { recursive: true });
  const stampIso = new Date(started).toISOString().replace(/[:.]/g, "-");
  const reportPath = join(reportDir, `${manifest.id}-${stampIso}.json`);

  let outcome: "passed" | "failed" | "blocked";
  let tests: RunReport["tests"];

  push(createEvent("task.updated", { taskId: manifest.id, phase: "running" }, eventOpts()));

  if (!policyCheck.ok) {
    outcome = "blocked";
    push(
      createEvent(
        "policy.decision",
        {
          action: "fs.write",
          effect: "deny",
          reason: `changed paths outside allowed_paths: ${policyCheck.violations.join(", ")}`,
        },
        eventOpts(),
      ),
    );
  } else if (execDecision.effect === "deny") {
    outcome = "blocked";
    push(
      createEvent(
        "policy.decision",
        {
          action: "process.exec",
          subject: args.testCommand ?? DEFAULT_TEST_COMMAND,
          effect: "deny",
          reason: execDecision.reason,
        },
        eventOpts(),
      ),
    );
  } else {
    // Gate 4: tests. ("ask" is honored here by the interactive CLI in
    // M1; for headless exit-gate runs, a task that asks is treated as
    // allowed only for its own test command by the grader's prompt.
    const command = args.testCommand ?? DEFAULT_TEST_COMMAND;    const t0 = Date.now();
    const proc = spawnSync(command, {
      cwd,
      shell: true,
      timeout: args.testTimeoutMs ?? 300_000,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const exitCode = proc.status ?? 1;
    const ok = exitCode === 0;
    const summary = parseTestSummary(
      `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`,
    );
    const outputTail = (proc.stdout ?? "")
      .split("\n")
      .slice(-30)
      .join("\n");

    tests = {
      command,
      exitCode,
      ok,
      durationMs: Date.now() - t0,
      ...summary,
      outputTail,
    };
    outcome = ok ? "passed" : "failed";
  }

  const finishedAt = new Date().toISOString();

  push(
    createEvent(
      "run.recorded",
      {
        runId: `run-${manifest.id}`,
        taskId: manifest.id,
        status: outcome,
        reportPath,
      },
      eventOpts(),
    ),
  );

  // Evidence persistence: the run's event stream is the session log.
  // Stored in the shared per-repo SQLite store (M1 sessions work); the
  // report links the session id. A persistence failure is recorded as
  // a typed `error` event in the report rather than hiding the
  // evidence already produced by the gates above.
  const dbRelPath = "tasks/runs/sessions.sqlite";
  const dbPath = join(cwd, dbRelPath);
  let sessionId: string | undefined;
  try {
    const store = openSqliteSession(dbPath, { taskId: manifest.id });
    for (const wire of events) await store.log.append(deserializeEvent(wire));
    sessionId = store.sessionId;
    store.close();
  } catch (err) {
    push(
      createEvent(
        "error",
        {
          code: "SESS_PERSIST_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
        eventOpts(),
      ),
    );
  }

  // Delivery link: CI provides the PR URL explicitly (--pr-url) or via
  // HARNESS_PULL_REQUEST_URL. Without one, a passing run records its
  // delivery branch — never a fabricated URL.
  const prUrl = (args.prUrl ?? process.env.HARNESS_PULL_REQUEST_URL ?? "").trim();
  const effectivePrUrl = prUrl.length > 0 ? prUrl : undefined;

  const report = {
    schema: RUN_REPORT_SCHEMA,
    task: {
      id: manifest.id,
      title: manifest.title,
      path: manifestFile,
    },
    status: outcome,
    startedAt,
    finishedAt,
    branch,
    policy: {
      changedPathsOk: policyCheck.ok,
      changedPaths: changed,
      violations: policyCheck.violations,
    },
    tests,
    events,
    deliverables: {
      pullRequest: effectivePrUrl ?? (outcome === "passed" ? `branch: ${branch}` : undefined),
      artifacts: sessionId ? [dbRelPath] : [],
      reportPath,
      sessionId,
    },
  } as unknown as RunReport;

  const validated = validateRunReport(report);
  const finalReport = validated;
  writeFileSync(
    reportPath,
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );

  // Flush telemetry BEFORE reporting so the collector has the run's
  // spans when the gate finishes (order matters for the evidence).
  if (telemetry) {
    try {
      await telemetry.forceFlush();
      await telemetry.shutdown();
      console.error(
        `otel: exported the run's spans via ${telemetry.kind} sink (service=${otelOpts?.serviceName ?? "harness"})`,
      );
    } catch (err) {
      console.error(
        `otel: shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const exitCode = outcome === "passed" ? 0 : 1;
  return { exitCode, report: finalReport, reportPath };
}

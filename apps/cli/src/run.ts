import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createEvent, serializeEvent } from "@harness/events";
import {
  RUN_REPORT_SCHEMA,
  validateRunReport,
  type RunReport,
} from "@harness/sdk";
import { loadTaskManifestFile, type TaskManifest } from "@harness/sdk";
import { checkChangedPaths, decide } from "@harness/policy";
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
    const p = output.match(/(\d+)\s+passed/i);
    const f = output.match(/(\d+)\s+failed/i);
    if (p) passed = Number(p[1]);
    if (f) failed = Number(f[1]);
    if (passed !== undefined && failed !== undefined) {
      total = passed + failed;
    }
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

  // Gate 2: branch.
  const baseBranch = currentBranch(cwd);
  const branch =
    args.branch ?? (isMainish(baseBranch) ? `tasks/${manifest.id}` : baseBranch);
  ensureBranch(cwd, branch);

  // Gate 3: policy — changed paths must stay inside allowed_paths.
  const changed = changedPaths(cwd);
  const policyCheck = checkChangedPaths(
    manifest.allowed_paths,
    changed,
  );

  // Log the decision for the exec gate we use (the test command) — the
  // decision is part of the audit trail even though we run it directly.
  const execDecision = decide(
    manifest.permissions,
    "process.exec",
    args.testCommand ?? DEFAULT_TEST_COMMAND,
  );

  const events: string[] = [];
  const stamp = {
    at: () => new Date().toISOString(),
    actor: "harness-cli",
  };
  const push = (e: Parameters<typeof serializeEvent>[0]) => {
    events.push(serializeEvent(e));
  };

  const reportDir = join(cwd, "tasks", "runs");
  mkdirSync(reportDir, { recursive: true });
  const stampIso = new Date(started).toISOString().replace(/[:.]/g, "-");
  const reportPath = join(reportDir, `${manifest.id}-${stampIso}.json`);

  let outcome: "passed" | "failed" | "blocked";
  let tests: RunReport["tests"];

  push(createEvent("task.updated", { taskId: manifest.id, phase: "running" }, stamp));

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
        stamp,
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
        stamp,
      ),
    );
  } else {
    // Gate 4: tests. ("ask" is honored here by the interactive CLI in
    // M1; for headless exit-gate runs, a task that asks is treated as
    // allowed only for its own test command by the grader's prompt.
    const command = args.testCommand ?? DEFAULT_TEST_COMMAND;
    const t0 = Date.now();
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
      pullRequest: outcome === "passed" ? `branch: ${branch}` : undefined,
      artifacts: [],
      reportPath,
    },
  } as unknown as RunReport;

  const validated = validateRunReport(report);
  push(
    createEvent(
      "run.recorded",
      {
        runId: `run-${manifest.id}`,
        taskId: manifest.id,
        status: outcome,
        reportPath,
      },
      stamp,
    ),
  );
  // Re-stamp with the final event list.
  const finalReport = { ...validated, events } as RunReport;
  writeFileSync(
    reportPath,
    `${JSON.stringify(finalReport, null, 2)}\n`,
  );

  const exitCode = outcome === "passed" ? 0 : 1;
  return { exitCode, report: finalReport, reportPath };
}

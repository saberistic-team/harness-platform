import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RUN_PREFLIGHT_REPORT_SCHEMA,
  CURRENT_RUN_REPORT_SCHEMA,
  validateReportArtifact,
  type RunPreflightReport,
  type RunReport,
} from "@harness/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/main";
import { runTask, type RunOutcome } from "../src/run";

const repos: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-"));
  repos.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "harness@test.local"]);
  git(dir, ["config", "user.name", "Harness Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  const initial = Object.keys(files).length > 0
    ? files
    : { "packages/seed.md": "harness-test-repo\n" };
  for (const [path, content] of Object.entries(initial)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

afterEach(() => {
  for (const dir of repos.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function manifest(
  id: string,
  options: {
    allowed?: string[];
    commands?: string[];
    read?: "allow" | "ask" | "deny";
    write?: "allow" | "ask" | "deny";
  } = {},
): string {
  const commandRules = (options.commands ?? ["node -e **"])
    .map((pattern) => `    "${pattern}": allow`)
    .concat(['    "*": deny'])
    .join("\n");
  return [
    `id: ${id}`,
    `title: "Task ${id}"`,
    "goal: Stay inside the declared task contract",
    "acceptance:",
    "  - the gate passes",
    "allowed_paths:",
    `  - tasks/${id}.yaml`,
    ...(options.allowed ?? ["packages/**"]).map((path) => `  - ${path}`),
    "permissions:",
    ...(options.read ? [`  fs.read: ${options.read}`] : []),
    ...(options.write ? [`  fs.write: ${options.write}`] : []),
    "  process.exec:",
    commandRules,
    "  network: deny",
    "delivery:",
    "  type: none",
  ].join("\n");
}

function writeManifest(dir: string, id: string, yaml = manifest(id)): string {
  const path = `tasks/${id}.yaml`;
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, path), yaml);
  return path;
}

function normal(outcome: RunOutcome): RunReport {
  expect(outcome.report.schema).toBe(CURRENT_RUN_REPORT_SCHEMA);
  if (outcome.report.schema !== CURRENT_RUN_REPORT_SCHEMA) {
    throw new Error("expected a normal run report");
  }
  return outcome.report;
}

function preflight(outcome: RunOutcome): RunPreflightReport {
  expect(outcome.report.schema).toBe(RUN_PREFLIGHT_REPORT_SCHEMA);
  if (outcome.report.schema !== RUN_PREFLIGHT_REPORT_SCHEMA) {
    throw new Error("expected a preflight report");
  }
  return outcome.report;
}

function eventData(report: { events: string[] }, type: string) {
  return report.events
    .map((wire) => JSON.parse(wire) as {
      type: string;
      data: Record<string, unknown>;
    })
    .filter((event) => event.type === type)
    .map((event) => event.data);
}

describe("harness run (hardened exit gate)", () => {
  it("passes on the exact task branch and records complete Git and policy evidence", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "kernel-0001");
    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "console.log(\'Tests 3 passed (3)\')"',
    });
    const report = normal(outcome);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.reportWritten).toBe(true);
    expect(report.status).toBe("passed");
    expect(report.branch).toBe("tasks/kernel-0001");
    expect(git(dir, ["branch", "--show-current"])).toBe("tasks/kernel-0001");
    expect(report.git).toMatchObject({
      expectedBranch: "tasks/kernel-0001",
      actualBranch: "tasks/kernel-0001",
      detached: false,
      mode: "local",
    });
    expect(report.git?.preTest.policyPaths).toContain(manifestPath);
    expect(report.git?.postTest).toBeDefined();
    expect(report.tests).toMatchObject({ ok: true, passed: 3 });
    expect(report.deliverables.sessionId).toBeTruthy();
    expect(report.deliverables.reportWritten).toBe(true);

    const decisions = eventData(report, "policy.decision");
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "git.branch", effect: "allow" }),
      expect.objectContaining({
        action: "workspace.path_scope",
        subject: "pre-tests",
        effect: "allow",
      }),
      expect.objectContaining({ action: "process.exec", effect: "allow" }),
      expect.objectContaining({
        action: "workspace.path_scope",
        subject: "post-tests",
        effect: "allow",
      }),
    ]));
    for (const decision of decisions) {
      expect(decision).toMatchObject({
        taskId: "kernel-0001",
        sessionId: report.deliverables.sessionId,
        runId: report.runId,
      });
    }
    expect(eventData(report, "run.recorded")).toEqual([
      expect.objectContaining({
        runId: report.runId,
        taskId: "kernel-0001",
        status: "passed",
        reportPath: outcome.reportPath,
      }),
    ]);

    expect(validateReportArtifact(
      JSON.parse(readFileSync(outcome.reportPath, "utf8")),
    )).toEqual(report);
  });

  it("checks out an existing task branch before reading its branch-only manifest", async () => {
    const dir = makeRepo();
    git(dir, ["switch", "-q", "-c", "tasks/existing-run"]);
    const manifestPath = writeManifest(dir, "existing-run");
    git(dir, ["add", manifestPath]);
    git(dir, ["commit", "-q", "-m", "add branch-only task contract"]);
    git(dir, ["switch", "-q", "main"]);
    expect(existsSync(join(dir, manifestPath))).toBe(false);

    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
    });
    const report = normal(outcome);

    expect(outcome.exitCode).toBe(0);
    expect(report.status).toBe("passed");
    expect(report.tests?.ok).toBe(true);
    expect(git(dir, ["branch", "--show-current"])).toBe("tasks/existing-run");
    expect(report.git?.preTest.policyPaths).toContain(manifestPath);
  });

  it("reports branch-selection failure before a branch-only manifest is readable", async () => {
    const dir = makeRepo();
    git(dir, ["switch", "-q", "-c", "tasks/branch-only-failure"]);
    const manifestPath = writeManifest(dir, "branch-only-failure");
    git(dir, ["add", manifestPath]);
    git(dir, ["commit", "-q", "-m", "add branch-only task contract"]);
    git(dir, ["switch", "-q", "main"]);
    writeFileSync(join(dir, "pending.txt"), "do not carry across branches\n");

    const outcome = await runTask({ cwd: dir, manifestPath });
    const report = preflight(outcome);

    expect(outcome.exitCode).toBe(1);
    expect(report.error).toMatchObject({
      stage: "git",
      code: "GIT_BRANCH_SWITCH_DIRTY",
    });
    expect(report.task).toBeUndefined();
    expect(eventData(report, "policy.decision")).toContainEqual(
      expect.objectContaining({
        taskId: "branch-only-failure",
        action: "git.branch",
        effect: "deny",
      }),
    );
  });

  it("records the caller-provided pull-request URL", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "pr-evidence");
    const pullRequest = "https://github.com/example/harness/pull/42";
    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
      prUrl: pullRequest,
    }));
    expect(report.deliverables.pullRequest).toBe(pullRequest);
  });

  it("returns a structured test failure and retains the post-test snapshot", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "tests-fail");
    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(7)"',
    });
    const report = normal(outcome);
    expect(report.status).toBe("failed");
    expect(report.tests).toMatchObject({ ok: false, exitCode: 7 });
    expect(report.failure).toMatchObject({
      stage: "tests",
      code: "TEST_COMMAND_FAILED",
    });
    expect(report.git?.postTest).toBeDefined();
  });

  it("blocks committed out-of-scope changes even with a clean worktree", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "committed-scope");
    git(dir, ["switch", "-q", "-c", "tasks/committed-scope"]);
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra/rogue.txt"), "outside\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "out of scope"]);

    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
    }));
    expect(report.status).toBe("blocked");
    expect(report.policy.violations).toContain("infra/rogue.txt");
    expect(report.git?.preTest.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "committed", path: "infra/rogue.txt" }),
    ]));
    expect(report.tests).toBeUndefined();
  });

  it("checks allowed_paths again after tests mutate the tree", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "post-test-scope");
    const command = 'node -e "require(\'node:fs\').mkdirSync(\'infra\',{recursive:true});require(\'node:fs\').writeFileSync(\'infra/rogue.txt\',\'x\')"';
    const report = normal(await runTask({ cwd: dir, manifestPath, testCommand: command }));
    expect(report.status).toBe("blocked");
    expect(report.tests?.ok).toBe(true);
    expect(report.failure?.code).toBe("POST_TEST_PATH_SCOPE_VIOLATION");
    expect(report.policy.violations).toContain("infra/rogue.txt");
    expect(report.git?.postTest?.policyPaths).toContain("infra/rogue.txt");
  });

  it("retains both a test failure and the later scope failure", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "test-and-scope-fail");
    const script = [
      "const fs=require('node:fs')",
      "fs.mkdirSync('infra',{recursive:true})",
      "fs.writeFileSync('infra/rogue.txt','x')",
      "process.exit(7)",
    ].join(";");
    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: `node -e ${JSON.stringify(script)}`,
    }));

    expect(report.failure?.code).toBe("POST_TEST_PATH_SCOPE_VIOLATION");
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEST_COMMAND_FAILED", stage: "tests" }),
      expect.objectContaining({
        code: "POST_TEST_PATH_SCOPE_VIOLATION",
        stage: "policy",
      }),
    ]));
  });

  it("terminates ordinary test descendants before taking the final snapshot", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "test-descendants");
    const child = [
      "const fs=require('node:fs')",
      "setTimeout(()=>{fs.mkdirSync('infra',{recursive:true});fs.writeFileSync('infra/late.txt','late')},400)",
    ].join(";");
    const parent = [
      "const cp=require('node:child_process')",
      `cp.spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}).unref()`,
    ].join(";");

    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: `node -e ${JSON.stringify(parent)}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 650));

    expect(outcome.exitCode).toBe(0);
    expect(existsSync(join(dir, "infra/late.txt"))).toBe(false);
  });

  it("emits an attributed deny decision when the test command is not allowed", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(
      dir,
      "exec-denied",
      manifest("exec-denied", { commands: [] }),
    );
    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: "pnpm test",
    }));
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("PROCESS_EXEC_DENIED");
    expect(eventData(report, "policy.decision")).toContainEqual(
      expect.objectContaining({
        taskId: "exec-denied",
        sessionId: report.deliverables.sessionId,
        runId: report.runId,
        action: "process.exec",
        effect: "deny",
      }),
    );
  });

  it("writes a validated preflight report for an invalid manifest", async () => {
    const dir = makeRepo();
    const path = writeManifest(dir, "invalid", "id: 1\n");
    const outcome = await runTask({ cwd: dir, manifestPath: path });
    const report = preflight(outcome);
    expect(outcome.exitCode).toBe(1);
    expect(report.task).toBeUndefined();
    expect(report.error).toMatchObject({
      stage: "manifest",
      code: "MANIFEST_INVALID",
    });
    expect(report.failures).toEqual([
      expect.objectContaining({ stage: "manifest", code: "MANIFEST_INVALID" }),
    ]);
    expect(report.events).toHaveLength(1);
    expect(eventData(report, "error")[0]).toMatchObject({
      stage: "manifest",
      runId: report.runId,
      sessionId: report.sessionId,
    });
    expect(validateReportArtifact(
      JSON.parse(readFileSync(outcome.reportPath, "utf8")),
    )).toEqual(report);
  });

  it("returns an in-memory preflight artifact when report storage is unavailable", async () => {
    const dir = makeRepo();
    const path = writeManifest(dir, "invalid-unwritable", "id: 1\n");
    const previousTmpdir = process.env.TMPDIR;
    const outcome = await (async () => {
      process.env.TMPDIR = join(dir, "missing-temp-parent");
      try {
        return await runTask({
          cwd: dir,
          manifestPath: path,
          reportWriter() {
            throw new Error("report storage unavailable");
          },
        });
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      }
    })();
    const report = preflight(outcome);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportWritten).toBe(false);
    expect(report.error.code).toBe("MANIFEST_INVALID");
    expect(report.deliverables.reportWritten).toBe(false);
    expect(eventData(report, "error")).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REPORT_WRITE_FAILED", stage: "report" }),
      expect.objectContaining({ code: "REPORT_FALLBACK_WRITE_FAILED", stage: "report" }),
    ]));
    expect(validateReportArtifact(report)).toEqual(report);
  });

  it("rejects valid manifests outside the canonical tasks/<id>.yaml path", async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "infra/wrong.yaml"), manifest("wrong-path"));
    const report = preflight(await runTask({
      cwd: dir,
      manifestPath: "infra/wrong.yaml",
    }));
    expect(report.error).toMatchObject({
      stage: "manifest",
      code: "MANIFEST_PATH_INVALID",
    });
    expect(report.task?.id).toBe("wrong-path");
  });

  it("anchors canonical manifests and evidence at the Git root when invoked below it", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "nested-invocation");
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const outcome = await runTask({
      cwd: nested,
      manifestPath: `../${manifestPath}`,
      testCommand: 'node -e "process.exit(0)"',
    });
    const report = normal(outcome);
    expect(report.status).toBe("passed");
    expect(report.task.path).toBe(realpathSync(join(dir, manifestPath)));
    expect(realpathSync(outcome.reportPath).startsWith(realpathSync(join(dir, "tasks/runs")))).toBe(true);
  });

  it("rejects a nested lookalike tasks directory instead of treating cwd as the repository root", async () => {
    const dir = makeRepo();
    const nested = join(dir, "nested");
    mkdirSync(join(nested, "tasks"), { recursive: true });
    writeFileSync(
      join(nested, "tasks/nested-lookalike.yaml"),
      manifest("nested-lookalike", { allowed: ["nested/tasks/**"] }),
    );
    const outcome = await runTask({
      cwd: nested,
      manifestPath: "tasks/nested-lookalike.yaml",
    });
    const report = preflight(outcome);
    expect(report.error.code).toBe("MANIFEST_PATH_INVALID");
    expect(realpathSync(outcome.reportPath).startsWith(realpathSync(join(dir, "tasks/runs")))).toBe(true);
  });

  it("rejects a canonical-looking manifest that is a symbolic link", async () => {
    const dir = makeRepo();
    const source = join(dir, "manifest-source.yaml");
    writeFileSync(source, manifest("linked-task"));
    mkdirSync(join(dir, "tasks"), { recursive: true });
    symlinkSync(source, join(dir, "tasks/linked-task.yaml"));
    const report = preflight(await runTask({
      cwd: dir,
      manifestPath: "tasks/linked-task.yaml",
    }));
    expect(report.error.code).toBe("MANIFEST_PATH_INVALID");
  });

  it("writes a validated Git preflight report instead of accepting another branch", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "exact-branch");
    git(dir, ["switch", "-q", "-c", "feature/not-the-task"]);
    const outcome = await runTask({ cwd: dir, manifestPath });
    const report = preflight(outcome);
    expect(report.error).toMatchObject({
      stage: "git",
      code: "GIT_BRANCH_MISMATCH",
    });
    expect(report.task?.id).toBe("exact-branch");
    expect(report.branch).toBe("feature/not-the-task");
    expect(eventData(report, "policy.decision")).toContainEqual(
      expect.objectContaining({ action: "git.branch", effect: "deny" }),
    );
  });

  it("accepts detached CI only when branch label and checked-out SHA are verified", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "ci-task");
    git(dir, ["switch", "-q", "-c", "tasks/ci-task"]);
    git(dir, ["add", manifestPath]);
    git(dir, ["commit", "-q", "-m", "task manifest"]);
    const headSha = git(dir, ["rev-parse", "HEAD"]);
    const baseSha = git(dir, ["rev-parse", "main"]);
    git(dir, ["switch", "--detach", "-q", headSha]);

    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      gitContext: {
        mode: "ci",
        headRef: "tasks/ci-task",
        headSha,
        baseRef: baseSha,
      },
      testCommand: 'node -e "process.exit(0)"',
    }));
    expect(report.status).toBe("passed");
    expect(report.git).toMatchObject({ mode: "ci", detached: true, headSha });
  });

  it("routes an incomplete CI tuple through a structured Git preflight report", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "ci-tuple-incomplete");
    const output: string[] = [];

    const exitCode = await runCli([
      "run",
      manifestPath,
      "--ci-head-ref",
      "tasks/ci-tuple-incomplete",
    ], { cwd: dir, out: (line) => output.push(line) });

    expect(exitCode).toBe(1);
    const report = validateReportArtifact(JSON.parse(output[0] ?? ""));
    expect(report.schema).toBe(RUN_PREFLIGHT_REPORT_SCHEMA);
    if (report.schema === RUN_PREFLIGHT_REPORT_SCHEMA) {
      expect(report.error).toMatchObject({
        stage: "git",
        code: "GIT_CI_CONTEXT_INVALID",
      });
    }
  });

  it("rejects shell operators instead of interpreting an allowed command prefix", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "no-shell");
    const command =
      'node -e "process.exit(0)" && node -e "require(\'node:fs\').writeFileSync(\'infra/rogue.txt\',\'x\')"';
    const report = normal(await runTask({ cwd: dir, manifestPath, testCommand: command }));
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("TEST_COMMAND_INVALID");
    expect(report.tests).toBeUndefined();
    expect(existsSync(join(dir, "infra/rogue.txt"))).toBe(false);
  });

  it("returns structured evidence for invalid timeout text", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "invalid-timeout");
    const output: string[] = [];

    const exitCode = await runCli([
      "run",
      manifestPath,
      "--timeout-ms",
      "not-a-number",
      "--test-cmd",
      'node -e "process.exit(0)"',
    ], { cwd: dir, out: (line) => output.push(line) });

    expect(exitCode).toBe(1);
    const report = validateReportArtifact(JSON.parse(output[0] ?? ""));
    expect(report.schema).toBe(CURRENT_RUN_REPORT_SCHEMA);
    if (report.schema === CURRENT_RUN_REPORT_SCHEMA) {
      expect(report.failure).toMatchObject({
        stage: "tests",
        code: "TEST_TIMEOUT_INVALID",
      });
      expect(report.tests).toBeUndefined();
    }
  });

  it("blocks a test that mutates the validated manifest", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "immutable-manifest");
    const script = [
      "const fs=require('node:fs')",
      "fs.writeFileSync('tasks/immutable-manifest.yaml','changed')",
      "fs.mkdirSync('infra',{recursive:true})",
      "fs.writeFileSync('infra/rogue.txt','also changed')",
    ].join(";");
    const command = `node -e ${JSON.stringify(script)}`;
    const report = normal(await runTask({ cwd: dir, manifestPath, testCommand: command }));
    expect(report.status).toBe("blocked");
    expect(report.tests?.ok).toBe(true);
    expect(report.failure?.code).toBe("MANIFEST_MUTATED_DURING_RUN");
    expect(report.policy.violations).toContain("infra/rogue.txt");
    expect(report.git?.postTest?.policyPaths).toContain("infra/rogue.txt");
  });

  it("blocks a same-content manifest replacement with a symbolic link", async () => {
    const id = "manifest-link-swap";
    const yaml = manifest(id);
    const dir = makeRepo({ "manifest-source.yaml": yaml });
    const manifestPath = writeManifest(dir, id, yaml);
    const full = join(dir, manifestPath);
    const source = join(dir, "manifest-source.yaml");
    const script = [
      "const fs=require('node:fs')",
      `fs.unlinkSync(${JSON.stringify(full)})`,
      `fs.symlinkSync(${JSON.stringify(source)},${JSON.stringify(full)})`,
    ].join(";");
    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: `node -e ${JSON.stringify(script)}`,
    }));
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("MANIFEST_MUTATED_DURING_RUN");
  });

  it("blocks test writes to Git metadata that normal diffs cannot expose", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "git-metadata-write");
    const command =
      'node -e "require(\'node:fs\').writeFileSync(\'.git/rogue\',\'x\')"';
    const report = normal(await runTask({ cwd: dir, manifestPath, testCommand: command }));

    expect(report.status).toBe("blocked");
    expect(report.tests?.ok).toBe(true);
    expect(report.failure).toMatchObject({
      stage: "git",
      code: "GIT_METADATA_CHANGED",
    });
  });

  it("blocks new ignored files even under the report output directory", async () => {
    const dir = makeRepo({
      ".gitignore": "tasks/runs/*.json\n",
      "packages/seed.md": "base\n",
    });
    const manifestPath = writeManifest(dir, "ignored-report-write");
    const command = [
      "const fs=require('node:fs')",
      "fs.mkdirSync('tasks/runs',{recursive:true})",
      "fs.writeFileSync('tasks/runs/rogue.json','{}')",
    ].join(";");
    const report = normal(await runTask({
      cwd: dir,
      manifestPath,
      testCommand: `node -e ${JSON.stringify(command)}`,
    }));

    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("POST_TEST_PATH_SCOPE_VIOLATION");
    expect(report.policy.violations).toContain("tasks/runs/rogue.json");
  });

  it("reserves historical report paths even when a manifest broadly allows tasks", async () => {
    const dir = makeRepo({
      ".gitignore": "tasks/runs/*.json\n",
      "packages/seed.md": "base\n",
    });
    const id = "reserved-report-write";
    const manifestPath = writeManifest(
      dir,
      id,
      manifest(id, { allowed: ["packages/**", "tasks/**"] }),
    );
    const oldReport =
      "tasks/runs/old-task-2026-08-31T12-00-00-000Z-abcdef123456.json";
    mkdirSync(dirname(join(dir, oldReport)), { recursive: true });
    writeFileSync(join(dir, oldReport), "{}\n");
    const command =
      `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(oldReport)},'{\"tampered\":true}')`)}`;

    const report = normal(await runTask({ cwd: dir, manifestPath, testCommand: command }));

    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("POST_TEST_PATH_SCOPE_VIOLATION");
    expect(report.policy.violations).toContain(oldReport);
  });

  it("never follows a task-created evidence-directory symlink", async () => {
    const dir = makeRepo();
    const external = mkdtempSync(join(tmpdir(), "harness-evidence-escape-"));
    repos.push(external);
    const id = "evidence-symlink";
    const manifestPath = writeManifest(
      dir,
      id,
      manifest(id, { allowed: ["packages/**", "tasks/**"] }),
    );
    const command = [
      "const fs=require('node:fs')",
      `fs.symlinkSync(${JSON.stringify(external)},'tasks/runs')`,
    ].join(";");

    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: `node -e ${JSON.stringify(command)}`,
    });
    const report = normal(outcome);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportPath.startsWith(realpathSync(external))).toBe(false);
    expect(report.policy.violations).toContain("tasks/runs");
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "POST_TEST_PATH_SCOPE_VIOLATION" }),
      expect.objectContaining({ code: "SESS_PERSIST_FAILED" }),
      expect.objectContaining({ code: "REPORT_WRITE_FAILED" }),
    ]));
    expect(existsSync(join(external, "sessions.sqlite"))).toBe(false);
    expect(readFileSync(outcome.reportPath, "utf8")).toContain("tasks/runs");
    rmSync(outcome.reportPath, { force: true });
  });

  it("turns an unsafe durable-session artifact into typed preflight evidence", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "evidence-failure");
    mkdirSync(join(dir, "tasks/runs/sessions.sqlite"), { recursive: true });

    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
    });
    const report = preflight(outcome);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportWritten).toBe(true);
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({
      stage: "git",
      code: "GIT_EVIDENCE_INVALID",
    });
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GIT_EVIDENCE_INVALID" }),
      expect.objectContaining({ code: "SESS_PERSIST_FAILED" }),
    ]));
    expect(report.deliverables.artifacts).toEqual([]);
    expect(report.deliverables.sessionId).toBeUndefined();
    expect(eventData(report, "run.recorded")).toEqual([]);
  });

  it("falls back to a structured failed artifact when the preferred report write fails", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "report-failure");
    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
      reportWriter(path, value) {
        if (path.startsWith(realpathSync(dir))) {
          throw new Error("preferred report storage is offline");
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    });
    const report = normal(outcome);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportWritten).toBe(true);
    expect(outcome.reportPath.startsWith(dir)).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({
      stage: "report",
      code: "REPORT_WRITE_FAILED",
    });
    expect(report.failures).toEqual([
      expect.objectContaining({ code: "REPORT_WRITE_FAILED" }),
    ]);
    expect(report.tests?.ok).toBe(true);
    expect(report.git?.postTest).toBeDefined();
    expect(report.deliverables).toMatchObject({
      reportPath: outcome.reportPath,
      reportWritten: true,
    });
    expect(validateReportArtifact(
      JSON.parse(readFileSync(outcome.reportPath, "utf8")),
    )).toEqual(report);
    rmSync(outcome.reportPath, { force: true });
  });

  it("returns validated in-memory evidence when every report destination fails", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "report-unwritable");
    const previousTmpdir = process.env.TMPDIR;
    const outcome = await (async () => {
      process.env.TMPDIR = join(dir, "missing-temp-parent");
      try {
        return await runTask({
          cwd: dir,
          manifestPath,
          testCommand: 'node -e "process.exit(0)"',
          reportWriter() {
            throw new Error("all report storage is offline");
          },
        });
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
      }
    })();
    const report = normal(outcome);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportWritten).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({
      stage: "report",
      code: "REPORT_FALLBACK_WRITE_FAILED",
    });
    expect(report.deliverables.reportWritten).toBe(false);
    expect(eventData(report, "run.recorded")).toEqual([]);
    expect(validateReportArtifact(report)).toEqual(report);
  });

  it("does not attest success when an injected report writer commits nothing", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "report-noop");
    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
      reportWriter() {},
    });
    const report = normal(outcome);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.reportWritten).toBe(false);
    expect(report.status).toBe("failed");
    expect(report.failure?.code).toBe("REPORT_FALLBACK_WRITE_FAILED");
    expect(eventData(report, "run.recorded")).toEqual([]);
  });

  it("awaits an asynchronous report writer and verifies its bytes", async () => {
    const dir = makeRepo();
    const manifestPath = writeManifest(dir, "report-async");
    const outcome = await runTask({
      cwd: dir,
      manifestPath,
      testCommand: 'node -e "process.exit(0)"',
      async reportWriter(path, value) {
        await Promise.resolve();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.reportWritten).toBe(true);
    expect(readFileSync(outcome.reportPath, "utf8")).toBe(
      `${JSON.stringify(outcome.report, null, 2)}\n`,
    );
  });
});

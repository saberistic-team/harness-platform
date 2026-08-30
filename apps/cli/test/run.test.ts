import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCli } from "../src/main";
import { runTask } from "../src/run";

function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "harness@test.local"]);
  git(["config", "user.name", "Harness Test"]);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(["add", "-A"]);
  if (Object.keys(files).length === 0) {
    mkdirSync(join(dir, "packages"), { recursive: true });
    writeFileSync(join(dir, "packages/seed.md"), "harness-test-repo\n");
    git(["add", "-A"]);
  }
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

const GOOD_NODE_CMD = 'node -e "process.exit(0)"';

const MANIFEST = [
  "id: kernel-0001",
  'title: "Add agent event serialization"',
  "goal: >\n  Implement JSON serialization and deserialization for all kernel events.",
  "acceptance:",
  "  - All event variants round-trip without data loss",
  "  - Unknown event versions return a typed error",
  "  - Unit and integration tests pass",
  "allowed_paths:",
  "  - packages/**",
  "permissions:",
  "  process.exec:",
  '    "node -e *": allow',
  '    "*": deny',
  "  network: deny",
  "delivery:",
  "  type: pull_request",
].join("\n");

function manifest(id: string, allowed: string[], execPatterns: string[]): string {
  const perms = execPatterns
    .map((p) => `    "${p}": allow`)
    .concat(['    "*": deny'])
    .join("\n");
  return [
    `id: ${id}`,
    `title: "Task ${id}"`,
    "goal: Stay inside the allowed set",
    "acceptance:",
    "  - policy holds",
    "allowed_paths:",
    ...allowed.map((a) => `  - ${a}`),
    "permissions:",
    "  process.exec:",
    perms,
    "  network: deny",
    "delivery:",
    "  type: none",
  ].join("\n");
}

describe("harness run (exit gate)", () => {
  it("passes a green run and writes a structured report", async () => {
    const dir = makeRepo({ "packages/events/README.md": "x" });
    try {
      writeFileSync(join(dir, "tasks.yaml"), MANIFEST);
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: 'node -e "console.log(\'Tests 3 passed (3)\')"',
        branch: undefined,
      });
      expect(res.exitCode).toBe(0);
      expect(res.report.status).toBe("passed");
      expect(res.report.branch).toBe("tasks/kernel-0001");
      expect(res.report.policy.changedPathsOk).toBe(true);
      expect(res.report.tests?.ok).toBe(true);
      expect(res.report.tests?.passed).toBe(3);
      // The run's event stream is persisted as a session log:
      expect(res.report.deliverables.sessionId).toBeTruthy();
      expect(res.report.deliverables.artifacts).toContain(
        "tasks/runs/sessions.sqlite",
      );
      const onDisk = JSON.parse(readFileSync(res.reportPath, "utf8"));
      expect(onDisk.schema).toBe("run-report/v1");
      expect(onDisk.events.length).toBeGreaterThanOrEqual(1);
      // Events on disk must be valid JSON:
      for (const e of onDisk.events) JSON.parse(e);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the CI-provided pull-request URL as the delivery link", async () => {
    const dir = makeRepo({ "packages/events/README.md": "x" });
    try {
      writeFileSync(join(dir, "tasks.yaml"), MANIFEST);
      const pr = "https://github.com/saberistic-team/harness-platform/pull/42";
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: 'node -e "console.log(\'Tests 1 passed (1)\')"',
        prUrl: pr,
      });
      expect(res.exitCode).toBe(0);
      expect(res.report.deliverables.pullRequest).toBe(pr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // A failed run carries the URL too (evidence belongs where it happened)
    // — fresh repo: the first run's report artifacts would otherwise be
    // (correctly!) flagged by the policy gate.
    const dir2 = makeRepo({ "packages/events/README.md": "x" });
    try {
      writeFileSync(join(dir2, "tasks.yaml"), MANIFEST);
      const pr = "https://github.com/saberistic-team/harness-platform/pull/43";
      const failed = await runTask({
        cwd: dir2,
        manifestPath: "tasks.yaml",
        testCommand: 'node -e "process.exit(1)"',
        prUrl: pr,
      });
      expect(failed.report.status).toBe("failed");
      expect(failed.report.deliverables.pullRequest).toBe(pr);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("works on a detached-HEAD checkout when a branch is pinned (CI)", async () => {
    const dir = makeRepo({ "packages/events/README.md": "x" });
    try {
      writeFileSync(join(dir, "tasks.yaml"), MANIFEST);
      // Simulate a CI detached-HEAD checkout (actions/checkout on a PR).
      execFileSync("git", ["checkout", "--detach"], { cwd: dir, stdio: "ignore" });
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: 'node -e "console.log(\'Tests 1 passed (1)\')"',
        branch: "tasks/kernel-0001",
      });
      expect(res.exitCode).toBe(0);
      expect(res.report.branch).toBe("tasks/kernel-0001");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the run failed when tests fail", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "tasks.yaml"), MANIFEST);
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: 'node -e "process.exit(1)"',
      });
      expect(res.exitCode).toBe(1);
      expect(res.report.status).toBe("failed");
      expect(res.report.tests?.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a run whose changed paths escape allowed_paths", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(
        join(dir, "tasks.yaml"),
        manifest("kernel-0002", ["packages/**"], ['node -e *']),
      );
      // A change outside the allowed set:
      mkdirSync(join(dir, "infra/docker"), { recursive: true });
      writeFileSync(join(dir, "infra/docker/rogue.Dockerfile"), "FROM scratch\n");
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: GOOD_NODE_CMD,
      });
      expect(res.exitCode).toBe(1);
      expect(res.report.status).toBe("blocked");
      expect(res.report.policy.violations).toContain(
        "infra/docker/rogue.Dockerfile",
      );
      expect(res.report.tests).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks a run whose test command is denied by policy", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(
        join(dir, "tasks.yaml"),
        manifest("kernel-0003", ["packages/**"], []),
      );
      const res = await runTask({
        cwd: dir,
        manifestPath: "tasks.yaml",
        testCommand: "pnpm test",
      });
      expect(res.exitCode).toBe(1);
      expect(res.report.status).toBe("blocked");
      expect(res.report.tests).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validate command reports manifest validity", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "tasks.yaml"), MANIFEST);
      const ok = await runCli(["validate", "tasks.yaml"], { cwd: dir });
      expect(ok).toBe(0);
      writeFileSync(join(dir, "bad.yaml"), "id: 1\n");
      const bad = await runCli(["validate", "bad.yaml"], { cwd: dir });
      expect(bad).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

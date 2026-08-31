import {
  execFileSync,
  spawn as nodeSpawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CURRENT_RUN_REPORT_SCHEMA,
  runReportSchema,
  type RunReport,
} from "@harness/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { runBootstrapTask } from "../src/bootstrap";
import {
  createPiCliAgent,
  type TaskAgent,
  type TaskAgentInput,
} from "../src/pi-agent";

const repos: string[] = [];

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function makeRepo(id: string): { dir: string; manifestPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-bootstrap-"));
  repos.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "harness@test.local"]);
  git(dir, ["config", "user.name", "Harness Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(dir, "packages"), { recursive: true });
  writeFileSync(join(dir, "packages/seed.txt"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);

  const manifestPath = `tasks/${id}.yaml`;
  mkdirSync(dirname(join(dir, manifestPath)), { recursive: true });
  writeFileSync(join(dir, manifestPath), [
    `id: ${id}`,
    `title: "Bootstrap ${id}"`,
    "goal: Have an agent create the requested file",
    "acceptance:",
    "  - generated file exists",
    "allowed_paths:",
    "  - packages/**",
    `  - tasks/${id}.yaml`,
    "permissions:",
    "  fs.read: allow",
    "  fs.write: ask",
    "  process.exec:",
    '    "node -e **": allow',
    '    "*": deny',
    "  network: deny",
    "  git.push: deny",
    "delivery:",
    "  type: none",
  ].join("\n"));
  return { dir, manifestPath };
}

afterEach(() => {
  for (const dir of repos.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function normal(report: Awaited<ReturnType<typeof runBootstrapTask>>["report"]): RunReport {
  expect(report.schema).toBe(CURRENT_RUN_REPORT_SCHEMA);
  if (report.schema !== CURRENT_RUN_REPORT_SCHEMA) throw new Error("expected run report");
  return report;
}

function events(report: RunReport, type: string): Array<Record<string, unknown>> {
  return report.events
    .map((wire) => JSON.parse(wire) as {
      type: string;
      data: Record<string, unknown>;
    })
    .filter((event) => event.type === type)
    .map((event) => event.data);
}

describe("harness bootstrap", () => {
  it("proves manifest -> task branch -> agent edit -> tests -> report offline", async () => {
    const { dir, manifestPath } = makeRepo("bootstrap-flow");
    let input: TaskAgentInput | undefined;
    const agent: TaskAgent = {
      async run(value) {
        input = value;
        writeFileSync(join(value.cwd, "packages/generated.txt"), "built by fake agent\n");
        return {
          name: "fake-builder",
          finalText: "created packages/generated.txt",
          modelUsage: {
            totalModelTokens: 12,
            totalToolCalls: 1,
            steps: 1,
          },
        };
      },
    };

    const outcome = await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "require(\'node:fs\').accessSync(\'packages/generated.txt\')"',
    });
    const report = normal(outcome.report);

    expect(outcome.exitCode).toBe(0);
    expect(input).toMatchObject({
      branch: "tasks/bootstrap-flow",
      manifestPath: join(realpathSync(dir), manifestPath),
    });
    expect(input?.prompt).toContain('"id": "bootstrap-flow"');
    expect(git(dir, ["branch", "--show-current"])).toBe("tasks/bootstrap-flow");
    expect(report.status).toBe("passed");
    expect(report.builder).toMatchObject({ name: "fake-builder", ok: true });
    expect(report.modelUsage?.totalModelTokens).toBe(12);
    expect(report.policy.changedPaths).toContain("packages/generated.txt");
    expect(events(report, "policy.decision")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "fs.read", effect: "allow" }),
      expect.objectContaining({ action: "fs.write", effect: "ask" }),
      expect.objectContaining({ action: "process.exec", effect: "allow" }),
    ]));
    expect(events(report, "permission.resolved")).toContainEqual(
      expect.objectContaining({ action: "fs.write", decision: "allow" }),
    );
  });

  it("proves the Pi adapter composition edits the task branch and produces a report", async () => {
    const { dir, manifestPath } = makeRepo("pi-adapter-flow");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "created packages/pi-generated.txt" }],
      usage: { totalTokens: 9 },
    };
    const stdout = [
      { type: "session", version: 3, cwd: dir },
      { type: "agent_start" },
      { type: "message_end", message },
      { type: "agent_end", messages: [message], willRetry: false },
      { type: "agent_settled" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const piSpawn = ((
      _executable: string,
      _argv: readonly string[],
      options: { cwd?: string; input?: string },
    ): SpawnSyncReturns<string> => {
      expect(options.cwd).toBe(realpathSync(dir));
      expect(options.input).toContain('"id": "pi-adapter-flow"');
      expect(git(options.cwd ?? dir, ["branch", "--show-current"]))
        .toBe("tasks/pi-adapter-flow");
      writeFileSync(
        join(options.cwd ?? dir, "packages/pi-generated.txt"),
        "built through Pi adapter\n",
      );
      return {
        pid: 321,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: 0,
        signal: null,
      };
    }) as unknown as typeof spawnSync;

    const outcome = await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent: createPiCliAgent({ spawnSync: piSpawn }),
      approveWrite: true,
      testCommand: 'node -e "require(\'node:fs\').accessSync(\'packages/pi-generated.txt\')"',
    });
    const report = normal(outcome.report);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.reportWritten).toBe(true);
    expect(git(dir, ["branch", "--show-current"])).toBe("tasks/pi-adapter-flow");
    expect(readFileSync(join(dir, "packages/pi-generated.txt"), "utf8"))
      .toBe("built through Pi adapter\n");
    expect(report).toMatchObject({
      status: "passed",
      builder: { name: "upstream-pi", ok: true },
      tests: { ok: true },
      modelUsage: { totalModelTokens: 9 },
    });
    expect(runReportSchema.parse(JSON.parse(readFileSync(outcome.reportPath, "utf8"))))
      .toEqual(report);
  });

  it("proves the production streaming Pi path receives the manifest before editing", async () => {
    const { dir, manifestPath } = makeRepo("pi-stream-flow");
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "created packages/pi-stream.txt" }],
      usage: { totalTokens: 11 },
    };
    const stream = [
      { type: "session", version: 3, cwd: realpathSync(dir) },
      { type: "agent_start" },
      { type: "message_end", message },
      { type: "agent_end", messages: [message], willRetry: false },
      { type: "agent_settled" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const script = [
      "let prompt=''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data',chunk=>{prompt+=chunk})",
      "process.stdin.on('end',()=>{",
      "if(!prompt.includes('\\\"id\\\": \\\"pi-stream-flow\\\"')||!prompt.includes('tasks/pi-stream-flow'))process.exit(12)",
      "require('node:fs').writeFileSync('packages/pi-stream.txt','streamed Pi edit\\n')",
      `process.stdout.write(${JSON.stringify(stream)})`,
      "})",
    ].join(";");
    const spawn = ((_executable: string, argv: readonly string[], options: object) => {
      expect(argv).toContain("--print");
      expect(argv).toContain("--no-session");
      expect(argv).toContain("read,grep,find,ls,edit,write");
      return nodeSpawn(process.execPath, ["-e", script], options);
    }) as typeof nodeSpawn;

    const outcome = await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent: createPiCliAgent({ spawn }),
      approveWrite: true,
      testCommand:
        'node -e "require(\'node:fs\').accessSync(\'packages/pi-stream.txt\')"',
    });
    const report = normal(outcome.report);

    expect(outcome.exitCode).toBe(0);
    expect(report).toMatchObject({
      status: "passed",
      tests: { ok: true },
      builder: { name: "upstream-pi", ok: true },
      modelUsage: { totalModelTokens: 11 },
    });
    expect(readFileSync(join(dir, "packages/pi-stream.txt"), "utf8"))
      .toBe("streamed Pi edit\n");
  });

  it("does not invoke the agent when write approval remains unresolved", async () => {
    const { dir, manifestPath } = makeRepo("approval-required");
    let calls = 0;
    const agent: TaskAgent = {
      run() {
        calls += 1;
        return { name: "should-not-run" };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(calls).toBe(0);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("BUILDER_WRITE_APPROVAL_REQUIRED");
    expect(report.tests).toBeUndefined();
  });

  it("blocks an agent's out-of-scope edit before executing tests", async () => {
    const { dir, manifestPath } = makeRepo("builder-scope");
    const agent: TaskAgent = {
      run(input) {
        mkdirSync(join(input.cwd, "infra"), { recursive: true });
        writeFileSync(join(input.cwd, "infra/rogue.txt"), "rogue\n");
        return { name: "fake-builder" };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(99)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.policy.violations).toContain("infra/rogue.txt");
    expect(report.tests).toBeUndefined();
  });

  it("turns an agent exception into a structured builder failure", async () => {
    const { dir, manifestPath } = makeRepo("builder-failure");
    const agent: TaskAgent = {
      run() {
        throw new Error("offline builder exploded");
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("failed");
    expect(report.failure).toMatchObject({
      stage: "builder",
      code: "BUILDER_FAILED",
      message: "offline builder exploded",
    });
    expect(report.builder).toMatchObject({ name: "task-agent", ok: false });
    expect(report.tests).toBeUndefined();
  });

  it("audits and blocks an out-of-scope edit even when the agent then throws", async () => {
    const { dir, manifestPath } = makeRepo("throw-after-write");
    const agent: TaskAgent = {
      run(input) {
        mkdirSync(join(input.cwd, "infra"), { recursive: true });
        writeFileSync(join(input.cwd, "infra/rogue.txt"), "rogue\n");
        throw new Error("failed after editing");
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("PATH_SCOPE_VIOLATION");
    expect(report.policy.violations).toContain("infra/rogue.txt");
    expect(report.builder?.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BUILDER_FAILED", stage: "builder" }),
      expect.objectContaining({ code: "PATH_SCOPE_VIOLATION", stage: "policy" }),
    ]));
    expect(events(report, "error")).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "BUILDER_FAILED", stage: "builder" }),
      expect.objectContaining({ code: "PATH_SCOPE_VIOLATION", stage: "policy" }),
    ]));
  });

  it("revokes the initial branch allow when a throwing agent switches branches", async () => {
    const { dir, manifestPath } = makeRepo("throw-after-switch");
    const agent: TaskAgent = {
      run(input) {
        execFileSync("git", ["switch", "-q", "-c", "tasks/rogue"], {
          cwd: input.cwd,
        });
        throw new Error("failed after switching");
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("GIT_BRANCH_CHANGED");
    expect(events(report, "policy.decision")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "git.branch", effect: "allow" }),
      expect.objectContaining({ action: "git.branch", effect: "deny" }),
    ]));
  });

  it("fails closed when a budgeted builder omits usage evidence", async () => {
    const { dir, manifestPath } = makeRepo("budget-evidence");
    const full = join(dir, manifestPath);
    writeFileSync(full, `${readFileSync(full, "utf8")}\nbudget:\n  max_model_tokens: 10\n`);
    const agent: TaskAgent = {
      run() {
        return { name: "usage-free-builder" };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("BUILDER_USAGE_UNAVAILABLE");
    expect(report.tests).toBeUndefined();
  });

  it("blocks reported usage above a task budget and emits a warning", async () => {
    const { dir, manifestPath } = makeRepo("budget-exceeded");
    const full = join(dir, manifestPath);
    writeFileSync(full, `${readFileSync(full, "utf8")}\nbudget:\n  max_model_tokens: 10\n  max_tool_calls: 2\n`);
    const agent: TaskAgent = {
      run() {
        return {
          name: "expensive-builder",
          modelUsage: {
            totalModelTokens: 11,
            totalToolCalls: 2,
            steps: 1,
          },
        };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("BUILDER_BUDGET_EXCEEDED");
    expect(events(report, "budget.warning")).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "tokens", used: 11, limit: 10 }),
      expect.objectContaining({ metric: "tool_calls", used: 2, limit: 2 }),
    ]));
  });

  it("blocks invalid builder usage counters instead of accepting budget evidence", async () => {
    const { dir, manifestPath } = makeRepo("invalid-usage");
    const full = join(dir, manifestPath);
    writeFileSync(full, `${readFileSync(full, "utf8")}\nbudget:\n  max_tool_calls: 2\n`);
    const agent: TaskAgent = {
      run() {
        return {
          name: "invalid-usage-builder",
          modelUsage: {
            totalModelTokens: 1,
            totalToolCalls: -1,
            steps: 1,
          },
        };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("BUILDER_USAGE_INVALID");
    expect(report.modelUsage).toBeUndefined();
  });

  it("keeps the trusted path contract immutable when an injected agent mutates its copy", async () => {
    const { dir, manifestPath } = makeRepo("immutable-agent-contract");
    const agent: TaskAgent = {
      run(input) {
        try {
          input.manifest.allowed_paths.push("infra/**");
        } catch {
          // Frozen agent input is expected; enforcement must also retain its
          // own independent trusted snapshot.
        }
        mkdirSync(join(input.cwd, "infra"), { recursive: true });
        writeFileSync(join(input.cwd, "infra/rogue.txt"), "rogue\n");
        return { name: "mutating-builder" };
      },
    };
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent,
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(report.status).toBe("blocked");
    expect(report.failure?.code).toBe("PATH_SCOPE_VIOLATION");
    expect(report.policy.violations).toContain("infra/rogue.txt");
  });

  it("attributes unsupported subject rules to the action that actually failed", async () => {
    const { dir, manifestPath } = makeRepo("subject-read-policy");
    const full = join(dir, manifestPath);
    writeFileSync(
      full,
      readFileSync(full, "utf8").replace(
        "  fs.read: allow",
        '  fs.read:\n    "packages/**": allow\n    "*": deny',
      ),
    );
    let calls = 0;
    const report = normal((await runBootstrapTask({
      cwd: dir,
      manifestPath,
      agent: {
        run() {
          calls += 1;
          return { name: "must-not-run" };
        },
      },
      approveWrite: true,
      testCommand: 'node -e "process.exit(0)"',
    })).report);
    expect(calls).toBe(0);
    expect(report.failure?.code).toBe("BUILDER_SUBJECT_POLICY_UNSUPPORTED");
    const decisions = events(report, "policy.decision");
    expect(decisions).toContainEqual(
      expect.objectContaining({ action: "fs.read", effect: "deny" }),
    );
    expect(decisions).not.toContainEqual(
      expect.objectContaining({ action: "fs.write", effect: "deny" }),
    );
  });
});

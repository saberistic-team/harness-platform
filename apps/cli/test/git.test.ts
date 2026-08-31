import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectGitChangeSnapshot,
  expectedTaskBranch,
  GitPreflightError,
  prepareGitPreflight,
  verifyGitInvariants,
  type GitPreflightErrorCode,
} from "../src/git";

const repositories: string[] = [];

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRepository(files: Record<string, string> = { "README.md": "base\n" }): string {
  const root = mkdtempSync(join(tmpdir(), "harness-git-preflight-"));
  repositories.push(root);
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.email", "harness@test.local"]);
  runGit(root, ["config", "user.name", "Harness Test"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function branch(root: string): string | undefined {
  try {
    return runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  } catch {
    return undefined;
  }
}

function expectGitError(action: () => unknown, code: GitPreflightErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GitPreflightError);
  expect((caught as GitPreflightError).code).toBe(code);
}

afterEach(() => {
  for (const root of repositories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Git exit-gate preflight", () => {
  it("derives and creates the exact task branch from main", () => {
    const root = makeRepository();
    const base = runGit(root, ["rev-parse", "HEAD"]);

    expect(expectedTaskBranch("kernel-0001")).toBe("tasks/kernel-0001");
    const evidence = prepareGitPreflight(root, "kernel-0001");

    expect(branch(root)).toBe("tasks/kernel-0001");
    expect(evidence).toMatchObject({
      mode: "local",
      expectedBranch: "tasks/kernel-0001",
      actualBranch: "tasks/kernel-0001",
      detached: false,
      baseRef: "refs/heads/main",
      baseSha: base,
      mergeBaseSha: base,
      headSha: base,
    });
  });

  it("switches to an existing task branch instead of merely reporting it", () => {
    const root = makeRepository();
    runGit(root, ["branch", "tasks/existing-task"]);

    const evidence = prepareGitPreflight(root, "existing-task");

    expect(branch(root)).toBe("tasks/existing-task");
    expect(evidence.actualBranch).toBe("tasks/existing-task");
  });

  it("tracks an existing exact remote task branch when no local branch exists", () => {
    const root = makeRepository();
    const remote = mkdtempSync(join(tmpdir(), "harness-git-remote-"));
    repositories.push(remote);
    runGit(remote, ["init", "-q", "--bare"]);
    runGit(root, ["remote", "add", "origin", remote]);
    runGit(root, ["push", "-q", "origin", "HEAD:refs/heads/tasks/remote-task"]);

    const evidence = prepareGitPreflight(root, "remote-task");

    expect(branch(root)).toBe("tasks/remote-task");
    expect(evidence.actualBranch).toBe("tasks/remote-task");
    expect(runGit(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]))
      .toBe("origin/tasks/remote-task");
  });

  it("does not carry dirty main work onto an existing task branch", () => {
    const root = makeRepository();
    runGit(root, ["branch", "tasks/existing-task"]);
    write(root, "pending.txt", "do not move me\n");

    expectGitError(
      () => prepareGitPreflight(root, "existing-task"),
      "GIT_BRANCH_SWITCH_DIRTY",
    );
    expect(branch(root)).toBe("main");
  });

  it("rejects arbitrary branches and an unverified detached HEAD", () => {
    const wrongBranch = makeRepository();
    runGit(wrongBranch, ["switch", "-q", "-c", "feature/not-a-task"]);
    expectGitError(
      () => prepareGitPreflight(wrongBranch, "expected-task"),
      "GIT_BRANCH_MISMATCH",
    );

    const detached = makeRepository();
    runGit(detached, ["checkout", "-q", "--detach"]);
    expectGitError(
      () => prepareGitPreflight(detached, "expected-task"),
      "GIT_DETACHED_UNVERIFIED",
    );
  });

  it("rejects an arbitrary local base ref that could hide committed task changes", () => {
    const root = makeRepository();
    runGit(root, ["switch", "-q", "-c", "tasks/untrusted-base"]);
    expect(() => prepareGitPreflight(root, "untrusted-base", {
      mode: "local",
      baseRef: "HEAD",
    })).toThrowError(expect.objectContaining({ code: "GIT_BASE_UNTRUSTED" }));
  });

  it("canonicalizes local base names so an ambiguous tag cannot shadow main", () => {
    const root = makeRepository();
    const mainSha = runGit(root, ["rev-parse", "refs/heads/main"]);
    runGit(root, ["switch", "-q", "-c", "tasks/exact-base"]);
    write(root, "task.ts", "export {};\n");
    runGit(root, ["add", "task.ts"]);
    runGit(root, ["commit", "-q", "-m", "task commit"]);
    runGit(root, ["tag", "main", "HEAD"]);

    const evidence = prepareGitPreflight(root, "exact-base", {
      mode: "local",
      baseRef: "main",
    });

    expect(evidence.baseRef).toBe("refs/heads/main");
    expect(evidence.baseSha).toBe(mainSha);
  });

  it("rejects origin/HEAD when it targets a non-main branch", () => {
    const root = makeRepository();
    const base = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/remote-head"]);
    runGit(root, ["branch", "-D", "main"]);
    runGit(root, ["update-ref", "refs/remotes/origin/feature", base]);
    runGit(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feature",
    ]);

    expectGitError(
      () => prepareGitPreflight(root, "remote-head"),
      "GIT_BASE_UNTRUSTED",
    );
  });

  it("scrubs inherited Git routing and configuration environment", () => {
    const root = makeRepository();
    const other = makeRepository({ "OTHER.md": "other\n" });
    const poisoned: Record<string, string> = {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fileMode",
      GIT_CONFIG_VALUE_0: "false",
      GIT_REPLACE_REF_BASE: "refs/evil/",
    };
    const previous = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(poisoned)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }
    try {
      const evidence = prepareGitPreflight(root, "clean-environment");
      expect(evidence.repositoryRoot).toBe(realpathSync(root));
      expect(evidence.actualBranch).toBe("tasks/clean-environment");
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("rejects replacement refs even though replacement lookup is disabled", () => {
    const root = makeRepository();
    const base = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/replaced-object"]);
    write(root, "task.ts", "export {};\n");
    runGit(root, ["add", "task.ts"]);
    runGit(root, ["commit", "-q", "-m", "replacement target"]);
    runGit(root, ["replace", base, "HEAD"]);

    expectGitError(
      () => prepareGitPreflight(root, "replaced-object"),
      "GIT_REPLACE_OBJECTS_UNSAFE",
    );
  });

  it("verifies detached CI head metadata without mutating the checkout", () => {
    const root = makeRepository();
    const baseSha = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/ci-task"]);
    write(root, "allowed/change.ts", "export {};\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", "task change"]);
    const headSha = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["checkout", "-q", "--detach", headSha]);

    const evidence = prepareGitPreflight(root, "ci-task", {
      mode: "ci",
      headRef: "tasks/ci-task",
      headSha,
      baseRef: baseSha,
    });

    expect(branch(root)).toBeUndefined();
    expect(evidence).toMatchObject({
      mode: "ci",
      expectedBranch: "tasks/ci-task",
      detached: true,
      headSha,
      baseSha,
      mergeBaseSha: baseSha,
    });
    expect(evidence.actualBranch).toBeUndefined();

    expectGitError(
      () => prepareGitPreflight(root, "ci-task", {
        mode: "ci",
        headRef: "tasks/another-task",
        headSha,
        baseRef: baseSha,
      }),
      "GIT_BRANCH_MISMATCH",
    );
    expectGitError(
      () => prepareGitPreflight(root, "ci-task", {
        mode: "ci",
        headRef: "tasks/ci-task",
        headSha: baseSha,
        baseRef: baseSha,
      }),
      "GIT_HEAD_MISMATCH",
    );
  });

  it("rejects a symbolic CI base before it can hide a committed rogue delta", () => {
    const root = makeRepository();
    const baseSha = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/ci-immutable-base"]);
    write(root, "forbidden/rogue.ts", "export {};\n");
    runGit(root, ["add", "forbidden/rogue.ts"]);
    runGit(root, ["commit", "-q", "-m", "rogue task delta"]);
    const headSha = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["checkout", "-q", "--detach", headSha]);

    expectGitError(
      () => prepareGitPreflight(root, "ci-immutable-base", {
        mode: "ci",
        headRef: "tasks/ci-immutable-base",
        headSha,
        baseRef: "HEAD",
      }),
      "GIT_CI_CONTEXT_INVALID",
    );

    const evidence = prepareGitPreflight(root, "ci-immutable-base", {
      mode: "ci",
      headRef: "tasks/ci-immutable-base",
      headSha,
      baseRef: baseSha,
    });
    expect(collectGitChangeSnapshot(root, evidence).policyPaths)
      .toContain("forbidden/rogue.ts");
  });

  it("collects committed, staged, unstaged and NUL-safe untracked changes", () => {
    const root = makeRepository({
      "allowed/copy-source.ts": "copy source\n",
      "allowed/old name.ts": "same content\n",
      "allowed/staged.ts": "base\n",
      "allowed/unstaged.ts": "base\n",
    });
    const baseSha = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/change-audit"]);
    mkdirSync(join(root, "forbidden"), { recursive: true });
    renameSync(
      join(root, "allowed/old name.ts"),
      join(root, "forbidden/new name.ts"),
    );
    copyFileSync(
      join(root, "allowed/copy-source.ts"),
      join(root, "forbidden/copied.ts"),
    );
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", "rename across boundary"]);

    write(root, "allowed/staged.ts", "staged\n");
    runGit(root, ["add", "allowed/staged.ts"]);
    write(root, "allowed/unstaged.ts", "unstaged\n");
    const newlinePath = "odd/line\nbreak.ts";
    write(root, newlinePath, "untracked\n");

    const evidence = prepareGitPreflight(root, "change-audit", {
      mode: "local",
      baseRef: "main",
    });
    const snapshot = collectGitChangeSnapshot(root, evidence);

    expect(snapshot.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        origin: "committed",
        status: "R100",
        oldPath: "allowed/old name.ts",
        path: "forbidden/new name.ts",
      }),
      expect.objectContaining({
        origin: "committed",
        status: "C100",
        oldPath: "allowed/copy-source.ts",
        path: "forbidden/copied.ts",
      }),
      expect.objectContaining({ origin: "staged", path: "allowed/staged.ts" }),
      expect.objectContaining({ origin: "unstaged", path: "allowed/unstaged.ts" }),
      { origin: "untracked", status: "?", path: newlinePath },
    ]));
    expect(snapshot.policyPaths).toEqual(expect.arrayContaining([
      "allowed/old name.ts",
      "forbidden/new name.ts",
      "forbidden/copied.ts",
      "allowed/staged.ts",
      "allowed/unstaged.ts",
      newlinePath,
    ]));
    expect(snapshot.policyPaths).not.toContain("allowed/copy-source.ts");
  });

  it("retains staged evidence when the working copy is restored to HEAD", () => {
    const root = makeRepository({ "allowed/layered.ts": "base\n" });
    runGit(root, ["switch", "-q", "-c", "tasks/layered-change"]);
    const evidence = prepareGitPreflight(root, "layered-change", {
      mode: "local",
      baseRef: "main",
    });

    write(root, "allowed/layered.ts", "staged content\n");
    runGit(root, ["add", "allowed/layered.ts"]);
    write(root, "allowed/layered.ts", "base\n");
    const snapshot = collectGitChangeSnapshot(root, evidence);

    expect(snapshot.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "staged", path: "allowed/layered.ts" }),
      expect.objectContaining({ origin: "unstaged", path: "allowed/layered.ts" }),
    ]));
    expect(snapshot.policyPaths).toContain("allowed/layered.ts");
  });

  it("compares raw tracked bytes so clean filters cannot conceal a write", () => {
    const root = makeRepository({
      ".gitattributes": "*.cloak filter=cloak\n",
      "allowed/tracked.cloak": "first secret\n",
    });
    runGit(root, ["config", "filter.cloak.clean", "sed 's/.*/constant/'"]);
    runGit(root, ["config", "filter.cloak.smudge", "cat"]);
    runGit(root, ["add", "--renormalize", "allowed/tracked.cloak"]);
    runGit(root, ["commit", "-q", "-m", "normalize filtered content"]);
    runGit(root, ["switch", "-q", "-c", "tasks/raw-filter"]);
    const evidence = prepareGitPreflight(root, "raw-filter", {
      mode: "local",
      baseRef: "main",
    });

    write(root, "allowed/tracked.cloak", "second secret\n");
    expect(runGit(root, ["diff", "--name-only"])).toBe("");

    const snapshot = collectGitChangeSnapshot(root, evidence);
    expect(snapshot.changes).toContainEqual({
      origin: "unstaged",
      status: "M",
      path: "allowed/tracked.cloak",
    });
    expect(snapshot.policyPaths).toContain("allowed/tracked.cloak");
  });

  it("forces file-mode comparison even when repository config disables it", () => {
    const root = makeRepository({ "allowed/script.sh": "#!/bin/sh\n" });
    runGit(root, ["config", "core.fileMode", "false"]);
    runGit(root, ["switch", "-q", "-c", "tasks/file-mode"]);
    const evidence = prepareGitPreflight(root, "file-mode", {
      mode: "local",
      baseRef: "main",
    });

    chmodSync(join(root, "allowed/script.sh"), 0o755);
    // The fixture Git command honors repository config and sees a clean tree.
    expect(runGit(root, ["diff", "--name-only"])).toBe("");
    const snapshot = collectGitChangeSnapshot(root, evidence);

    expect(snapshot.policyPaths).toContain("allowed/script.sh");
  });

  it("disables checkout hooks while preparing the exact task branch", () => {
    const root = makeRepository();
    const hook = join(root, ".git", "hooks", "post-checkout");
    writeFileSync(hook, "#!/bin/sh\necho ran > hook-ran.txt\n");
    chmodSync(hook, 0o755);

    const evidence = prepareGitPreflight(root, "hook-safe");

    expect(evidence.actualBranch).toBe("tasks/hook-safe");
    expect(existsSync(join(root, "hook-ran.txt"))).toBe(false);
  });

  it("includes ignored task writes while exempting only operational outputs", () => {
    const root = makeRepository({
      ".gitignore": [
        "node_modules/",
        "*.log",
        "*.tsbuildinfo",
        "tasks/runs/*.json",
        "tasks/runs/*.jsonl",
        "tasks/runs/preflight/*.json",
        "*.sqlite",
      ].join("\n"),
      "README.md": "base\n",
    });
    runGit(root, ["switch", "-q", "-c", "tasks/ignored-audit"]);

    // Only operational files that already existed when preflight attested the
    // repository may change without becoming task delta evidence.
    write(root, "node_modules/example/index.js", "dependency\n");
    write(
      root,
      "packages/mcp/live/node_modules/example/index.js",
      "live fixture dependency\n",
    );
    write(root, "tsconfig.tsbuildinfo", "compiler cache\n");
    write(
      root,
      "tasks/runs/old-task-2026-08-31T12-00-00-000Z-abcdef123456.json",
      "{}\n",
    );
    write(root, "tasks/runs/sessions.sqlite", "session evidence\n");
    const evidence = prepareGitPreflight(root, "ignored-audit", {
      mode: "local",
      baseRef: "main",
    });

    write(root, "forbidden/rogue.log", "must be visible\n");
    write(root, "forbidden/state.sqlite", "must also be visible\n");
    write(root, "forbidden/node_modules/rogue.js", "not a workspace dependency\n");
    write(root, "forbidden/rogue.tsbuildinfo", "not a compiler cache path\n");
    write(root, "node_modules/example/index.js", "dependency rebuilt\n");
    write(root, "node_modules/new-package/index.js", "new dependency write\n");
    const vitestCache =
      "node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json";
    write(root, vitestCache, "{\"durations\":[]}\n");
    write(
      root,
      "node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/rogue.json",
      "not an allow-listed volatile cache\n",
    );
    write(root, "tsconfig.tsbuildinfo", "compiler cache rebuilt\n");
    write(
      root,
      "tasks/runs/old-task-2026-08-31T12-00-00-000Z-abcdef123456.json",
      "{\"updated\":true}\n",
    );
    write(root, "tasks/runs/generated.json", "not a report-shaped path\n");
    write(root, "tasks/runs/sessions.sqlite", "session evidence updated\n");

    const snapshot = collectGitChangeSnapshot(root, evidence);

    expect(snapshot.changes).toEqual(expect.arrayContaining([
      {
        origin: "untracked",
        status: "!",
        path: "forbidden/rogue.log",
      },
      {
        origin: "untracked",
        status: "!",
        path: "forbidden/state.sqlite",
      },
      {
        origin: "untracked",
        status: "!",
        path: "forbidden/node_modules/rogue.js",
      },
      {
        origin: "untracked",
        status: "!",
        path: "forbidden/rogue.tsbuildinfo",
      },
      {
        origin: "untracked",
        status: "!",
        path: "node_modules/example/index.js",
      },
      {
        origin: "untracked",
        status: "!",
        path: "node_modules/new-package/index.js",
      },
      {
        origin: "untracked",
        status: "!",
        path: "tasks/runs/generated.json",
      },
    ]));
    expect(snapshot.policyPaths).toEqual(expect.arrayContaining([
      "forbidden/node_modules/rogue.js",
      "forbidden/rogue.log",
      "forbidden/rogue.tsbuildinfo",
      "forbidden/state.sqlite",
      "node_modules/example/index.js",
      "node_modules/new-package/index.js",
      "node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/rogue.json",
      "tasks/runs/generated.json",
      "tasks/runs/old-task-2026-08-31T12-00-00-000Z-abcdef123456.json",
      "tasks/runs/sessions.sqlite",
      "tsconfig.tsbuildinfo",
    ]));
    expect(snapshot.policyPaths).not.toContain(
      "packages/mcp/live/node_modules/example/index.js",
    );
    expect(snapshot.policyPaths).not.toContain(vitestCache);
  });

  it("accepts unchanged legacy reports and SQLite evidence sidecars", () => {
    const root = makeRepository({
      ".gitignore": "tasks/runs/\n",
      "README.md": "base\n",
    });
    runGit(root, ["switch", "-q", "-c", "tasks/legacy-evidence"]);
    const evidencePaths = [
      "tasks/runs/legacy-task-2026-08-30T08-20-37-747Z.json",
      "tasks/runs/preflight/manifest-2026-08-30T08-20-37-747Z.json",
      "tasks/runs/sessions.sqlite",
      "tasks/runs/sessions.sqlite-wal",
      "tasks/runs/sessions.sqlite-shm",
      "tasks/runs/sessions.sqlite-journal",
    ];
    for (const path of evidencePaths) write(root, path, "evidence\n");

    const evidence = prepareGitPreflight(root, "legacy-evidence", {
      mode: "local",
      baseRef: "main",
    });
    const snapshot = collectGitChangeSnapshot(root, evidence);

    for (const path of evidencePaths) {
      expect(snapshot.policyPaths).not.toContain(path);
    }
  });

  it("detects metadata-only chmod changes to ignored operational files", () => {
    const root = makeRepository({
      ".gitignore": "node_modules/\n",
      "README.md": "base\n",
    });
    runGit(root, ["switch", "-q", "-c", "tasks/ignored-mode"]);
    write(root, "node_modules/cache/data.bin", "same bytes\n");
    chmodSync(join(root, "node_modules/cache/data.bin"), 0o644);
    const evidence = prepareGitPreflight(root, "ignored-mode", {
      mode: "local",
      baseRef: "main",
    });

    chmodSync(join(root, "node_modules/cache/data.bin"), 0o600);
    const snapshot = collectGitChangeSnapshot(root, evidence);

    expect(snapshot.policyPaths).toContain("node_modules/cache/data.bin");
  });

  it("detects hardlink inode swaps and rejects multi-link reserved evidence", () => {
    const root = makeRepository({
      ".gitignore": "tasks/runs/\n",
      "README.md": "base\n",
    });
    runGit(root, ["switch", "-q", "-c", "tasks/evidence-hardlink"]);
    const report =
      "tasks/runs/legacy-task-2026-08-30T08-20-37-747Z.json";
    const source = "tasks/runs/replacement-source.tmp";
    write(root, report, "same report bytes\n");
    const evidence = prepareGitPreflight(root, "evidence-hardlink", {
      mode: "local",
      baseRef: "main",
    });

    write(root, source, "same report bytes\n");
    rmSync(join(root, report));
    linkSync(join(root, source), join(root, report));
    rmSync(join(root, source));

    expect(collectGitChangeSnapshot(root, evidence).policyPaths)
      .toContain(report);

    write(root, source, "same report bytes\n");
    rmSync(join(root, report));
    linkSync(join(root, source), join(root, report));

    expectGitError(
      () => collectGitChangeSnapshot(root, evidence),
      "GIT_EVIDENCE_INVALID",
    );
  });

  it("fails closed when the attested branch or HEAD changes", () => {
    const root = makeRepository();
    runGit(root, ["switch", "-q", "-c", "tasks/invariant-task"]);
    const evidence = prepareGitPreflight(root, "invariant-task", {
      mode: "local",
      baseRef: "main",
    });

    runGit(root, ["switch", "-q", "-c", "tasks/other-task"]);
    expectGitError(
      () => verifyGitInvariants(root, evidence),
      "GIT_BRANCH_CHANGED",
    );

    runGit(root, ["switch", "-q", "tasks/invariant-task"]);
    write(root, "allowed/committed.ts", "export {};\n");
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-q", "-m", "unexpected commit"]);
    expectGitError(
      () => verifyGitInvariants(root, evidence),
      "GIT_HEAD_CHANGED",
    );
  });

  it("fails closed when Git metadata changes after attestation", () => {
    const root = makeRepository();
    runGit(root, ["switch", "-q", "-c", "tasks/metadata-task"]);
    const evidence = prepareGitPreflight(root, "metadata-task", {
      mode: "local",
      baseRef: "main",
    });

    write(root, ".git/rogue", "hidden mutation\n");
    expectGitError(
      () => verifyGitInvariants(root, evidence),
      "GIT_METADATA_CHANGED",
    );
  });

  it("attests both per-worktree and common Git metadata", () => {
    const root = makeRepository();
    const container = mkdtempSync(join(tmpdir(), "harness-linked-worktree-"));
    repositories.push(container);
    const linked = join(container, "linked");
    runGit(root, [
      "worktree",
      "add",
      "-q",
      "-b",
      "tasks/linked-metadata",
      linked,
      "main",
    ]);
    const evidence = prepareGitPreflight(linked, "linked-metadata", {
      mode: "local",
      baseRef: "main",
    });
    const worktreeGitDirectory = runGit(linked, [
      "rev-parse",
      "--absolute-git-dir",
    ]);

    write(worktreeGitDirectory, "rogue", "per-worktree mutation\n");
    expectGitError(
      () => verifyGitInvariants(linked, evidence),
      "GIT_METADATA_CHANGED",
    );
    rmSync(join(worktreeGitDirectory, "rogue"));
    verifyGitInvariants(linked, evidence);

    write(linked, "allowed/staged.ts", "export {};\n");
    runGit(linked, ["add", "allowed/staged.ts"]);
    // Per-worktree indices and common object storage are intentional
    // exclusions because ordinary task staging writes both.
    verifyGitInvariants(linked, evidence);

    write(root, ".git/common-rogue", "common mutation\n");
    expectGitError(
      () => verifyGitInvariants(linked, evidence),
      "GIT_METADATA_CHANGED",
    );
  });

  it("rejects index visibility flags that can conceal tracked changes", () => {
    const assume = makeRepository({ "tracked.ts": "base\n" });
    runGit(assume, ["update-index", "--assume-unchanged", "tracked.ts"]);
    expectGitError(
      () => prepareGitPreflight(assume, "assume-hidden"),
      "GIT_INDEX_FLAGS_UNSAFE",
    );

    const skip = makeRepository({ "tracked.ts": "base\n" });
    runGit(skip, ["update-index", "--skip-worktree", "tracked.ts"]);
    expectGitError(
      () => prepareGitPreflight(skip, "skip-hidden"),
      "GIT_INDEX_FLAGS_UNSAFE",
    );
  });

  it("rejects gitlink entries because submodule worktrees evade path snapshots", () => {
    const root = makeRepository();
    const object = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${object},vendor/submodule`,
    ]);

    expectGitError(
      () => prepareGitPreflight(root, "submodule-task"),
      "GIT_SUBMODULE_UNSUPPORTED",
    );
  });

  it("rejects a gitlink in HEAD even when its index entry is staged away", () => {
    const root = makeRepository();
    const object = runGit(root, ["rev-parse", "HEAD"]);
    runGit(root, ["switch", "-q", "-c", "tasks/head-submodule"]);
    runGit(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${object},vendor/submodule`,
    ]);
    runGit(root, ["commit", "-q", "-m", "gitlink in HEAD"]);
    runGit(root, ["update-index", "--force-remove", "vendor/submodule"]);

    expectGitError(
      () => prepareGitPreflight(root, "head-submodule", {
        mode: "local",
        baseRef: "main",
      }),
      "GIT_SUBMODULE_UNSUPPORTED",
    );
  });

  it("fails closed when the comparison base is unavailable", () => {
    const root = makeRepository();
    runGit(root, ["switch", "-q", "-c", "tasks/missing-base"]);
    runGit(root, ["branch", "-D", "main"]);

    expectGitError(
      () => prepareGitPreflight(root, "missing-base", {
        mode: "local",
        baseRef: "main",
      }),
      "GIT_BASE_UNAVAILABLE",
    );
  });
});

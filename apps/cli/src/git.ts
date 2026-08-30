import { execFileSync } from "node:child_process";

export interface GitResult {
  stdout: string;
  ok: boolean;
}

export function git(
  cwd: string,
  args: string[],
): GitResult {
  try {
    return {
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      ok: true,
    };
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message: string };
    return {
      stdout: String(e.stderr ?? e.stdout ?? e.message),
      ok: false,
    };
  }
}

export function currentBranch(cwd: string): string {
  const r = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) throw new Error(`not a git repository: ${r.stdout}`);
  const branch = r.stdout.trim();
  if (branch === "HEAD") {
    throw new Error("git repo is in detached HEAD; check out a branch first");
  }
  return branch;
}

export function ensureBranch(cwd: string, name: string): string {
  const r = git(cwd, ["rev-parse", "--verify", `refs/heads/${name}`]);
  if (r.ok) return name;
  const c = git(cwd, ["checkout", "-b", name]);
  if (!c.ok) throw new Error(`git checkout -b ${name} failed: ${c.stdout}`);
  return name;
}

/** Changed paths: modified + staged + untracked, relative to the root. */
export function changedPaths(cwd: string): string[] {
  const r = git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!r.ok) throw new Error(`git status failed: ${r.stdout}`);
  return r.stdout
    .split("\n")
    .map((line) => {
      // Porcelain format: XY <path> (XY is 2 chars + space).
      const m = line.match(/^..(.+)$/);
      return m?.[1]?.trim() ?? line.trim();
    })
    .filter(Boolean);
}

export function headCommit(cwd: string): string {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  if (!r.ok) throw new Error(`git rev-parse failed: ${r.stdout}`);
  return r.stdout.trim();
}

export function isMainish(branch: string): boolean {
  return branch === "main" || branch === "master" || branch === "trunk" || branch === "develop";
}

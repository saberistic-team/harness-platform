import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { devNull } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAINISH_BRANCHES = ["main", "master", "trunk", "develop"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface GitResult {
  stdout: string;
  ok: boolean;
}

export type GitPreflightErrorCode =
  | "GIT_NOT_REPOSITORY"
  | "GIT_INVALID_TASK_ID"
  | "GIT_BRANCH_MISMATCH"
  | "GIT_BRANCH_SWITCH_DIRTY"
  | "GIT_DETACHED_UNVERIFIED"
  | "GIT_CI_CONTEXT_INVALID"
  | "GIT_HEAD_MISMATCH"
  | "GIT_BASE_UNAVAILABLE"
  | "GIT_BASE_UNTRUSTED"
  | "GIT_MERGE_BASE_UNAVAILABLE"
  | "GIT_COMMAND_FAILED"
  | "GIT_DIFF_INVALID"
  | "GIT_REPOSITORY_CHANGED"
  | "GIT_HEAD_CHANGED"
  | "GIT_BRANCH_CHANGED"
  | "GIT_METADATA_CHANGED"
  | "GIT_INDEX_FLAGS_UNSAFE"
  | "GIT_REPLACE_OBJECTS_UNSAFE"
  | "GIT_SUBMODULE_UNSUPPORTED"
  | "GIT_EVIDENCE_INVALID"
  | "GIT_DIFF_UNSTABLE";

export class GitPreflightError extends Error {
  readonly name = "GitPreflightError";

  constructor(
    readonly code: GitPreflightErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface LocalGitPreflightContext {
  mode: "local";
  /** Optional explicit comparison base. Local runs otherwise discover main. */
  baseRef?: string;
}

export interface CiGitPreflightContext {
  mode: "ci";
  /** Trusted CI event data, not a free-form report label. */
  headRef: string;
  headSha: string;
  /** Immutable full object id supplied by trusted CI event data. */
  baseRef: string;
}

export type GitPreflightContext =
  | LocalGitPreflightContext
  | CiGitPreflightContext;

export interface GitPreflightEvidence {
  repositoryRoot: string;
  mode: GitPreflightContext["mode"];
  expectedBranch: string;
  /** Undefined only for a verified detached CI checkout. */
  actualBranch?: string;
  detached: boolean;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
}

export type GitChangeOrigin =
  | "committed"
  | "staged"
  | "unstaged"
  | "untracked";

export interface GitChange {
  origin: GitChangeOrigin;
  /** Git name-status token: A, M, D, T, R100, etc.; ?/! for untracked/ignored. */
  status: string;
  /** Current/destination path. */
  path: string;
  /** Source path for a detected rename or copy. */
  oldPath?: string;
}

export interface GitChangeSnapshot {
  changes: GitChange[];
  /** Paths that represent writes. Renames contribute both old and new paths. */
  policyPaths: string[];
}

interface GitEvidenceState {
  gitDirectory: string;
  gitDirectoryDigest: string;
  gitCommonDirectory: string;
  gitCommonDirectoryDigest: string;
  objectFormat: "sha1" | "sha256";
  ignoredBaseline: Map<string, string>;
}

const EVIDENCE_STATE = new WeakMap<GitPreflightEvidence, GitEvidenceState>();

function gitErrorOutput(error: unknown): string {
  const value = error as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  const raw = value.stderr ?? value.stdout ?? value.message ?? error;
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
}

/**
 * Git gives GIT_* variables precedence over repository discovery, refs,
 * object storage, the index, and configuration. None of those routing or
 * semantic overrides are trusted input to the exit gate. Rebuild the child
 * environment for every invocation and then set the one deliberate safety
 * override: replacement objects must never participate in object lookup.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase().startsWith("GIT_")) continue;
    environment[name] = value;
  }
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  return environment;
}

function hardenedGitArgs(args: readonly string[]): string[] {
  // A repository-local core.fileMode=false must not conceal executable-bit
  // changes. Command-line configuration has higher priority than file config.
  return ["--no-replace-objects", "-c", "core.fileMode=true", ...args];
}

export function git(
  cwd: string,
  args: string[],
): GitResult {
  try {
    return {
      stdout: execFileSync("git", hardenedGitArgs(args), {
        cwd,
        env: gitEnvironment(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      }),
      ok: true,
    };
  } catch (error) {
    return {
      stdout: gitErrorOutput(error),
      ok: false,
    };
  }
}

function runGitText(
  cwd: string,
  args: string[],
  code: GitPreflightErrorCode = "GIT_COMMAND_FAILED",
  operation = args.join(" "),
): string {
  const result = git(cwd, args);
  if (!result.ok) {
    throw new GitPreflightError(
      code,
      `git ${operation} failed: ${result.stdout.trim() || "unknown git error"}`,
      { args, output: result.stdout },
    );
  }
  return result.stdout;
}

function runGitBuffer(cwd: string, args: string[]): Buffer {
  try {
    return execFileSync("git", hardenedGitArgs(args), {
      cwd,
      env: gitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch (error) {
    const output = gitErrorOutput(error);
    throw new GitPreflightError(
      "GIT_COMMAND_FAILED",
      `git ${args.join(" ")} failed: ${output.trim() || "unknown git error"}`,
      { args, output },
    );
  }
}

const REPORT_EVIDENCE_PATH = new RegExp(
  "^tasks/runs/(?:preflight/)?(?:manifest|[a-z0-9]+(?:-[a-z0-9]+)*)-" +
    "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-" +
    "[0-9a-f]{12}\\.(?:json|jsonl)$",
);

const LEGACY_REPORT_EVIDENCE_PATH = new RegExp(
  "^tasks/runs/(?:preflight/)?(?:manifest|[a-z0-9]+(?:-[a-z0-9]+)*)-" +
    "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z" +
    "\\.(?:json|jsonl)$",
);

const SQLITE_EVIDENCE_PATH =
  /^tasks\/runs\/sessions\.sqlite(?:-(?:wal|shm|journal))?$/u;

function dependencyOrCachePath(path: string): boolean {
  return (
    /^(?:node_modules|evals\/node_modules)(?:\/|$)/.test(path) ||
    /^(?:apps|packages|services)\/[^/]+\/node_modules(?:\/|$)/.test(path) ||
    /^packages\/mcp\/live\/node_modules(?:\/|$)/u.test(path) ||
    path === "tsconfig.tsbuildinfo" ||
    /^(?:apps|packages|services)\/[^/]+\/tsconfig\.tsbuildinfo$/.test(path)
  );
}

function volatileTestCachePath(path: string): boolean {
  // Vitest writes only duration/order metadata here during `vitest run`.
  // Ignore this exact generated shape so the exit gate can run its own suite;
  // neighboring node_modules writes still use baseline fingerprints.
  return /^node_modules\/\.vite\/vitest\/[0-9a-f]{40}\/results\.json$/u.test(path);
}

function evidenceOutputPath(path: string): boolean {
  return SQLITE_EVIDENCE_PATH.test(path) ||
    REPORT_EVIDENCE_PATH.test(path) ||
    LEGACY_REPORT_EVIDENCE_PATH.test(path);
}

function fingerprintPath(
  root: string,
  path: string,
  requireSingleLinkRegular = false,
): string {
  const full = resolve(root, path);
  const stat = lstatSync(full, { bigint: true });
  if (requireSingleLinkRegular && (!stat.isFile() || stat.nlink !== 1n)) {
    throw new GitPreflightError(
      "GIT_EVIDENCE_INVALID",
      `reserved evidence path ${JSON.stringify(path)} must be a single-link regular file`,
      {
        path,
        mode: stat.mode.toString(8),
        nlink: stat.nlink.toString(),
      },
    );
  }
  const hash = createHash("sha256");
  hash.update(path);
  hash.update("\0");
  for (const [label, value] of [
    ["mode", stat.mode],
    ["nlink", stat.nlink],
    ["dev", stat.dev],
    ["ino", stat.ino],
    ["uid", stat.uid],
    ["gid", stat.gid],
    ["rdev", stat.rdev],
    ["size", stat.size],
    ["mtimeNs", stat.mtimeNs],
    ["ctimeNs", stat.ctimeNs],
  ] as const) {
    hash.update(label);
    hash.update(":");
    hash.update(value.toString());
    hash.update("\0");
  }
  if (stat.isSymbolicLink()) {
    hash.update("link\0");
    hash.update(readlinkSync(full));
  } else if (stat.isFile()) {
    hash.update("file\0");
    hash.update(readFileSync(full));
  } else if (stat.isDirectory()) {
    hash.update("directory\0");
  } else {
    hash.update(`special:${stat.mode}\0`);
  }
  return hash.digest("hex");
}

function assertReservedEvidenceFiles(root: string): void {
  const scan = (relativeDirectory: string): void => {
    const directory = resolve(root, relativeDirectory);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // The path gate records a replaced runs/preflight directory itself. Do
    // not follow a symlink or non-directory while validating its children.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (evidenceOutputPath(path)) fingerprintPath(root, path, true);
    }
  };
  scan("tasks/runs");
  scan("tasks/runs/preflight");
}

function excludedGitMetadataPath(path: string): boolean {
  return (
    path === "index" ||
    path === "index.lock" ||
    /^worktrees\/[^/]+\/index(?:\.lock)?$/u.test(path) ||
    path === "objects" ||
    path.startsWith("objects/")
  );
}

function fingerprintTree(directory: string): string {
  const root = realpathSync(directory);
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Index and object writes are expected when the task stages content.
      // Their semantics are attested independently through raw index/tree and
      // diff inspection. Everything else (refs, config, hooks, worktree
      // routing, packed-refs, alternates outside objects, etc.) is metadata.
      if (excludedGitMetadataPath(path)) continue;
      const full = join(current, entry.name);
      hash.update(path);
      hash.update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        walk(full, path);
      } else if (entry.isSymbolicLink()) {
        hash.update("link\0");
        hash.update(readlinkSync(full));
        hash.update("\0");
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(readFileSync(full));
        hash.update("\0");
      } else {
        const stat = lstatSync(full);
        hash.update(`special:${stat.mode}\0`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

function absoluteGitPath(root: string, args: string[], label: string): string {
  const raw = runGitText(root, args).trim();
  if (!isAbsolute(raw)) {
    throw new GitPreflightError(
      "GIT_EVIDENCE_INVALID",
      `git returned a non-absolute ${label}`,
      { path: raw },
    );
  }
  return realpathSync(raw);
}

function absoluteGitDirectory(root: string): string {
  return absoluteGitPath(
    root,
    ["rev-parse", "--absolute-git-dir"],
    "per-worktree metadata directory",
  );
}

function absoluteGitCommonDirectory(root: string): string {
  return absoluteGitPath(
    root,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "common metadata directory",
  );
}

function ignoredFiles(root: string): string[] {
  return splitNul(
    runGitBuffer(root, [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]),
    "ignored file list",
  ).map((path) => validateGitPath(path, "ignored file list"));
}

function captureIgnoredBaseline(root: string): Map<string, string> {
  assertReservedEvidenceFiles(root);
  const baseline = new Map<string, string>();
  for (const path of ignoredFiles(root)) {
    if (volatileTestCachePath(path)) continue;
    if (!dependencyOrCachePath(path) && !evidenceOutputPath(path)) continue;
    baseline.set(path, fingerprintPath(root, path, evidenceOutputPath(path)));
  }
  return baseline;
}

function assertVisibleIndex(root: string): void {
  for (const record of splitNul(
    runGitBuffer(root, ["ls-files", "-v", "-z"]),
    "index visibility list",
  )) {
    if (/^(?:[a-z]|S) /u.test(record)) {
      throw new GitPreflightError(
        "GIT_INDEX_FLAGS_UNSAFE",
        "assume-unchanged and skip-worktree index flags are not allowed",
        { record },
      );
    }
  }
}

interface IndexEntry {
  mode: "100644" | "100755" | "120000" | "160000";
  objectId: string;
  path: string;
}

function readIndexEntries(root: string): IndexEntry[] {
  return splitNul(
    runGitBuffer(root, ["ls-files", "--stage", "-z"]),
    "index stage list",
  ).map((record) => {
    const tab = record.indexOf("\t");
    const header = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? undefined : record.slice(tab + 1);
    const match = header.match(/^(100644|100755|120000|160000) ([0-9a-f]+) ([0-3])$/u);
    if (
      !match ||
      path === undefined ||
      !OBJECT_ID.test(match[2] ?? "") ||
      match[3] !== "0"
    ) {
      throw new GitPreflightError(
        "GIT_DIFF_INVALID",
        "the index contains an invalid or unmerged entry",
        { record },
      );
    }
    return {
      mode: match[1] as IndexEntry["mode"],
      objectId: match[2] as string,
      path: validateGitPath(path, "index stage list"),
    };
  });
}

function assertNoReplaceRefs(root: string): void {
  const refs = runGitText(root, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ]).split("\n").filter(Boolean);
  if (refs.length > 0) {
    throw new GitPreflightError(
      "GIT_REPLACE_OBJECTS_UNSAFE",
      "replacement object refs are not allowed by the Git exit gate",
      { refs },
    );
  }
}

function assertNoSubmodules(root: string, head?: string): void {
  for (const entry of readIndexEntries(root)) {
    if (entry.mode === "160000") {
      throw new GitPreflightError(
        "GIT_SUBMODULE_UNSUPPORTED",
        "gitlink/submodule entries are not supported by the path gate",
        { source: "index", path: entry.path },
      );
    }
  }
  if (head === undefined) return;
  for (const record of splitNul(
    runGitBuffer(root, ["ls-tree", "-r", "-z", head, "--"]),
    "HEAD tree list",
  )) {
    const tab = record.indexOf("\t");
    const header = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? undefined : record.slice(tab + 1);
    const match = header.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]+)$/u);
    if (!match || path === undefined || !OBJECT_ID.test(match[3] ?? "")) {
      throw new GitPreflightError(
        "GIT_DIFF_INVALID",
        "the HEAD tree contains an invalid entry",
        { record },
      );
    }
    if (match[1] === "160000") {
      throw new GitPreflightError(
        "GIT_SUBMODULE_UNSUPPORTED",
        "gitlink/submodule entries are not supported by the path gate",
        { source: "HEAD", path: validateGitPath(path, "HEAD tree list") },
      );
    }
  }
}

function repositoryObjectFormat(root: string): "sha1" | "sha256" {
  const format = runGitText(root, ["rev-parse", "--show-object-format"]).trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new GitPreflightError(
      "GIT_EVIDENCE_INVALID",
      "Git returned an unsupported repository object format",
      { format },
    );
  }
  return format;
}

function blobObjectId(format: "sha1" | "sha256", content: Buffer): string {
  const hash = createHash(format);
  hash.update(`blob ${content.length}\0`);
  hash.update(content);
  return hash.digest("hex");
}

type RawTrackedPath =
  | { kind: "missing" }
  | { kind: "type" }
  | { kind: "file"; executable: boolean; content: Buffer }
  | { kind: "symlink"; content: Buffer };

function readRawTrackedPath(root: string, path: string): RawTrackedPath {
  const parts = path.split("/");
  let current = root;
  try {
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index] as string);
      const stat = lstatSync(current);
      if (index < parts.length - 1) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "type" };
        continue;
      }
      if (stat.isSymbolicLink()) {
        return {
          kind: "symlink",
          content: readlinkSync(current, { encoding: "buffer" }),
        };
      }
      if (stat.isFile()) {
        return {
          kind: "file",
          executable: (stat.mode & 0o111) !== 0,
          content: readFileSync(current),
        };
      }
      return { kind: "type" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw new GitPreflightError(
      "GIT_DIFF_INVALID",
      `cannot inspect tracked path ${JSON.stringify(path)}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return { kind: "missing" };
}

/**
 * Compare raw working-tree bytes and modes with the stage-zero index without
 * invoking clean filters, text conversion, or external diff drivers. This is
 * deliberately conservative for repositories whose committed clean filter
 * representation differs from the checked-out bytes: the path remains in the
 * policy delta instead of being allowed to disappear.
 */
function rawTrackedChanges(
  root: string,
  objectFormat: "sha1" | "sha256",
): GitChange[] {
  const changes: GitChange[] = [];
  for (const entry of readIndexEntries(root)) {
    if (entry.mode === "160000") continue;
    const working = readRawTrackedPath(root, entry.path);
    if (working.kind === "missing") {
      changes.push({ origin: "unstaged", status: "D", path: entry.path });
      continue;
    }
    const expectedKind = entry.mode === "120000" ? "symlink" : "file";
    if (working.kind !== expectedKind) {
      changes.push({ origin: "unstaged", status: "T", path: entry.path });
      continue;
    }
    if (
      working.kind === "file" &&
      working.executable !== (entry.mode === "100755")
    ) {
      changes.push({ origin: "unstaged", status: "M", path: entry.path });
      continue;
    }
    if (blobObjectId(objectFormat, working.content) !== entry.objectId) {
      changes.push({ origin: "unstaged", status: "M", path: entry.path });
    }
  }
  return changes;
}

export function repositoryRoot(cwd: string): string {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    throw new GitPreflightError(
      "GIT_NOT_REPOSITORY",
      `not a git repository: ${result.stdout.trim() || cwd}`,
      { cwd, output: result.stdout },
    );
  }
  const root = result.stdout.trim();
  if (root.length === 0) {
    throw new GitPreflightError(
      "GIT_NOT_REPOSITORY",
      "git returned an empty repository root",
      { cwd },
    );
  }
  return root;
}

function branchAtHead(root: string): string | undefined {
  const result = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() : undefined;
}

function refExists(root: string, ref: string): boolean {
  return git(root, ["show-ref", "--verify", "--quiet", ref]).ok;
}

function worktreeIsDirty(root: string): boolean {
  if (runGitBuffer(root, [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]).length > 0) return true;
  return rawTrackedChanges(root, repositoryObjectFormat(root)).length > 0;
}

function resolveCommit(
  root: string,
  ref: string,
  code: GitPreflightErrorCode,
): string {
  if (ref.length === 0 || ref.includes("\0") || ref.includes("\n") || ref.includes("\r")) {
    throw new GitPreflightError(code, "git revision must be a non-empty single-line value", {
      ref,
    });
  }
  const result = git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!result.ok) {
    throw new GitPreflightError(
      code,
      `git revision ${JSON.stringify(ref)} is unavailable`,
      { ref, output: result.stdout },
    );
  }
  const sha = result.stdout.trim();
  if (!OBJECT_ID.test(sha)) {
    throw new GitPreflightError(code, `git revision ${JSON.stringify(ref)} did not resolve to an object id`, {
      ref,
      output: result.stdout,
    });
  }
  return sha;
}

function resolveDefaultBaseRef(root: string, initialBranch?: string): string {
  if (initialBranch && isMainish(initialBranch) && refExists(root, `refs/heads/${initialBranch}`)) {
    return `refs/heads/${initialBranch}`;
  }
  for (const branch of MAINISH_BRANCHES) {
    const ref = `refs/heads/${branch}`;
    if (refExists(root, ref)) return ref;
  }
  const remoteHead = git(root, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead.ok && remoteHead.stdout.trim().length > 0) {
    const target = remoteHead.stdout.trim();
    const match = target.match(/^refs\/remotes\/origin\/([^/]+)$/u);
    if (
      !match ||
      !(MAINISH_BRANCHES as readonly string[]).includes(match[1] as string)
    ) {
      throw new GitPreflightError(
        "GIT_BASE_UNTRUSTED",
        "origin/HEAD must target a protected main branch",
        { target },
      );
    }
    return target;
  }
  for (const branch of MAINISH_BRANCHES) {
    const remote = `refs/remotes/origin/${branch}`;
    if (refExists(root, remote)) return remote;
  }
  throw new GitPreflightError(
    "GIT_BASE_UNAVAILABLE",
    "cannot determine the task branch base; pass an explicit base ref",
  );
}

function canonicalLocalBaseRef(ref: string): string | undefined {
  for (const branch of MAINISH_BRANCHES) {
    if (ref === branch || ref === `refs/heads/${branch}`) {
      return `refs/heads/${branch}`;
    }
    if (ref === `origin/${branch}` || ref === `refs/remotes/origin/${branch}`) {
      return `refs/remotes/origin/${branch}`;
    }
  }
  return undefined;
}

function resolveMergeBase(root: string, baseSha: string, headSha: string): string {
  const result = git(root, ["merge-base", baseSha, headSha]);
  if (!result.ok) {
    throw new GitPreflightError(
      "GIT_MERGE_BASE_UNAVAILABLE",
      "the task HEAD and base do not have an available merge base",
      { baseSha, headSha, output: result.stdout },
    );
  }
  const mergeBaseSha = result.stdout.trim();
  if (!OBJECT_ID.test(mergeBaseSha)) {
    throw new GitPreflightError(
      "GIT_MERGE_BASE_UNAVAILABLE",
      "git merge-base returned an invalid object id",
      { baseSha, headSha, output: result.stdout },
    );
  }
  return mergeBaseSha;
}

export function expectedTaskBranch(taskId: string): string {
  if (!TASK_ID.test(taskId)) {
    throw new GitPreflightError(
      "GIT_INVALID_TASK_ID",
      `task id ${JSON.stringify(taskId)} is not a kebab-case identifier`,
      { taskId },
    );
  }
  return `tasks/${taskId}`;
}

/** Whether the exact task branch is already available locally or from origin. */
export function taskBranchAvailable(cwd: string, taskId: string): boolean {
  const root = repositoryRoot(cwd);
  const branch = expectedTaskBranch(taskId);
  return refExists(root, `refs/heads/${branch}`) ||
    refExists(root, `refs/remotes/origin/${branch}`);
}

/**
 * Establish and attest the task's Git identity. Local mode may create/switch
 * from a mainish branch; CI mode is verification-only and never mutates Git.
 */
export function prepareGitPreflight(
  cwd: string,
  taskId: string,
  context: GitPreflightContext = { mode: "local" },
): GitPreflightEvidence {
  const root = repositoryRoot(cwd);
  const expectedBranch = expectedTaskBranch(taskId);
  assertNoReplaceRefs(root);
  assertNoSubmodules(root);
  assertVisibleIndex(root);
  const initialBranch = branchAtHead(root);
  let actualBranch = initialBranch;

  if (context.mode === "local") {
    if (initialBranch === undefined) {
      throw new GitPreflightError(
        "GIT_DETACHED_UNVERIFIED",
        `detached HEAD is not allowed for a local task run; check out ${expectedBranch}`,
        { expectedBranch },
      );
    }
    if (initialBranch !== expectedBranch) {
      if (!isMainish(initialBranch)) {
        throw new GitPreflightError(
          "GIT_BRANCH_MISMATCH",
          `task ${taskId} must run on ${expectedBranch}, not ${initialBranch}`,
          { expectedBranch, actualBranch: initialBranch },
        );
      }
      const branchExists = refExists(root, `refs/heads/${expectedBranch}`);
      const remoteBranch = `refs/remotes/origin/${expectedBranch}`;
      const remoteBranchExists = refExists(root, remoteBranch);
      if ((branchExists || remoteBranchExists) && worktreeIsDirty(root)) {
        throw new GitPreflightError(
          "GIT_BRANCH_SWITCH_DIRTY",
          `cannot switch from ${initialBranch} to existing branch ${expectedBranch} with pending changes`,
          { expectedBranch, actualBranch: initialBranch },
        );
      }
      const args = branchExists
        ? ["-c", `core.hooksPath=${devNull}`, "switch", expectedBranch]
        : remoteBranchExists
          ? [
              "-c",
              `core.hooksPath=${devNull}`,
              "switch",
              "--track",
              "-c",
              expectedBranch,
              remoteBranch,
            ]
          : [
              "-c",
              `core.hooksPath=${devNull}`,
              "switch",
              "-c",
              expectedBranch,
            ];
      runGitText(root, args, "GIT_COMMAND_FAILED", args.join(" "));
      actualBranch = branchAtHead(root);
    }
    if (actualBranch !== expectedBranch) {
      throw new GitPreflightError(
        "GIT_BRANCH_MISMATCH",
        `task branch preparation did not land on ${expectedBranch}`,
        { expectedBranch, actualBranch },
      );
    }
  } else {
    if (
      context.headRef.length === 0 ||
      !OBJECT_ID.test(context.headSha) ||
      !OBJECT_ID.test(context.baseRef)
    ) {
      throw new GitPreflightError(
        "GIT_CI_CONTEXT_INVALID",
        "CI Git context requires a branch ref plus immutable full head and base object ids",
        { context },
      );
    }
    if (context.headRef !== expectedBranch) {
      throw new GitPreflightError(
        "GIT_BRANCH_MISMATCH",
        `CI head ref ${context.headRef} does not match ${expectedBranch}`,
        { expectedBranch, headRef: context.headRef },
      );
    }
    if (actualBranch !== undefined && actualBranch !== expectedBranch) {
      throw new GitPreflightError(
        "GIT_BRANCH_MISMATCH",
        `CI checkout branch ${actualBranch} does not match ${expectedBranch}`,
        { expectedBranch, actualBranch },
      );
    }
  }

  const headSha = resolveCommit(root, "HEAD", "GIT_HEAD_MISMATCH");
  assertNoSubmodules(root, headSha);
  if (context.mode === "ci") {
    const declaredHeadSha = resolveCommit(root, context.headSha, "GIT_HEAD_MISMATCH");
    if (headSha !== declaredHeadSha) {
      throw new GitPreflightError(
        "GIT_HEAD_MISMATCH",
        `CI checkout HEAD ${headSha} does not match declared head ${declaredHeadSha}`,
        { headSha, declaredHeadSha },
      );
    }
  }

  let baseRef: string;
  if (context.mode === "local") {
    if (context.baseRef === undefined) {
      baseRef = resolveDefaultBaseRef(root, initialBranch);
    } else {
      const canonical = canonicalLocalBaseRef(context.baseRef);
      if (canonical === undefined) {
        throw new GitPreflightError(
          "GIT_BASE_UNTRUSTED",
          `local base ref ${JSON.stringify(context.baseRef)} is not a protected main branch`,
          { baseRef: context.baseRef },
        );
      }
      baseRef = canonical;
    }
  } else {
    baseRef = context.baseRef;
  }
  const baseSha = resolveCommit(root, baseRef, "GIT_BASE_UNAVAILABLE");
  const mergeBaseSha = resolveMergeBase(root, baseSha, headSha);
  assertNoReplaceRefs(root);
  assertNoSubmodules(root, headSha);
  assertVisibleIndex(root);

  const evidence: GitPreflightEvidence = {
    repositoryRoot: root,
    mode: context.mode,
    expectedBranch,
    ...(actualBranch === undefined ? {} : { actualBranch }),
    detached: actualBranch === undefined,
    headSha,
    baseRef,
    baseSha,
    mergeBaseSha,
  };
  const gitDirectory = absoluteGitDirectory(root);
  const gitCommonDirectory = absoluteGitCommonDirectory(root);
  const objectFormat = repositoryObjectFormat(root);
  const ignoredBaseline = captureIgnoredBaseline(root);
  const gitDirectoryDigest = fingerprintTree(gitDirectory);
  const gitCommonDirectoryDigest = gitCommonDirectory === gitDirectory
    ? gitDirectoryDigest
    : fingerprintTree(gitCommonDirectory);
  EVIDENCE_STATE.set(evidence, {
    gitDirectory,
    gitDirectoryDigest,
    gitCommonDirectory,
    gitCommonDirectoryDigest,
    objectFormat,
    ignoredBaseline,
  });
  return evidence;
}

function splitNul(output: Buffer, label: string): string[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw new GitPreflightError(
      "GIT_DIFF_INVALID",
      `${label} was not NUL-terminated`,
    );
  }
  const fields: string[] = [];
  let start = 0;
  try {
    for (let index = 0; index < output.length; index++) {
      if (output[index] !== 0) continue;
      if (index === start) {
        throw new GitPreflightError(
          "GIT_DIFF_INVALID",
          `${label} contained an empty field`,
        );
      }
      fields.push(UTF8.decode(output.subarray(start, index)));
      start = index + 1;
    }
  } catch (error) {
    if (error instanceof GitPreflightError) throw error;
    throw new GitPreflightError(
      "GIT_DIFF_INVALID",
      `${label} contained a path that is not valid UTF-8`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return fields;
}

function validateGitPath(path: string, label: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GitPreflightError(
      "GIT_DIFF_INVALID",
      `${label} contained an invalid repository-relative path`,
      { path },
    );
  }
  return path;
}

function parseNameStatus(
  output: Buffer,
  origin: Exclude<GitChangeOrigin, "untracked">,
): GitChange[] {
  const fields = splitNul(output, `${origin} diff`);
  const changes: GitChange[] = [];
  let index = 0;
  while (index < fields.length) {
    const rawStatus = fields[index++];
    if (rawStatus === undefined || !/^[A-Z][0-9]{0,3}$/.test(rawStatus)) {
      throw new GitPreflightError(
        "GIT_DIFF_INVALID",
        `${origin} diff contained an invalid status token`,
        { status: rawStatus },
      );
    }
    if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath === undefined || path === undefined) {
        throw new GitPreflightError(
          "GIT_DIFF_INVALID",
          `${origin} ${rawStatus} record did not contain two paths`,
        );
      }
      changes.push({
        origin,
        status: rawStatus,
        oldPath: validateGitPath(oldPath, `${origin} diff`),
        path: validateGitPath(path, `${origin} diff`),
      });
      continue;
    }
    const path = fields[index++];
    if (path === undefined) {
      throw new GitPreflightError(
        "GIT_DIFF_INVALID",
        `${origin} ${rawStatus} record did not contain a path`,
      );
    }
    changes.push({
      origin,
      status: rawStatus,
      path: validateGitPath(path, `${origin} diff`),
    });
  }
  return changes;
}

function parseUntracked(output: Buffer): GitChange[] {
  return splitNul(output, "untracked file list").map((path) => ({
    origin: "untracked",
    status: "?",
    path: validateGitPath(path, "untracked file list"),
  }));
}

function parseIgnored(
  root: string,
  output: Buffer,
  baseline: ReadonlyMap<string, string>,
): GitChange[] {
  const changes: GitChange[] = [];
  const currentOperational = new Set<string>();
  for (const raw of splitNul(output, "ignored file list")) {
    const path = validateGitPath(raw, "ignored file list");
    if (volatileTestCachePath(path)) continue;
    if (!dependencyOrCachePath(path) && !evidenceOutputPath(path)) {
      changes.push({ origin: "untracked", status: "!", path });
      continue;
    }
    currentOperational.add(path);
    if (
      baseline.get(path) !==
      fingerprintPath(root, path, evidenceOutputPath(path))
    ) {
      changes.push({ origin: "untracked", status: "!", path });
    }
  }
  for (const path of baseline.keys()) {
    if (!currentOperational.has(path)) {
      changes.push({ origin: "untracked", status: "D!", path });
    }
  }
  return changes;
}

/**
 * Collect the complete task delta: committed changes since the merge base,
 * plus staged, unstaged, untracked, and non-operational ignored files from
 * the working tree. Ignored files are status ! records so broad .gitignore
 * rules cannot conceal an out-of-scope task write.
 */
export function collectGitChangeSnapshot(
  cwd: string,
  evidence: GitPreflightEvidence,
): GitChangeSnapshot {
  verifyGitInvariants(cwd, evidence);
  const root = evidence.repositoryRoot;
  const state = EVIDENCE_STATE.get(evidence);
  if (!state) {
    throw new GitPreflightError(
      "GIT_EVIDENCE_INVALID",
      "Git preflight evidence was not created by this process",
    );
  }
  const config = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
  ];
  const diffArgs = [
    ...config,
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies",
    "--find-copies-harder",
    "--no-ext-diff",
  ];
  const capture = (): GitChangeSnapshot => {
    assertReservedEvidenceFiles(root);
    const unstaged = parseNameStatus(
      runGitBuffer(root, [...diffArgs, "--"]),
      "unstaged",
    );
    for (const raw of rawTrackedChanges(root, state.objectFormat)) {
      if (unstaged.some((change) =>
        change.path === raw.path || change.oldPath === raw.path
      )) continue;
      unstaged.push(raw);
    }
    const changes = [
      ...parseNameStatus(
        runGitBuffer(root, [...diffArgs, evidence.mergeBaseSha, evidence.headSha, "--"]),
        "committed",
      ),
      ...parseNameStatus(
        runGitBuffer(root, [...diffArgs, "--cached", evidence.headSha, "--"]),
        "staged",
      ),
      ...unstaged,
      ...parseUntracked(
        runGitBuffer(root, [
          ...config,
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
      ),
      ...parseIgnored(
        root,
        runGitBuffer(root, [
          ...config,
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ]),
        state.ignoredBaseline,
      ),
    ];
    const paths = new Set<string>();
    for (const change of changes) {
      if (change.status.startsWith("R") && change.oldPath !== undefined) {
        paths.add(change.oldPath);
      }
      paths.add(change.path);
    }
    return { changes, policyPaths: [...paths].sort() };
  };
  const first = capture();
  verifyGitInvariants(cwd, evidence);
  const second = capture();
  verifyGitInvariants(cwd, evidence);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new GitPreflightError(
      "GIT_DIFF_UNSTABLE",
      "repository changes did not remain stable across repeated snapshots",
    );
  }
  return second;
}

/** Fail if a test/process changed the attested repository, HEAD or branch. */
export function verifyGitInvariants(
  cwd: string,
  evidence: GitPreflightEvidence,
): void {
  const root = repositoryRoot(cwd);
  if (root !== evidence.repositoryRoot) {
    throw new GitPreflightError(
      "GIT_REPOSITORY_CHANGED",
      `repository root changed from ${evidence.repositoryRoot} to ${root}`,
      { expectedRoot: evidence.repositoryRoot, actualRoot: root },
    );
  }
  const headSha = resolveCommit(root, "HEAD", "GIT_HEAD_CHANGED");
  if (headSha !== evidence.headSha) {
    throw new GitPreflightError(
      "GIT_HEAD_CHANGED",
      `HEAD changed during the run from ${evidence.headSha} to ${headSha}`,
      { expectedHead: evidence.headSha, actualHead: headSha },
    );
  }
  const actualBranch = branchAtHead(root);
  if (actualBranch !== evidence.actualBranch) {
    throw new GitPreflightError(
      "GIT_BRANCH_CHANGED",
      `branch identity changed during the run from ${evidence.actualBranch ?? "detached HEAD"} to ${actualBranch ?? "detached HEAD"}`,
      {
        expectedBranch: evidence.actualBranch,
        actualBranch,
      },
    );
  }
  assertNoReplaceRefs(root);
  assertNoSubmodules(root, evidence.headSha);
  assertVisibleIndex(root);
  const state = EVIDENCE_STATE.get(evidence);
  if (!state) {
    throw new GitPreflightError(
      "GIT_EVIDENCE_INVALID",
      "Git preflight evidence was not created by this process",
    );
  }
  const gitDirectory = absoluteGitDirectory(root);
  const gitCommonDirectory = absoluteGitCommonDirectory(root);
  const gitDirectoryDigest = fingerprintTree(gitDirectory);
  const gitCommonDirectoryDigest = gitCommonDirectory === gitDirectory
    ? gitDirectoryDigest
    : fingerprintTree(gitCommonDirectory);
  if (
    gitDirectory !== state.gitDirectory ||
    gitCommonDirectory !== state.gitCommonDirectory ||
    gitDirectoryDigest !== state.gitDirectoryDigest ||
    gitCommonDirectoryDigest !== state.gitCommonDirectoryDigest
  ) {
    throw new GitPreflightError(
      "GIT_METADATA_CHANGED",
      "Git metadata changed after preflight attestation",
      {
        expectedDirectory: state.gitDirectory,
        actualDirectory: gitDirectory,
        expectedCommonDirectory: state.gitCommonDirectory,
        actualCommonDirectory: gitCommonDirectory,
      },
    );
  }
}

/** Existing low-level helper retained for callers that require a branch name. */
export function currentBranch(cwd: string): string {
  const root = repositoryRoot(cwd);
  const branch = branchAtHead(root);
  if (branch === undefined) {
    throw new GitPreflightError(
      "GIT_DETACHED_UNVERIFIED",
      "git repository is in detached HEAD",
    );
  }
  return branch;
}

/** Existing helper, corrected to switch when the target branch already exists. */
export function ensureBranch(cwd: string, name: string): string {
  const root = repositoryRoot(cwd);
  if (branchAtHead(root) === name) return name;
  const args = refExists(root, `refs/heads/${name}`)
    ? ["-c", `core.hooksPath=${devNull}`, "switch", name]
    : ["-c", `core.hooksPath=${devNull}`, "switch", "-c", name];
  runGitText(root, args);
  if (branchAtHead(root) !== name) {
    throw new GitPreflightError(
      "GIT_BRANCH_MISMATCH",
      `git did not switch to ${name}`,
      { expectedBranch: name, actualBranch: branchAtHead(root) },
    );
  }
  return name;
}

/**
 * Legacy working-tree-only view. New exit-gate code should use
 * collectGitChangeSnapshot so committed changes and rename endpoints are kept.
 */
export function changedPaths(cwd: string): string[] {
  const root = repositoryRoot(cwd);
  const result = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!result.ok) {
    throw new GitPreflightError(
      "GIT_COMMAND_FAILED",
      `git status failed: ${result.stdout}`,
      { output: result.stdout },
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/^..(.+)$/);
      return match?.[1]?.trim() ?? line.trim();
    })
    .filter(Boolean);
}

export function headCommit(cwd: string): string {
  return resolveCommit(repositoryRoot(cwd), "HEAD", "GIT_COMMAND_FAILED");
}

export function isMainish(branch: string): boolean {
  return (MAINISH_BRANCHES as readonly string[]).includes(branch);
}

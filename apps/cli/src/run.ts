import {
  spawn as spawnProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createEvent,
  deserializeEvent,
  serializeEvent,
  type AnyHarnessEvent,
} from "@harness/events";
import {
  createHarnessTelemetry,
  telemetryFromEnv,
  type HarnessTelemetry,
} from "@harness/otel";
import { compileRules, pathAllowed } from "@harness/policy";
import {
  ManifestParseError,
  RUN_PREFLIGHT_REPORT_SCHEMA,
  CURRENT_RUN_REPORT_SCHEMA,
  loadTaskManifestFile,
  validateRunPreflightReport,
  validateRunReport,
  type ReportArtifact,
  type RunPreflightReport,
  type RunReport,
  type RunReportBuilder,
  type RunReportFailure,
  type TaskManifest,
} from "@harness/sdk";
import { openSqliteSession } from "@harness/sessions";
import {
  GitPreflightError,
  collectGitChangeSnapshot,
  expectedTaskBranch,
  prepareGitPreflight,
  repositoryRoot,
  taskBranchAvailable,
  type GitChangeSnapshot,
  type GitPreflightContext,
  type GitPreflightEvidence,
} from "./git";
import {
  PiAgentError,
  type TaskAgent,
  type TaskAgentResult,
} from "./pi-agent";

export interface TaskBuilderConfig {
  agent: TaskAgent;
  /** Stable fallback identity used when an agent fails before returning. */
  name?: string;
  /** Explicitly resolves a manifest `fs.write: ask` for this run. */
  approveWrite?: boolean;
  timeoutMs?: number;
}

export interface RunArgs {
  cwd: string;
  manifestPath: string;
  gitContext?: GitPreflightContext;
  testCommand?: string;
  testTimeoutMs?: number;
  /** Pull-Request URL to record as the delivery link (CI provides it). */
  prUrl?: string;
  /** Present only for `harness bootstrap`; ordinary `run` gates existing work. */
  builder?: TaskBuilderConfig;
  /** Test seam; production uses the atomic same-directory report writer. */
  reportWriter?: (path: string, value: unknown) => void | Promise<void>;
}

export interface RunOutcome {
  exitCode: number;
  report: ReportArtifact;
  reportPath: string;
  reportWritten: boolean;
}

const DEFAULT_TEST_COMMAND = "pnpm test";
const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const DEFAULT_BUILDER_TIMEOUT_MS = 900_000;
const DB_RELATIVE_PATH = "tasks/runs/sessions.sqlite";
const OUTPUT_TAIL_LINES = 30;
const OUTPUT_TAIL_BYTES = 16 * 1024;
const TEST_OUTPUT_CAPTURE_BYTES = 16 * 1024 * 1024;
const TEST_PROCESS_CLOSE_GRACE_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

function parseTestSummary(output: string): {
  total?: number;
  passed?: number;
  failed?: number;
} {
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

function boundedTail(value: string): string {
  const byLines = value.split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  const bytes = Buffer.from(byLines, "utf8");
  if (bytes.length <= OUTPUT_TAIL_BYTES) return byLines;
  return `…${bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES).toString("utf8")}`;
}

function terminateTestProcessGroup(pid: number | undefined): Error | undefined {
  if (pid === undefined || process.platform === "win32") return undefined;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
      return error instanceof Error ? error : new Error(errorMessage(error));
    }
  }
  return undefined;
}

interface TestProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  cleanupError?: Error;
}

interface BoundedChunks {
  chunks: Buffer[];
  bytes: number;
}

function appendBoundedChunk(target: BoundedChunks, chunk: Buffer): void {
  target.chunks.push(chunk);
  target.bytes += chunk.byteLength;
  while (target.bytes > TEST_OUTPUT_CAPTURE_BYTES) {
    const first = target.chunks[0];
    if (!first) break;
    const excess = target.bytes - TEST_OUTPUT_CAPTURE_BYTES;
    if (first.byteLength <= excess) {
      target.chunks.shift();
      target.bytes -= first.byteLength;
    } else {
      target.chunks[0] = first.subarray(excess);
      target.bytes -= excess;
    }
  }
}

async function runTestProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<TestProcessResult> {
  return await new Promise((resolveResult) => {
    const stdout: BoundedChunks = { chunks: [], bytes: 0 };
    const stderr: BoundedChunks = { chunks: [], bytes: 0 };
    let status: number | null = null;
    let processError: Error | undefined;
    let cleanupError: Error | undefined;
    let timedOut = false;
    let settled = false;
    let closeGuard: NodeJS.Timeout | undefined;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(executable, [...args], {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
    } catch (error) {
      resolveResult({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      });
      return;
    }

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeGuard) clearTimeout(closeGuard);
      child.stdout.destroy();
      child.stderr.destroy();
      resolveResult({
        status,
        stdout: Buffer.concat(stdout.chunks, stdout.bytes).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks, stderr.bytes).toString("utf8"),
        ...(processError ? { error: processError } : {}),
        timedOut,
        ...(cleanupError ? { cleanupError } : {}),
      });
    };

    const stopProcessTree = (): void => {
      if (process.platform === "win32") {
        if (!child.killed) child.kill("SIGKILL");
        return;
      }
      cleanupError ??= terminateTestProcessGroup(child.pid);
    };

    const guardClose = (): void => {
      closeGuard ??= setTimeout(finish, TEST_PROCESS_CLOSE_GRACE_MS);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      appendBoundedChunk(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      appendBoundedChunk(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      processError = error;
      guardClose();
    });
    child.once("exit", (code) => {
      status = code;
      stopProcessTree();
      guardClose();
    });
    child.once("close", (code) => {
      status ??= code;
      finish();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessTree();
      guardClose();
    }, timeoutMs);
  });
}

function validTimeoutMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_MS;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length > 0 ? message : "unknown failure";
}

function gitFailurePolicyAction(code: string): "git.branch" | "workspace.path_scope" {
  return code === "GIT_DIFF_INVALID" ||
      code === "GIT_DIFF_UNSTABLE" ||
      code === "GIT_COMMAND_FAILED" ||
      code === "GIT_DIFF_FAILED"
    ? "workspace.path_scope"
    : "git.branch";
}

function usageCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validModelUsage(
  usage: RunReport["modelUsage"],
): usage is NonNullable<RunReport["modelUsage"]> {
  return usage !== undefined &&
    usageCount(usage.totalModelTokens) &&
    usageCount(usage.totalToolCalls) &&
    usageCount(usage.steps);
}

function reportStamp(started: number, runId: string): string {
  const iso = new Date(started).toISOString().replace(/[:.]/g, "-");
  return `${iso}-${runId.slice(-12)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalTaskIdFromPath(
  repository: string,
  manifestFile: string,
): string | undefined {
  const name = basename(manifestFile);
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.yaml$/u.exec(name);
  if (!match || manifestFile !== resolve(repository, "tasks", name)) {
    return undefined;
  }
  return match[1];
}

function assertCanonicalManifestPath(
  cwd: string,
  manifestFile: string,
  taskId: string,
): void {
  const expected = resolve(cwd, "tasks", `${taskId}.yaml`);
  if (manifestFile !== expected) {
    throw new Error(
      `task ${taskId} must use its canonical manifest tasks/${taskId}.yaml`,
    );
  }
  if (lstatSync(manifestFile).isSymbolicLink()) {
    throw new Error("task manifest must be a regular repository file, not a symbolic link");
  }
  if (!lstatSync(manifestFile).isFile()) {
    throw new Error("task manifest must be a regular repository file");
  }
  const canonicalRoot = realpathSync(cwd);
  const canonicalManifest = realpathSync(manifestFile);
  const expectedCanonical = resolve(
    canonicalRoot,
    "tasks",
    `${taskId}.yaml`,
  );
  if (canonicalManifest !== expectedCanonical) {
    throw new Error("task manifest resolves outside its canonical repository path");
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    // The rename is the artifact commit point. Syncing directory metadata is
    // best-effort because some supported filesystems reject directory fsync.
    let directoryDescriptor: number | undefined;
    try {
      directoryDescriptor = openSync(dirname(path), "r");
      fsyncSync(directoryDescriptor);
    } catch {
      // Atomic visibility is already guaranteed by rename.
    } finally {
      if (directoryDescriptor !== undefined) {
        try {
          closeSync(directoryDescriptor);
        } catch {
          // The rename remains the commit point even if directory close fails.
        }
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may never have been created.
    }
    throw error;
  }
}

function fallbackReportPath(path: string): string {
  const directory = mkdtempSync(join(tmpdir(), "harness-platform-runs-"));
  return join(directory, basename(path));
}

function ensureRegularDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${path} must be a real directory, not a link or special file`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  if (realpathSync(path) !== path) {
    throw new Error(`${path} resolves outside its canonical evidence path`);
  }
}

function ensureEvidenceDirectories(repository: string): void {
  const canonicalRoot = realpathSync(repository);
  if (canonicalRoot !== repository) {
    throw new Error("repository root is not canonical while preparing evidence storage");
  }
  const tasks = join(repository, "tasks");
  const runs = join(tasks, "runs");
  const preflight = join(runs, "preflight");
  ensureRegularDirectory(tasks);
  ensureRegularDirectory(runs);
  ensureRegularDirectory(preflight);
}

function assertSafeSessionFiles(repository: string): void {
  const database = join(repository, DB_RELATIVE_PATH);
  for (const path of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`${path} must be a single-link regular evidence file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function reservedEvidencePath(path: string): boolean {
  return path === "tasks/runs" || path.startsWith("tasks/runs/");
}

interface CommandSpec {
  executable: string;
  args: string[];
}

/** Parse a small argv grammar; shell operators outside quotes are rejected. */
export function parseCommand(command: string): CommandSpec {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) break;
    if (char === "\0" || char === "\n" || char === "\r") {
      throw new Error("test command must be a single NUL-free line");
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\") {
        const next = command[++index];
        if (next === undefined) throw new Error("test command ends with an escape");
        word += next;
      } else {
        word += char;
      }
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    if (char === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[++index];
      if (next === undefined) throw new Error("test command ends with an escape");
      word += next;
      started = true;
      continue;
    }
    if (";&|<>`".includes(char)) {
      throw new Error(`shell operator ${JSON.stringify(char)} is not allowed`);
    }
    word += char;
    started = true;
  }
  if (quote !== undefined) throw new Error("test command has an unterminated quote");
  if (started) words.push(word);
  const [executable, ...args] = words;
  if (!executable) throw new Error("test command is empty");
  return { executable, args };
}

function builderPrompt(manifest: TaskManifest, branch: string): string {
  return [
    "Implement exactly the task contract below in the already checked-out branch.",
    "Read AGENTS.md before editing.",
    `Remain on ${branch}. Do not commit, push, switch branches, or open a pull request.`,
    "Modify only allowed_paths. Use only the available file tools; the harness runs tests after you finish.",
    "Finish after editing and summarize the result.",
    "",
    JSON.stringify(manifest, null, 2),
  ].join("\n");
}

async function startTelemetry(): Promise<HarnessTelemetry | undefined> {
  const options = telemetryFromEnv();
  if (options === null) return undefined;
  try {
    return await createHarnessTelemetry(options);
  } catch (error) {
    console.error(`otel: telemetry disabled: ${errorMessage(error)}`);
    return undefined;
  }
}

async function stopTelemetry(telemetry: HarnessTelemetry | undefined): Promise<void> {
  if (!telemetry) return;
  try {
    await telemetry.forceFlush();
    await telemetry.shutdown();
  } catch (error) {
    console.error(`otel: shutdown failed: ${errorMessage(error)}`);
  }
}

/**
 * Every trusted transition is auditable: manifest -> exact branch/base ->
 * complete path delta -> optional builder -> tests -> post-test verification.
 */
export async function runTask(args: RunArgs): Promise<RunOutcome> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runId = `run-${randomUUID()}`;
  const sessionId = `sess-${randomUUID()}`;
  const invocationCwd = resolve(args.cwd);
  let canonicalInvocationCwd = invocationCwd;
  try {
    canonicalInvocationCwd = realpathSync(invocationCwd);
  } catch {
    // Git/manifest preflight below will return the typed failure.
  }
  let cwd = canonicalInvocationCwd;
  try {
    cwd = repositoryRoot(canonicalInvocationCwd);
  } catch {
    // Manifest failures are still reported first when possible. Git preflight
    // will reproduce the typed repository failure after manifest validation.
  }
  const manifestFile = resolve(canonicalInvocationCwd, args.manifestPath);
  const reportDir = join(cwd, "tasks", "runs");
  const preflightDir = join(reportDir, "preflight");
  const reportWriter = args.reportWriter ?? writeJsonAtomically;
  const commitReport = async (path: string, value: unknown): Promise<void> => {
    const expected = `${JSON.stringify(value, null, 2)}\n`;
    await reportWriter(path, deepFreeze(value));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("report writer did not commit a regular file artifact");
    }
    const actual = readFileSync(path, "utf8");
    if (actual !== expected) {
      throw new Error("report writer returned without committing the expected artifact");
    }
  };

  const telemetry = await startTelemetry();
  const events: string[] = [];
  const eventOptions = () => ({
    at: new Date().toISOString(),
    actor: "harness-cli",
  });
  const push = (event: AnyHarnessEvent) => {
    events.push(serializeEvent(event));
    telemetry?.bridge.onEvent(event);
  };

  const pushPolicy = (
    action: string,
    effect: "allow" | "ask" | "deny",
    reason: string,
    taskId?: string,
    subject?: string,
  ) => {
    push(createEvent("policy.decision", {
      taskId,
      sessionId,
      runId,
      action,
      subject,
      effect,
      reason,
    }, eventOptions()));
  };

  const failureTrail: RunReportFailure[] = [];
  const pushError = (failure: RunReportFailure, taskId?: string) => {
    failureTrail.push(failure);
    push(createEvent("error", {
      code: failure.code,
      message: failure.message,
      taskId,
      sessionId,
      runId,
      stage: failure.stage,
    }, eventOptions()));
  };

  const persistEventWires = async (
    eventWires: readonly string[],
    taskId?: string,
  ): Promise<Error | undefined> => {
    let store: ReturnType<typeof openSqliteSession> | undefined;
    let persistenceError: Error | undefined;
    try {
      ensureEvidenceDirectories(cwd);
      assertSafeSessionFiles(cwd);
      store = openSqliteSession(join(cwd, DB_RELATIVE_PATH), {
        taskId,
        sessionId,
        createdAt: startedAt,
      });
      for (const wire of eventWires) {
        await store.log.append(deserializeEvent(wire));
      }
    } catch (error) {
      persistenceError = error instanceof Error
        ? error
        : new Error(errorMessage(error));
    }
    try {
      store?.close();
    } catch (error) {
      persistenceError ??= error instanceof Error
        ? error
        : new Error(errorMessage(error));
    }
    return persistenceError;
  };

  const pullRequest = (
    args.prUrl ?? process.env.HARNESS_PULL_REQUEST_URL ?? ""
  ).trim() || undefined;

  const finishPreflight = async (
    failure: RunPreflightReport["error"],
    task?: { id: string; title: string },
    branch?: string,
  ): Promise<RunOutcome> => {
    pushError(failure, task?.id);
    const preferredReportPath = join(
      preflightDir,
      `${task?.id ?? "manifest"}-${reportStamp(started, runId)}.json`,
    );
    const persistenceError = await persistEventWires(events, task?.id);
    if (persistenceError) {
      pushError({
        stage: "evidence",
        code: "SESS_PERSIST_FAILED",
        message: errorMessage(persistenceError),
      }, task?.id);
    }
    let reportPath = preferredReportPath;
    let reportWritten = false;
    const build = (willBeWritten: boolean) => validateRunPreflightReport({
      schema: RUN_PREFLIGHT_REPORT_SCHEMA,
      manifestPath: manifestFile,
      runId,
      sessionId,
      status: "failed",
      ...(task ? { task } : {}),
      error: failure,
      failures: [...failureTrail],
      startedAt,
      finishedAt: new Date().toISOString(),
      ...(branch ? { branch } : {}),
      events,
      deliverables: {
        ...(pullRequest ? { pullRequest } : {}),
        artifacts: persistenceError ? [] : [DB_RELATIVE_PATH],
        reportPath,
        ...(persistenceError ? {} : { sessionId }),
        reportWritten: willBeWritten,
      },
    });
    let report = build(true);
    try {
      ensureEvidenceDirectories(cwd);
      await commitReport(reportPath, report);
      reportWritten = true;
    } catch (error) {
      pushError({
        stage: "report",
        code: "REPORT_WRITE_FAILED",
        message: `unable to write ${preferredReportPath}: ${errorMessage(error)}`,
      }, task?.id);
      try {
        reportPath = fallbackReportPath(preferredReportPath);
        report = build(true);
        await commitReport(reportPath, report);
        reportWritten = true;
      } catch (fallbackError) {
        pushError({
          stage: "report",
          code: "REPORT_FALLBACK_WRITE_FAILED",
          message: `unable to write fallback ${reportPath}: ${errorMessage(fallbackError)}`,
        }, task?.id);
        report = build(false);
      }
    }
    await stopTelemetry(telemetry);
    return { exitCode: 1, report, reportPath, reportWritten };
  };

  const gitContext = args.gitContext ?? { mode: "local" as const };
  const candidateTaskId = canonicalTaskIdFromPath(cwd, manifestFile);
  let gitEvidence: GitPreflightEvidence | undefined;

  // If an exact task branch already exists, its manifest is authoritative.
  // Select it by the canonical filename before reading so a missing or stale
  // copy on main cannot make the branch unreachable.
  if (candidateTaskId && gitContext.mode === "local") {
    let existingBranch = false;
    try {
      existingBranch = taskBranchAvailable(cwd, candidateTaskId);
    } catch {
      // The typed repository failure is produced below after manifest parsing.
    }
    if (existingBranch) {
      const expectedBranch = expectedTaskBranch(candidateTaskId);
      try {
        gitEvidence = prepareGitPreflight(cwd, candidateTaskId, gitContext);
        pushPolicy(
          "git.branch",
          "allow",
          `verified ${gitEvidence.expectedBranch} at ${gitEvidence.headSha}`,
          candidateTaskId,
          gitEvidence.expectedBranch,
        );
      } catch (error) {
        const code = error instanceof GitPreflightError
          ? error.code
          : "GIT_PREFLIGHT_FAILED";
        const message = errorMessage(error);
        const actualBranch = error instanceof GitPreflightError &&
            typeof error.details.actualBranch === "string"
          ? error.details.actualBranch
          : undefined;
        pushPolicy("git.branch", "deny", message, candidateTaskId, expectedBranch);
        return finishPreflight(
          { stage: "git", code, message },
          undefined,
          actualBranch,
        );
      }
    }
  }

  let loadedManifest: TaskManifest;
  try {
    loadedManifest = await loadTaskManifestFile(manifestFile);
  } catch (error) {
    const invalid = error instanceof ManifestParseError;
    return finishPreflight({
      stage: "manifest",
      code: invalid ? "MANIFEST_INVALID" : "MANIFEST_READ_FAILED",
      message: errorMessage(error),
      ...(invalid ? { issues: error.issues } : {}),
    });
  }

  const manifest = deepFreeze(structuredClone(loadedManifest));
  const task = { id: manifest.id, title: manifest.title };
  try {
    assertCanonicalManifestPath(cwd, manifestFile, manifest.id);
  } catch (error) {
    return finishPreflight(
      {
        stage: "manifest",
        code: "MANIFEST_PATH_INVALID",
        message: errorMessage(error),
      },
      task,
    );
  }
  const manifestDigest = fileDigest(manifestFile);
  const expectedBranch = expectedTaskBranch(manifest.id);
  if (gitEvidence && gitEvidence.expectedBranch !== expectedBranch) {
    return finishPreflight(
      {
        stage: "manifest",
        code: "MANIFEST_PATH_INVALID",
        message: `manifest id ${manifest.id} does not match canonical task path for ${candidateTaskId}`,
      },
      task,
      gitEvidence.actualBranch,
    );
  }
  if (!gitEvidence) {
    try {
      gitEvidence = prepareGitPreflight(cwd, manifest.id, gitContext);
    } catch (error) {
      const code = error instanceof GitPreflightError
        ? error.code
        : "GIT_PREFLIGHT_FAILED";
      const message = errorMessage(error);
      const actualBranch = error instanceof GitPreflightError &&
          typeof error.details.actualBranch === "string"
        ? error.details.actualBranch
        : undefined;
      pushPolicy("git.branch", "deny", message, manifest.id, expectedBranch);
      return finishPreflight(
        { stage: "git", code, message },
        task,
        actualBranch,
      );
    }
    pushPolicy(
      "git.branch",
      "allow",
      `verified ${gitEvidence.expectedBranch} at ${gitEvidence.headSha}`,
      manifest.id,
      gitEvidence.expectedBranch,
    );
  }
  try {
    assertCanonicalManifestPath(cwd, manifestFile, manifest.id);
    if (fileDigest(manifestFile) !== manifestDigest) {
      throw new Error("task manifest changed while preparing its task branch");
    }
  } catch (error) {
    const message = errorMessage(error);
    pushPolicy("git.branch", "deny", message, manifest.id, expectedBranch);
    return finishPreflight(
      {
        stage: "git",
        code: "MANIFEST_CHANGED_DURING_BRANCH_PREP",
        message,
      },
      task,
      gitEvidence.actualBranch,
    );
  }

  push(createEvent("task.updated", {
    taskId: manifest.id,
    phase: "running",
  }, eventOptions()));

  let initialSnapshot: GitChangeSnapshot;
  try {
    initialSnapshot = collectGitChangeSnapshot(cwd, gitEvidence);
  } catch (error) {
    const code = error instanceof GitPreflightError
      ? error.code
      : "GIT_DIFF_FAILED";
    const message = errorMessage(error);
    const action = gitFailurePolicyAction(code);
    pushPolicy(
      action,
      "deny",
      message,
      manifest.id,
      action === "git.branch" ? expectedBranch : "pre-tests",
    );
    return finishPreflight(
      { stage: "git", code, message },
      task,
      gitEvidence.actualBranch,
    );
  }

  const rules = compileRules(manifest.permissions);
  let modelUsage: RunReport["modelUsage"];
  let builderEvidence: RunReportBuilder | undefined;

  const manifestIntegrityFailure = (): RunReportFailure | undefined => {
    try {
      assertCanonicalManifestPath(cwd, manifestFile, manifest.id);
      if (fileDigest(manifestFile) === manifestDigest) return undefined;
      return {
        stage: "policy",
        code: "MANIFEST_MUTATED_DURING_RUN",
        message: "the task manifest changed after it was validated",
      };
    } catch (error) {
      return {
        stage: "policy",
        code: "MANIFEST_MUTATED_DURING_RUN",
        message: `the validated task manifest is no longer readable: ${errorMessage(error)}`,
      };
    }
  };

  const evaluateScope = (
    snapshot: GitChangeSnapshot,
    subject: string,
  ): string[] => {
    const violations = snapshot.policyPaths.filter((path) =>
      reservedEvidencePath(path) ||
      !pathAllowed(manifest.allowed_paths, path)
    );
    const effect = violations.length === 0 ? "allow" : "deny";
    const reason = violations.length === 0
      ? `${snapshot.policyPaths.length} changed path(s) are inside allowed_paths`
      : `changed paths are outside allowed_paths or reserved evidence: ${violations.join(", ")}`;
    pushPolicy(
      "workspace.path_scope",
      effect,
      reason,
      manifest.id,
      subject,
    );
    return violations;
  };

  const normalReportPath = join(
    reportDir,
    `${manifest.id}-${reportStamp(started, runId)}.json`,
  );

  const finishRun = async (options: {
    status: RunReport["status"];
    preTest: GitChangeSnapshot;
    postTest?: GitChangeSnapshot;
    tests?: RunReport["tests"];
    failure?: RunReportFailure;
    failureEmitted?: boolean;
    violations?: string[];
  }): Promise<RunOutcome> => {
    if (
      options.failure &&
      (
        !options.failureEmitted ||
        !failureTrail.some((failure) =>
          failure.stage === options.failure?.stage &&
          failure.code === options.failure.code &&
          failure.message === options.failure.message
        )
      )
    ) {
      pushError(options.failure, manifest.id);
    }

    let status = options.status;
    let failure = options.failure ?? failureTrail[0];
    const addFailure = (
      next: RunReportFailure,
      replaceReportWritePrimary = false,
    ): void => {
      if (
        failure === undefined ||
        (replaceReportWritePrimary && failure.code === "REPORT_WRITE_FAILED")
      ) {
        failure = next;
      }
      pushError(next, manifest.id);
    };
    let persisted = true;
    const persistenceError = await persistEventWires(events, manifest.id);
    if (persistenceError) {
      persisted = false;
      const persistenceFailure: RunReportFailure = {
        stage: "evidence",
        code: "SESS_PERSIST_FAILED",
        message: errorMessage(persistenceError),
      };
      status = "failed";
      addFailure(persistenceFailure);
    }

    const allPaths = unique([
      ...options.preTest.policyPaths,
      ...(options.postTest?.policyPaths ?? []),
    ]);
    const violations = unique(options.violations ?? []);

    const buildReport = (
      reportPath: string,
      includeDetails: boolean,
      includeReceipt: boolean,
    ): { report: RunReport; terminalEvents: AnyHarnessEvent[] } => {
      const terminal = createEvent("task.updated", {
        taskId: manifest.id,
        phase: status === "passed" ? "delivered" : "blocked",
        ...(failure ? { note: failure.message } : {}),
      }, eventOptions());
      const terminalEvents: AnyHarnessEvent[] = [terminal];
      if (includeReceipt) {
        terminalEvents.push(createEvent("run.recorded", {
          runId,
          taskId: manifest.id,
          status,
          reportPath,
        }, eventOptions()));
      }
      return {
        terminalEvents,
        report: validateRunReport({
          schema: CURRENT_RUN_REPORT_SCHEMA,
          runId,
          task: {
            id: manifest.id,
            title: manifest.title,
            path: manifestFile,
          },
          status,
          startedAt,
          finishedAt: new Date().toISOString(),
          branch: gitEvidence.expectedBranch,
          policy: {
            changedPathsOk: violations.length === 0,
            changedPaths: allPaths,
            violations,
          },
          ...(includeDetails && options.tests ? { tests: options.tests } : {}),
          ...(includeDetails && builderEvidence ? { builder: builderEvidence } : {}),
          ...(includeDetails
            ? {
                git: {
                  ...gitEvidence,
                  preTest: options.preTest,
                  postTest: options.postTest,
                },
              }
            : {}),
          ...(failure ? { failure } : {}),
          ...(failureTrail.length > 0 ? { failures: [...failureTrail] } : {}),
          ...(includeDetails && modelUsage ? { modelUsage } : {}),
          events: [
            ...events,
            ...terminalEvents.map((event) => serializeEvent(event)),
          ],
          deliverables: {
            ...(pullRequest
              ? { pullRequest }
              : status === "passed"
                ? { pullRequest: `branch: ${gitEvidence.expectedBranch}` }
                : {}),
            artifacts: persisted ? [DB_RELATIVE_PATH] : [],
            reportPath,
            ...(persisted ? { sessionId } : {}),
            reportWritten: includeReceipt,
          },
        }),
      };
    };

    let reportPath = normalReportPath;
    let built: { report: RunReport; terminalEvents: AnyHarnessEvent[] };
    let includeDetails = true;
    try {
      built = buildReport(reportPath, includeDetails, true);
    } catch (error) {
      status = "failed";
      const constructionFailure: RunReportFailure = {
        stage: "report",
        code: "REPORT_CONSTRUCTION_FAILED",
        message: errorMessage(error),
      };
      addFailure(constructionFailure);
      includeDetails = false;
      built = buildReport(reportPath, includeDetails, true);
    }

    let reportWritten = false;
    try {
      ensureEvidenceDirectories(cwd);
      await commitReport(reportPath, built.report);
      reportWritten = true;
    } catch (error) {
      status = "failed";
      const writeFailure: RunReportFailure = {
        stage: "report",
        code: "REPORT_WRITE_FAILED",
        message: `unable to write ${reportPath}: ${errorMessage(error)}`,
      };
      addFailure(writeFailure);
      try {
        reportPath = fallbackReportPath(normalReportPath);
        built = buildReport(reportPath, includeDetails, true);
        await commitReport(reportPath, built.report);
        reportWritten = true;
      } catch (fallbackError) {
        const fallbackFailure: RunReportFailure = {
          stage: "report",
          code: "REPORT_FALLBACK_WRITE_FAILED",
          message: `unable to write fallback ${reportPath}: ${errorMessage(fallbackError)}`,
        };
        addFailure(fallbackFailure, true);
        built = buildReport(reportPath, includeDetails, false);
      }
    }

    if (reportWritten) {
      for (const event of built.terminalEvents) {
        telemetry?.bridge.onEvent(event);
      }
    }
    await stopTelemetry(telemetry);
    return {
      exitCode: status === "passed" && reportWritten ? 0 : 1,
      report: built.report,
      reportPath,
      reportWritten,
    };
  };

  if (args.builder) {
    const initialViolations = evaluateScope(initialSnapshot, "pre-builder");
    if (initialViolations.length > 0) {
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        violations: initialViolations,
        failure: {
          stage: "policy",
          code: "PATH_SCOPE_VIOLATION",
          message: "pre-existing changes are outside allowed_paths",
        },
      });
    }

    const builderTimeoutMs = args.builder.timeoutMs ?? DEFAULT_BUILDER_TIMEOUT_MS;
    if (!validTimeoutMs(builderTimeoutMs)) {
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        failure: {
          stage: "builder",
          code: "BUILDER_TIMEOUT_INVALID",
          message: `builder timeout must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
        },
      });
    }

    const unsupportedBuilderActions = (["fs.read", "fs.write"] as const)
      .filter((action) => typeof manifest.permissions[action] === "object");
    if (unsupportedBuilderActions.length > 0) {
      const message =
        "bootstrap requires flat fs.read/fs.write effects; subject rules need a path-scoped tool adapter";
      for (const action of unsupportedBuilderActions) {
        pushPolicy(
          action,
          "deny",
          message,
          manifest.id,
          "bootstrap-agent",
        );
      }
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        failure: {
          stage: "policy",
          code: "BUILDER_SUBJECT_POLICY_UNSUPPORTED",
          message,
        },
      });
    }

    const readDecision = rules.decide("fs.read");
    pushPolicy(
      readDecision.action,
      readDecision.effect,
      readDecision.reason,
      manifest.id,
      readDecision.subject,
    );
    if (readDecision.effect !== "allow") {
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        failure: {
          stage: "policy",
          code: "BUILDER_READ_NOT_ALLOWED",
          message: `builder fs.read decision is ${readDecision.effect}`,
        },
      });
    }

    const writeDecision = rules.decide("fs.write");
    pushPolicy(
      writeDecision.action,
      writeDecision.effect,
      writeDecision.reason,
      manifest.id,
      writeDecision.subject,
    );
    if (writeDecision.effect === "deny" ||
      (writeDecision.effect === "ask" && !args.builder.approveWrite)) {
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        failure: {
          stage: "policy",
          code: writeDecision.effect === "deny"
            ? "BUILDER_WRITE_DENIED"
            : "BUILDER_WRITE_APPROVAL_REQUIRED",
          message: writeDecision.effect === "deny"
            ? "builder fs.write is denied by the manifest"
            : "builder fs.write requires explicit --approve-write",
        },
      });
    }
    if (writeDecision.effect === "ask") {
      const permissionId = `perm-${randomUUID()}`;
      push(createEvent("permission.requested", {
        permissionId,
        sessionId,
        action: "fs.write",
        scope: "run",
        reason: "manifest requires explicit approval for bootstrap edits",
      }, eventOptions()));
      push(createEvent("permission.resolved", {
        permissionId,
        sessionId,
        action: "fs.write",
        scope: "run",
        decision: "allow",
        note: "operator supplied --approve-write",
      }, eventOptions()));
    }

    const builderStarted = Date.now();
    let builderFailure: RunReportFailure | undefined;
    let builderFailureStatus: RunReport["status"] = "failed";
    try {
      const result: TaskAgentResult = await args.builder.agent.run({
        cwd: gitEvidence.repositoryRoot,
        manifestPath: manifestFile,
        manifest: deepFreeze(structuredClone(manifest)),
        branch: gitEvidence.expectedBranch,
        prompt: builderPrompt(manifest, gitEvidence.expectedBranch),
        timeoutMs: builderTimeoutMs,
        budget: manifest.budget,
      });
      modelUsage = result.modelUsage;
      builderEvidence = {
        name: result.name,
        ok: true,
        durationMs: Date.now() - builderStarted,
        exitCode: 0,
        outputTail: boundedTail(result.finalText ?? ""),
      };
    } catch (error) {
      const code = error instanceof PiAgentError ? error.code : "BUILDER_FAILED";
      const message = errorMessage(error);
      if (error instanceof PiAgentError && error.budget) {
        push(createEvent("budget.warning", {
          taskId: manifest.id,
          metric: error.budget.metric,
          used: error.budget.used,
          limit: error.budget.limit,
          pct: error.budget.limit === 0
            ? 100
            : (error.budget.used / error.budget.limit) * 100,
        }, eventOptions()));
      }
      if (
        code === "PI_BUDGET_EXCEEDED" ||
        code === "PI_BUDGET_USAGE_UNAVAILABLE"
      ) {
        builderFailureStatus = "blocked";
      }
      builderEvidence = {
        name: args.builder.name ?? "task-agent",
        ok: false,
        durationMs: Date.now() - builderStarted,
        outputTail: boundedTail(message),
      };
      builderFailure = { stage: "builder", code, message };
      pushError(builderFailure, manifest.id);
    }

    if (!builderFailure && modelUsage && !validModelUsage(modelUsage)) {
      modelUsage = undefined;
      builderEvidence = builderEvidence
        ? { ...builderEvidence, ok: false }
        : builderEvidence;
      builderFailure = {
        stage: "builder",
        code: "BUILDER_USAGE_INVALID",
        message: "the builder returned invalid model/tool usage counters",
      };
      builderFailureStatus = "blocked";
      pushError(builderFailure, manifest.id);
    }

    if (!builderFailure && manifest.budget) {
      if (!modelUsage) {
        builderFailure = {
          stage: "builder",
          code: "BUILDER_USAGE_UNAVAILABLE",
          message: "the budgeted builder did not report model/tool usage",
        };
        builderFailureStatus = "blocked";
        pushError(builderFailure, manifest.id);
      } else {
        const checks = [
          manifest.budget.max_model_tokens === undefined
            ? undefined
            : {
                metric: "tokens" as const,
                used: modelUsage.totalModelTokens,
                limit: manifest.budget.max_model_tokens,
              },
          manifest.budget.max_tool_calls === undefined
            ? undefined
            : {
                metric: "tool_calls" as const,
                used: modelUsage.totalToolCalls,
                limit: manifest.budget.max_tool_calls,
              },
        ].filter((check) => check !== undefined);
        const exceeded: string[] = [];
        for (const check of checks) {
          const pct = check.limit === 0 ? 100 : (check.used / check.limit) * 100;
          if (pct >= 80) {
            push(createEvent("budget.warning", {
              taskId: manifest.id,
              metric: check.metric,
              used: check.used,
              limit: check.limit,
              pct,
            }, eventOptions()));
          }
          if (check.used > check.limit) {
            exceeded.push(`${check.metric} ${check.used}/${check.limit}`);
          }
        }
        if (exceeded.length > 0) {
          builderFailure = {
            stage: "builder",
            code: "BUILDER_BUDGET_EXCEEDED",
            message: `builder exceeded task budget: ${exceeded.join(", ")}`,
          };
          builderFailureStatus = "blocked";
          pushError(builderFailure, manifest.id);
        }
      }
    }

    try {
      initialSnapshot = collectGitChangeSnapshot(cwd, gitEvidence);
    } catch (error) {
      const code = error instanceof GitPreflightError
        ? error.code
        : "GIT_DIFF_FAILED";
      const message = errorMessage(error);
      const action = gitFailurePolicyAction(code);
      pushPolicy(
        action,
        "deny",
        message,
        manifest.id,
        action === "git.branch" ? expectedBranch : "post-builder",
      );
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        failure: { stage: "git", code, message },
      });
    }
    const manifestFailure = manifestIntegrityFailure();
    if (manifestFailure) {
      const violations = evaluateScope(initialSnapshot, "post-builder");
      pushPolicy(
        "workspace.path_scope",
        "deny",
        manifestFailure.message,
        manifest.id,
        "post-builder-manifest",
      );
      return finishRun({
        status: "blocked",
        preTest: initialSnapshot,
        violations,
        failure: manifestFailure,
      });
    }
    if (builderFailure) {
      const violations = evaluateScope(initialSnapshot, "post-builder-failure");
      if (violations.length > 0) {
        return finishRun({
          status: "blocked",
          preTest: initialSnapshot,
          violations,
          failure: {
            stage: "policy",
            code: "PATH_SCOPE_VIOLATION",
            message: "the failed builder left changes outside allowed_paths",
          },
        });
      }
      return finishRun({
        status: builderFailureStatus,
        preTest: initialSnapshot,
        failure: builderFailure,
        failureEmitted: true,
      });
    }
    push(createEvent("task.updated", {
      taskId: manifest.id,
      phase: "verifying",
      note: builderEvidence.name,
    }, eventOptions()));
  }

  const preTestViolations = evaluateScope(initialSnapshot, "pre-tests");
  if (preTestViolations.length > 0) {
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      violations: preTestViolations,
      failure: {
        stage: "policy",
        code: "PATH_SCOPE_VIOLATION",
        message: "changes are outside allowed_paths before tests",
      },
    });
  }

  const testTimeoutMs = args.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  if (!validTimeoutMs(testTimeoutMs)) {
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      failure: {
        stage: "tests",
        code: "TEST_TIMEOUT_INVALID",
        message: `test timeout must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
      },
    });
  }

  const command = args.testCommand ?? DEFAULT_TEST_COMMAND;
  const execDecision = rules.decide("process.exec", command);
  pushPolicy(
    execDecision.action,
    execDecision.effect,
    execDecision.reason,
    manifest.id,
    command,
  );
  if (execDecision.effect !== "allow") {
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      failure: {
        stage: "policy",
        code: execDecision.effect === "deny"
          ? "PROCESS_EXEC_DENIED"
          : "PROCESS_EXEC_APPROVAL_REQUIRED",
        message: `test command decision is ${execDecision.effect}`,
      },
    });
  }

  let commandSpec: CommandSpec;
  try {
    commandSpec = parseCommand(command);
  } catch (error) {
    const message = errorMessage(error);
    pushPolicy("process.exec", "deny", message, manifest.id, command);
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      failure: {
        stage: "policy",
        code: "TEST_COMMAND_INVALID",
        message,
      },
    });
  }

  const testStarted = Date.now();
  const proc = await runTestProcess(
    commandSpec.executable,
    commandSpec.args,
    gitEvidence.repositoryRoot,
    testTimeoutMs,
  );
  const processGroupError = proc.cleanupError;
  const combinedOutput = `${proc.stdout}\n${proc.stderr}`;
  const testExitCode = proc.status ?? 1;
  const tests: NonNullable<RunReport["tests"]> = {
    command,
    exitCode: testExitCode,
    ok: testExitCode === 0 && proc.error === undefined && !proc.timedOut,
    durationMs: Date.now() - testStarted,
    ...parseTestSummary(combinedOutput),
    outputTail: boundedTail(combinedOutput),
  };
  const testFailure: RunReportFailure | undefined = tests.ok
    ? undefined
    : proc.timedOut
      ? {
          stage: "tests",
          code: "TEST_COMMAND_TIMED_OUT",
          message: `test command exceeded ${testTimeoutMs} ms`,
        }
      : proc.error
        ? {
            stage: "tests",
            code: "TEST_COMMAND_SPAWN_FAILED",
            message: `test command could not start: ${errorMessage(proc.error)}`,
          }
        : {
            stage: "tests",
            code: "TEST_COMMAND_FAILED",
            message: `test command exited with status ${testExitCode}`,
          };
  if (testFailure) pushError(testFailure, manifest.id);

  let postTestSnapshot: GitChangeSnapshot;
  try {
    postTestSnapshot = collectGitChangeSnapshot(cwd, gitEvidence);
  } catch (error) {
    const code = error instanceof GitPreflightError
      ? error.code
      : "GIT_DIFF_FAILED";
    const message = errorMessage(error);
    const action = gitFailurePolicyAction(code);
    pushPolicy(
      action,
      "deny",
      message,
      manifest.id,
      action === "git.branch" ? expectedBranch : "post-tests",
    );
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      tests,
      failure: { stage: "git", code, message },
    });
  }

  const postTestViolations = evaluateScope(postTestSnapshot, "post-tests");
  const postTestManifestFailure = manifestIntegrityFailure();
  if (postTestManifestFailure) {
    pushPolicy(
      "workspace.path_scope",
      "deny",
      postTestManifestFailure.message,
      manifest.id,
      "post-test-manifest",
    );
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      postTest: postTestSnapshot,
      tests,
      violations: postTestViolations,
      failure: postTestManifestFailure,
    });
  }
  if (postTestViolations.length > 0) {
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      postTest: postTestSnapshot,
      tests,
      violations: postTestViolations,
      failure: {
        stage: "policy",
        code: "POST_TEST_PATH_SCOPE_VIOLATION",
        message: "tests left changes outside allowed_paths",
      },
    });
  }

  if (processGroupError) {
    return finishRun({
      status: "blocked",
      preTest: initialSnapshot,
      postTest: postTestSnapshot,
      tests,
      failure: {
        stage: "tests",
        code: "TEST_PROCESS_GROUP_CLEANUP_FAILED",
        message: `could not terminate the test process group: ${errorMessage(processGroupError)}`,
      },
    });
  }

  if (!tests.ok) {
    return finishRun({
      status: "failed",
      preTest: initialSnapshot,
      postTest: postTestSnapshot,
      tests,
      failure: testFailure,
      failureEmitted: true,
    });
  }

  return finishRun({
    status: "passed",
    preTest: initialSnapshot,
    postTest: postTestSnapshot,
    tests,
  });
}

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createEvent } from "@harness/events";

import {
  NodeCommandExecutor,
  restrictedDockerClientEnv,
} from "./executor";
import {
  SandboxCleanupError,
  SandboxDuplicateRunError,
  SandboxExecutorError,
  SandboxRunnerError,
  SandboxSpecError,
} from "./errors";
import { revalidateSandboxPlan } from "./mounts";
import {
  createSandboxPlan,
  validateSandboxRunId,
} from "./plan";
import type {
  CommandExecutor,
  ExecuteOptions,
  ExecuteResult,
  RunSandboxOptions,
  SandboxCleanupResult,
  SandboxLifecycleUpdate,
  SandboxPlan,
  SandboxRunResult,
  SandboxRunSpec,
} from "./types";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_483_647;
const CLEANUP_OUTPUT_BYTES = 16 * 1024;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const MISSING_CONTAINER = /(?:no such container|no such object)/iu;
const activeRunIds = new Set<string>();

function validateOptions(options: RunSandboxOptions): void {
  if (options === null || typeof options !== "object") {
    throw new SandboxSpecError("sandbox runner options must be an object");
  }
  for (const [name, value, maximum] of [
    ["timeoutMs", options.timeoutMs, MAX_TIMER_MS],
    ["cleanupTimeoutMs", options.cleanupTimeoutMs, MAX_TIMER_MS],
    ["maxOutputBytes", options.maxOutputBytes, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    ) {
      throw new SandboxSpecError(
        `${name} must be a positive integer no greater than ${maximum}`,
      );
    }
  }
  if (
    options.dockerBinary !== undefined &&
    (
      typeof options.dockerBinary !== "string" ||
      options.dockerBinary.length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(options.dockerBinary)
    )
  ) {
    throw new SandboxSpecError(
      "dockerBinary must be a non-empty path without control characters",
    );
  }
}

async function bestEffortLifecycle(
  options: RunSandboxOptions,
  update: SandboxLifecycleUpdate,
): Promise<void> {
  try {
    await options.onLifecycle?.(update);
  } catch {
    // Observer transport cannot alter process or cleanup state.
  }
}

async function bestEffortEvent(
  options: RunSandboxOptions,
  event: Parameters<NonNullable<RunSandboxOptions["onEvent"]>>[0],
): Promise<void> {
  try {
    await options.onEvent?.(event);
  } catch {
    // Event transport cannot replace the execution or cleanup outcome.
  }
}

function noContainerResult(exitCode = 0): SandboxCleanupResult {
  return {
    status: "already_absent",
    exitCode,
    timedOut: false,
    outputTruncated: false,
  };
}

function missingContainer(result: ExecuteResult): boolean {
  return (
    !result.timedOut &&
    !result.aborted &&
    result.exitCode !== 0 &&
    MISSING_CONTAINER.test(result.stderr)
  );
}

function hasOwnedContainerId(containerIdFile: string): boolean {
  try {
    return CONTAINER_ID.test(readFileSync(containerIdFile, "utf8").trim());
  } catch {
    return false;
  }
}

function cleanupFailureDetails(
  stage: string,
  result: ExecuteResult,
): Record<string, unknown> {
  return {
    stage,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    outputTruncated: result.outputTruncated,
    stderr: result.stderr.slice(0, 2_048),
  };
}

async function executeCleanupCommand(
  executor: CommandExecutor,
  executable: string,
  args: readonly string[],
  options: ExecuteOptions,
  runId: string,
  containerName: string,
  stage: string,
  executionError?: unknown,
): Promise<ExecuteResult> {
  try {
    return await executor.execute(executable, args, options);
  } catch (cause) {
    throw new SandboxCleanupError(
      runId,
      containerName,
      { stage, cause },
      executionError ?? cause,
    );
  }
}

async function cleanupContainer(
  plan: SandboxPlan,
  leaseId: string,
  containerIdFile: string,
  executor: CommandExecutor,
  dockerBinary: string,
  options: ExecuteOptions,
  executionError?: unknown,
): Promise<SandboxCleanupResult> {
  let containerId: string | undefined;
  let invalidContainerId: string | undefined;
  try {
    const candidate = readFileSync(containerIdFile, "utf8").trim();
    if (CONTAINER_ID.test(candidate)) containerId = candidate;
    else invalidContainerId = candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SandboxCleanupError(
        plan.runId,
        plan.containerName,
        { stage: "read-cidfile", error },
        executionError ?? error,
      );
    }
  }

  let target = containerId;
  if (target === undefined) {
    const inspect = await executeCleanupCommand(
      executor,
      dockerBinary,
      [
        "inspect",
        "--format",
        '{{ .Id }}\t{{ index .Config.Labels "harness.lease-id" }}',
        plan.containerName,
      ],
      options,
      plan.runId,
      plan.containerName,
      "inspect-owner",
      executionError,
    );
    if (missingContainer(inspect)) return noContainerResult(inspect.exitCode);
    const inspected = inspect.stdout.trim().split("\t");
    const inspectedId = inspected[0];
    const inspectedLease = inspected[1];
    if (
      inspect.exitCode !== 0 ||
      inspect.timedOut ||
      inspect.aborted ||
      inspected.length !== 2 ||
      inspectedId === undefined ||
      !CONTAINER_ID.test(inspectedId) ||
      inspectedLease !== leaseId
    ) {
      throw new SandboxCleanupError(
        plan.runId,
        plan.containerName,
        {
          ...cleanupFailureDetails("inspect-owner", inspect),
          invalidContainerId,
          ownershipMatched: inspectedLease === leaseId,
        },
        executionError,
      );
    }
    target = inspectedId;
  }

  const removed = await executeCleanupCommand(
    executor,
    dockerBinary,
    ["rm", "--force", "--volumes", target],
    options,
    plan.runId,
    plan.containerName,
    "remove",
    executionError,
  );
  if (removed.exitCode === 0 && !removed.timedOut && !removed.aborted) {
    return {
      status: "removed",
      exitCode: removed.exitCode,
      timedOut: false,
      outputTruncated: removed.outputTruncated,
    };
  }
  if (missingContainer(removed)) {
    return {
      status: "already_absent",
      exitCode: removed.exitCode,
      timedOut: false,
      outputTruncated: removed.outputTruncated,
    };
  }
  throw new SandboxCleanupError(
    plan.runId,
    plan.containerName,
    cleanupFailureDetails("remove", removed),
    executionError,
  );
}

function errorCode(error: unknown): string {
  return error instanceof SandboxRunnerError
    ? error.code
    : "SANDBOX_EXECUTOR_FAILED";
}

/**
 * Execute one Docker container for one task run. The process-local runId lease
 * is acquired before the first await; Docker's deterministic name is the
 * daemon-level uniqueness backstop.
 */
export async function runSandbox(
  spec: SandboxRunSpec,
  options: RunSandboxOptions = {},
): Promise<SandboxRunResult> {
  validateOptions(options);
  validateSandboxRunId(spec?.runId);
  if (activeRunIds.has(spec.runId)) {
    throw new SandboxDuplicateRunError(spec.runId);
  }
  activeRunIds.add(spec.runId);

  let dockerConfigDir: string | undefined;
  const leaseId = randomUUID();
  let plan: SandboxPlan | undefined;
  let mainResult: ExecuteResult | undefined;
  let mainError: unknown;
  let cleanupResult: SandboxCleanupResult | undefined;
  let spawned = false;
  let sandboxStartEventSent = false;
  let startAudit: Promise<void> | undefined;

  try {
    dockerConfigDir = mkdtempSync(join(tmpdir(), "harness-docker-client-"));
    chmodSync(dockerConfigDir, 0o700);
    const containerIdFile = join(dockerConfigDir, "container.cid");
    const environment = restrictedDockerClientEnv(process.env, {
      dockerConfigDir,
      dockerHost: options.dockerHost,
    });
    const executor = options.executor ?? new NodeCommandExecutor();
    const dockerBinary = options.dockerBinary ?? "docker";

    plan = await createSandboxPlan(spec, options);
    // These runner-owned arguments make cleanup ownership provable without
    // letting callers direct Docker to write arbitrary host paths.
    plan.dockerArgs.splice(
      1,
      0,
      "--cidfile",
      containerIdFile,
      "--label",
      `harness.lease-id=${leaseId}`,
    );
    const base = { runId: plan.runId, containerName: plan.containerName };
    const startedAt = performance.now();
    await bestEffortLifecycle(options, { ...base, phase: "planned" });
    await bestEffortLifecycle(options, { ...base, phase: "starting" });

    const executionOptions: ExecuteOptions = {
      cwd: plan.workspaceRoot,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      environment,
      signal: options.signal,
      onSpawn: () => {
        if (spawned) return;
        spawned = true;
        startAudit = bestEffortLifecycle(options, {
          ...base,
          phase: "client_started",
        });
      },
    };

    try {
      // No await or user callback may occur between this check and execute().
      revalidateSandboxPlan(spec, plan);
      const pendingExecution = executor.execute(
        dockerBinary,
        plan.dockerArgs,
        executionOptions,
      );
      mainResult = await pendingExecution;
      await startAudit;
      // A spawned Docker CLI is not proof that a container started. Only emit
      // the canonical event once docker run completed, wrote our CID, and did
      // not report Docker's reserved infrastructure-failure status (125).
      if (
        !mainResult.aborted &&
        !mainResult.timedOut &&
        mainResult.exitCode !== 125 &&
        hasOwnedContainerId(containerIdFile)
      ) {
        await bestEffortEvent(options, createEvent("sandbox.started", {
          runId: plan.runId,
          containerName: plan.containerName,
          image: plan.image,
          network: plan.networkMode === "none" ? "none" : "enabled",
          mounts: plan.writableMounts.length,
        }, { actor: "sandbox-runner" }));
        sandboxStartEventSent = true;
      }
      if (mainResult.aborted || mainResult.timedOut) {
        await bestEffortLifecycle(options, {
          ...base,
          phase: "canceled",
          exitCode: mainResult.exitCode,
        });
      } else {
        await bestEffortLifecycle(options, {
          ...base,
          phase: "exited",
          exitCode: mainResult.exitCode,
        });
      }
    } catch (error) {
      mainError = error;
      await startAudit;
      await bestEffortLifecycle(options, {
        ...base,
        phase: "failed",
        error,
      });
    }

    await bestEffortLifecycle(options, { ...base, phase: "cleaning" });
    const cleanupOptions: ExecuteOptions = {
      cwd: plan.workspaceRoot,
      timeoutMs: options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      maxOutputBytes: CLEANUP_OUTPUT_BYTES,
      environment,
    };
    try {
      cleanupResult = spawned
        ? await cleanupContainer(
            plan,
            leaseId,
            containerIdFile,
            executor,
            dockerBinary,
            cleanupOptions,
            mainError,
          )
        : noContainerResult();
      await bestEffortLifecycle(options, {
        ...base,
        phase: "cleaned",
        error: mainError,
        cleanup: cleanupResult,
      });
    } catch (error) {
      const cleanupError = error instanceof SandboxCleanupError
        ? error
        : new SandboxCleanupError(
            plan.runId,
            plan.containerName,
            { stage: "unknown", error },
            mainError ?? error,
          );
      await bestEffortLifecycle(options, {
        ...base,
        phase: "cleanup_failed",
        error: cleanupError,
      });
      await bestEffortEvent(options, createEvent("error", {
        code: cleanupError.code,
        message: "sandbox container cleanup could not be verified",
        retryable: true,
      }, { actor: "sandbox-runner" }));
      throw cleanupError;
    }

    if (sandboxStartEventSent) {
      const canceled = mainResult?.aborted === true || mainResult?.timedOut === true;
      const status = canceled
        ? "canceled"
        : mainError !== undefined || mainResult?.exitCode !== 0
          ? "failed"
          : "completed";
      await bestEffortEvent(options, createEvent("sandbox.stopped", {
        runId: plan.runId,
        containerName: plan.containerName,
        status,
        exitCode: mainResult?.exitCode,
        durationMs: performance.now() - startedAt,
      }, { actor: "sandbox-runner" }));
    }

    if (mainError !== undefined) {
      await bestEffortEvent(options, createEvent("error", {
        code: errorCode(mainError),
        message: "sandbox execution failed",
        retryable: true,
      }, { actor: "sandbox-runner" }));
      throw mainError;
    }
    if (mainResult === undefined || cleanupResult === undefined) {
      throw new SandboxExecutorError("sandbox executor returned no result");
    }
    return {
      plan,
      ...mainResult,
      cleanup: cleanupResult,
      ok: mainResult.exitCode === 0 && !mainResult.timedOut && !mainResult.aborted,
    };
  } finally {
    try {
      if (dockerConfigDir !== undefined) {
        rmSync(dockerConfigDir, { recursive: true, force: true });
      }
    } catch {
      // The directory contains only runner-created Docker client state. A
      // temp cleanup error must not replace the container cleanup outcome.
    }
    activeRunIds.delete(spec.runId);
  }
}

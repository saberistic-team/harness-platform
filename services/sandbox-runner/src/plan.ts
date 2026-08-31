import { createHash } from "node:crypto";

import {
  compileRules,
  type Decision,
  type Effect,
} from "@harness/policy";

import {
  SandboxAbortedError,
  SandboxPermissionRequiredError,
  SandboxPermissionResolutionError,
  SandboxPolicyDeniedError,
  SandboxSpecError,
  SandboxUnrepresentablePolicyError,
  SandboxUntrustedImageError,
} from "./errors";
import {
  canonicalWorkspaceRoot,
  CONTAINER_WORKSPACE,
  planWritableMounts,
  revalidateSandboxPlan,
  workspaceFingerprint,
  workspaceOwner,
} from "./mounts";
import {
  asPermissionMap,
  type EnforcedDecision,
  type SandboxPlan,
  type SandboxPlannerOptions,
  type SandboxRunSpec,
  type WritableMount,
} from "./types";

const PIDS_LIMIT = "128";
const MEMORY_LIMIT = "512m";
const CPU_LIMIT = "1.0";
const TMPFS = "/tmp:rw,noexec,nosuid,nodev,size=67108864";
const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/iu;

const EMPTY_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "all_proxy",
  "no_proxy",
] as const;

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

export function validateSandboxRunId(runId: unknown): asserts runId is string {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.length > 200 ||
    containsControl(runId)
  ) {
    throw new SandboxSpecError("runId must be 1-200 characters without control characters");
  }
}

/** Validate the image trust decision without requiring a workspace plan. */
export function validateSandboxImage(
  image: unknown,
  trustedLocalImage?: true,
): asserts image is string {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u.test(image)
  ) {
    throw new SandboxSpecError(
      `invalid or unsafe Docker image reference: ${JSON.stringify(image)}`,
    );
  }
  if (trustedLocalImage !== undefined && trustedLocalImage !== true) {
    throw new SandboxSpecError("trustedLocalImage must be true when provided");
  }
  if (!IMMUTABLE_IMAGE.test(image) && trustedLocalImage !== true) {
    throw new SandboxUntrustedImageError(image);
  }
}

export function validateSandboxSpec(spec: SandboxRunSpec): void {
  if (spec === null || typeof spec !== "object") {
    throw new SandboxSpecError("sandbox run spec must be an object");
  }
  validateSandboxRunId(spec.runId);
  validateSandboxImage(spec.image, spec.trustedLocalImage);
  if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
    throw new SandboxSpecError("argv must contain an executable");
  }
  const executable = spec.argv[0];
  if (typeof executable !== "string" || executable.length === 0) {
    throw new SandboxSpecError("argv[0] must be a non-empty executable");
  }
  for (const token of spec.argv) {
    if (typeof token !== "string" || token.includes("\u0000")) {
      throw new SandboxSpecError("argv entries must be strings without NUL bytes");
    }
  }
  if (spec.manifest === null || typeof spec.manifest !== "object") {
    throw new SandboxSpecError("manifest must be an object");
  }
  if (!Array.isArray(spec.manifest.allowed_paths) || spec.manifest.allowed_paths.length === 0) {
    throw new SandboxSpecError("manifest.allowed_paths must contain at least one path");
  }
  if (spec.manifest.allowed_paths.some((path) => typeof path !== "string")) {
    throw new SandboxSpecError("manifest.allowed_paths entries must be strings");
  }
  const permissions = spec.manifest.permissions;
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new SandboxSpecError("manifest.permissions must be an action rule map");
  }
  for (const [action, rule] of Object.entries(permissions)) {
    if (action.length === 0) {
      throw new SandboxSpecError("manifest permission actions must be non-empty strings");
    }
    if (rule === "allow" || rule === "ask" || rule === "deny") continue;
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      throw new SandboxSpecError(`invalid permission rule for ${JSON.stringify(action)}`);
    }
    for (const [pattern, effect] of Object.entries(rule)) {
      if (
        pattern.length === 0 ||
        (effect !== "allow" && effect !== "ask" && effect !== "deny")
      ) {
        throw new SandboxSpecError(
          `invalid permission subject rule for ${JSON.stringify(action)}`,
        );
      }
    }
  }
}

function quoteSubjectToken(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/** Stable policy subject derived from argv; callers cannot provide a weaker alias. */
export function argvToPolicySubject(argv: readonly string[]): string {
  return argv.map(quoteSubjectToken).join(" ");
}

function defaultContainerName(runId: string): string {
  const slug = runId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 20) || "run";
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 32);
  return `harness-${slug}-${digest}`.slice(0, 63);
}

function validateContainerName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(name)) {
    throw new SandboxSpecError(`invalid Docker container name: ${JSON.stringify(name)}`);
  }
  return name;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SandboxAbortedError();
}

async function awaitWithAbort<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) return value;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new SandboxAbortedError());
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function enforce(
  decision: Decision,
  options: SandboxPlannerOptions,
): Promise<EnforcedDecision> {
  throwIfAborted(options.signal);
  let effectiveEffect: Exclude<Effect, "ask">;
  let resolvedByOperator = false;
  if (decision.effect === "ask") {
    if (options.permissionResolver === undefined) {
      throw new SandboxPermissionRequiredError(decision);
    }
    const resolution = await awaitWithAbort(
      options.permissionResolver(decision),
      options.signal,
    );
    if (resolution !== "allow" && resolution !== "deny") {
      throw new SandboxPermissionResolutionError(decision, resolution);
    }
    effectiveEffect = resolution;
    resolvedByOperator = true;
  } else {
    effectiveEffect = decision.effect;
  }
  const outcome = { decision, effectiveEffect, resolvedByOperator };
  await awaitWithAbort(options.onDecision?.(outcome), options.signal);
  return outcome;
}

function bindMount(
  source: string,
  target: string,
  mode: "readonly-recursive" | "writable-no-submounts",
): string {
  return [
    "type=bind",
    `source=${source}`,
    `target=${target}`,
    mode === "readonly-recursive" ? "readonly" : undefined,
    mode === "readonly-recursive"
      ? "bind-recursive=readonly"
      : "bind-recursive=disabled",
    "bind-propagation=rprivate",
  ].filter((part): part is string => part !== undefined).join(",");
}

function buildDockerArgs(
  spec: SandboxRunSpec,
  plan: {
    containerName: string;
    workspaceRoot: string;
    workspaceMounted: boolean;
    networkMode: "none" | "bridge";
    writableMounts: readonly WritableMount[];
    dockerUser: string;
  },
): string[] {
  const mounts = plan.workspaceMounted
    ? [
        "--mount",
        bindMount(plan.workspaceRoot, CONTAINER_WORKSPACE, "readonly-recursive"),
        ...plan.writableMounts.flatMap((mount) => [
          "--mount",
          bindMount(mount.hostPath, mount.containerPath, "writable-no-submounts"),
        ]),
      ]
    : [];
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    plan.containerName,
    "--label",
    `harness.run-id=${spec.runId}`,
    "--init",
    "--no-healthcheck",
    "--read-only",
    "--network",
    plan.networkMode,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--user",
    plan.dockerUser,
    "--pids-limit",
    PIDS_LIMIT,
    "--memory",
    MEMORY_LIMIT,
    "--cpus",
    CPU_LIMIT,
    "--tmpfs",
    TMPFS,
    "--workdir",
    plan.workspaceMounted ? CONTAINER_WORKSPACE : "/tmp",
    ...EMPTY_PROXY_VARIABLES.flatMap((name) => ["--env", `${name}=`]),
    ...mounts,
    "--entrypoint",
    spec.argv[0]!,
    spec.image,
    ...spec.argv.slice(1),
  ];
}

/**
 * Compile and enforce the manifest before producing any Docker arguments.
 * This function performs no process execution; callers can inspect/audit the
 * complete plan before passing it to the executor.
 */
export async function createSandboxPlan(
  spec: SandboxRunSpec,
  options: SandboxPlannerOptions = {},
): Promise<SandboxPlan> {
  validateSandboxSpec(spec);
  throwIfAborted(options.signal);
  const workspaceRoot = canonicalWorkspaceRoot(spec.workspaceRoot);
  const owner = workspaceOwner(workspaceRoot);
  const allowedPathMounts = planWritableMounts(
    workspaceRoot,
    spec.manifest.allowed_paths,
  );
  const rules = compileRules(asPermissionMap(spec.manifest));
  const permissions = asPermissionMap(spec.manifest);
  const commandSubject = argvToPolicySubject(spec.argv);

  const processExec = await enforce(
    rules.decide("process.exec", commandSubject),
    options,
  );
  if (processExec.effectiveEffect === "deny") {
    throw new SandboxPolicyDeniedError(processExec.decision);
  }

  const fsReadRule = permissions["fs.read"];
  if (typeof fsReadRule === "object" && fsReadRule !== null) {
    throw new SandboxUnrepresentablePolicyError(
      "fs.read",
      fsReadRule,
      "a subject-pattern rule cannot be represented by one workspace bind",
    );
  }
  const fsRead = await enforce(rules.decide("fs.read"), options);
  const workspaceMounted = fsRead.effectiveEffect === "allow";

  const writableMounts: WritableMount[] = [];
  const fsWrites: EnforcedDecision[] = [];
  const fsWriteRule = permissions["fs.write"];
  for (const mount of allowedPathMounts) {
    const outcome = await enforce(
      rules.decide("fs.write", mount.relativePath),
      options,
    );
    fsWrites.push(outcome);
    if (outcome.effectiveEffect === "allow") {
      if (!workspaceMounted) {
        throw new SandboxUnrepresentablePolicyError(
          "fs.write",
          fsWriteRule,
          `writable mount ${JSON.stringify(mount.relativePath)} would necessarily grant read access denied by fs.read`,
        );
      }
      if (mount.kind === "directory" && typeof fsWriteRule === "object") {
        throw new SandboxUnrepresentablePolicyError(
          "fs.write",
          fsWriteRule,
          `a subject-pattern rule cannot constrain descendants of writable directory ${JSON.stringify(mount.relativePath)}`,
        );
      }
      writableMounts.push(mount);
    }
  }

  // Docker's bridge/none switch cannot express a host allow-list. Reject an
  // object rule rather than silently widening it to unrestricted bridge access.
  const networkRule = permissions.network;
  if (typeof networkRule === "object" && networkRule !== null) {
    throw new SandboxUnrepresentablePolicyError(
      "network",
      networkRule,
      "Docker provides only unrestricted bridge or isolated none networking",
    );
  }
  const network = await enforce(rules.decide("network"), options);
  const networkMode = network.effectiveEffect === "allow" ? "bridge" : "none";

  const containerName = validateContainerName(defaultContainerName(spec.runId));
  const plan: SandboxPlan = {
    runId: spec.runId,
    containerName,
    image: spec.image,
    argv: [...spec.argv],
    commandSubject,
    workspaceRoot,
    workspaceFingerprint: workspaceFingerprint(workspaceRoot),
    containerWorkspace: CONTAINER_WORKSPACE,
    workspaceMounted,
    networkMode,
    allowedPathMounts,
    writableMounts,
    policy: { processExec, fsRead, fsWrites, network },
    dockerArgs: [],
  };
  plan.dockerArgs = buildDockerArgs(spec, {
    containerName,
    workspaceRoot,
    workspaceMounted,
    networkMode,
    writableMounts,
    dockerUser: owner.dockerUser,
  });

  // Permission resolution can be interactive. Revalidate after every await so
  // callers inspecting a completed plan never receive a stale mount snapshot.
  throwIfAborted(options.signal);
  revalidateSandboxPlan(spec, plan);
  return plan;
}

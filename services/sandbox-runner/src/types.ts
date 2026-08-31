import type { Decision, Effect, PermissionMap } from "@harness/policy";
import type { TaskManifest } from "@harness/sdk";
import type { AnyHarnessEvent } from "@harness/events";

export type SandboxManifest = Pick<
  TaskManifest,
  "allowed_paths" | "permissions"
>;

export interface SandboxRunSpec {
  /** Stable audit identity. It is never interpreted as a shell fragment. */
  runId: string;
  /** Host workspace to expose at /workspace. */
  workspaceRoot: string;
  manifest: SandboxManifest;
  /**
   * Image reference. A sha256 digest is required unless the caller explicitly
   * attests that an unpinned tag is a trusted local development image.
   */
  image: string;
  trustedLocalImage?: true;
  /** Executable followed by arguments. Empty argv is invalid. */
  argv: readonly string[];
}

export type PermissionResolution = Exclude<Effect, "ask">;

export type PermissionResolver = (
  decision: Decision,
) => PermissionResolution | Promise<PermissionResolution>;

export interface EnforcedDecision {
  decision: Decision;
  effectiveEffect: PermissionResolution;
  resolvedByOperator: boolean;
}

export type DecisionObserver = (
  outcome: EnforcedDecision,
) => void | Promise<void>;

export interface WritableMount {
  /** Original manifest pattern authorizing this mount. */
  pattern: string;
  /** Normalized workspace-relative source. */
  relativePath: string;
  hostPath: string;
  containerPath: string;
  kind: "file" | "directory";
  /** Digest of path identity and descendant metadata at planning time. */
  fingerprint: string;
}

export interface SandboxPolicyPlan {
  processExec: EnforcedDecision;
  fsRead: EnforcedDecision;
  fsWrites: EnforcedDecision[];
  network: EnforcedDecision;
}

export interface SandboxPlan {
  runId: string;
  containerName: string;
  image: string;
  argv: readonly string[];
  commandSubject: string;
  workspaceRoot: string;
  workspaceFingerprint: string;
  containerWorkspace: "/workspace";
  workspaceMounted: boolean;
  networkMode: "none" | "bridge";
  /** All normalized allowed_paths snapshots, including read-only outcomes. */
  allowedPathMounts: WritableMount[];
  writableMounts: WritableMount[];
  policy: SandboxPolicyPlan;
  /** Complete arguments following the Docker binary. */
  dockerArgs: string[];
}

export interface SandboxPlannerOptions {
  permissionResolver?: PermissionResolver;
  onDecision?: DecisionObserver;
  signal?: AbortSignal;
}

export interface ExecuteOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Complete, isolated environment for the child process. */
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Called only after the operating system reports that the child spawned. */
  onSpawn?: () => void;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
}

/** Injected process boundary. Implementations must never use a shell. */
export interface CommandExecutor {
  execute(
    executable: string,
    args: readonly string[],
    options: ExecuteOptions,
  ): Promise<ExecuteResult>;
}

export type SandboxLifecyclePhase =
  | "planned"
  | "starting"
  | "client_started"
  | "exited"
  | "canceled"
  | "failed"
  | "cleaning"
  | "cleaned"
  | "cleanup_failed";

export interface SandboxLifecycleUpdate {
  phase: SandboxLifecyclePhase;
  runId: string;
  containerName: string;
  exitCode?: number;
  error?: unknown;
  cleanup?: SandboxCleanupResult;
}

export type LifecycleObserver = (
  update: SandboxLifecycleUpdate,
) => void | Promise<void>;

export interface RunSandboxOptions extends SandboxPlannerOptions {
  executor?: CommandExecutor;
  dockerBinary?: string;
  /** Explicit local daemon socket. Remote TCP/SSH/npipe contexts are rejected. */
  dockerHost?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxOutputBytes?: number;
  onLifecycle?: LifecycleObserver;
  /** Typed audit events emitted at the container execution boundary. */
  onEvent?: (event: AnyHarnessEvent) => void | Promise<void>;
}

export type SandboxCleanupStatus = "removed" | "already_absent";

export interface SandboxCleanupResult {
  status: SandboxCleanupStatus;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface SandboxRunResult {
  plan: SandboxPlan;
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
  cleanup: SandboxCleanupResult;
  ok: boolean;
}

/** Structural assertion used where the SDK's inferred map crosses packages. */
export function asPermissionMap(manifest: SandboxManifest): PermissionMap {
  return manifest.permissions as PermissionMap;
}

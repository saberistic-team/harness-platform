/**
 * @harness/sandbox-runner — executes tool calls inside a container.
 *
 * M0: placeholder service. Responsibilities (M3):
 *   - one Docker container per task run (gVisor or rootless when
 *     available) with the workspace volume mounted read-write ONLY
 *     inside tasks/* allowed prefixes
 *   - enforces manifest permissions at the syscall boundary:
 *     network namespace, egress policy, fs mounts
 *   - streams tool events in/out as harness events
 *   - artifacts leave the container via the artifact store (S3/MinIO)
 *
 * The policy engine (packages/policy) remains the only place rules are
 * evaluated; the runner only says "yes/no" to the engine's decisions.
 */

export interface SandboxRunnerStatus {
  service: "sandbox-runner";
  version: "0.0.0";
  ready: false as const;
}

export function status(): SandboxRunnerStatus {
  return { service: "sandbox-runner", version: "0.0.0", ready: false };
}

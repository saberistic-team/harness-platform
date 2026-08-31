import type { Decision } from "@harness/policy";

export type SandboxRunnerErrorCode =
  | "SANDBOX_INVALID_SPEC"
  | "SANDBOX_UNSAFE_ALLOWED_PATH"
  | "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH"
  | "SANDBOX_ALLOWED_PATH_NOT_FOUND"
  | "SANDBOX_UNREPRESENTABLE_POLICY"
  | "SANDBOX_PERMISSION_REQUIRED"
  | "SANDBOX_PERMISSION_RESOLUTION_INVALID"
  | "SANDBOX_POLICY_DENIED"
  | "SANDBOX_EXECUTOR_FAILED"
  | "SANDBOX_ABORTED"
  | "SANDBOX_DUPLICATE_RUN"
  | "SANDBOX_CLEANUP_FAILED"
  | "SANDBOX_PATH_CHANGED"
  | "SANDBOX_UNSAFE_DOCKER_HOST"
  | "SANDBOX_UNTRUSTED_IMAGE";

export class SandboxRunnerError extends Error {
  readonly details?: unknown;

  constructor(
    readonly code: SandboxRunnerErrorCode,
    message: string,
    options: { cause?: unknown; details?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.details = options.details;
  }
}

export class SandboxSpecError extends SandboxRunnerError {
  constructor(message: string, details?: unknown) {
    super("SANDBOX_INVALID_SPEC", message, { details });
  }
}

export class SandboxAllowedPathError extends SandboxRunnerError {
  constructor(
    code:
      | "SANDBOX_UNSAFE_ALLOWED_PATH"
      | "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH"
      | "SANDBOX_ALLOWED_PATH_NOT_FOUND",
    readonly pattern: string,
    message: string,
    details?: unknown,
  ) {
    super(code, message, { details });
  }
}

export class SandboxPermissionRequiredError extends SandboxRunnerError {
  constructor(readonly decision: Decision) {
    super(
      "SANDBOX_PERMISSION_REQUIRED",
      `permission required for ${decision.action}${decision.subject === undefined ? "" : ` ${JSON.stringify(decision.subject)}`}`,
      { details: decision },
    );
  }
}

export class SandboxPermissionResolutionError extends SandboxRunnerError {
  constructor(readonly decision: Decision, resolution: unknown) {
    super(
      "SANDBOX_PERMISSION_RESOLUTION_INVALID",
      `permission resolver returned ${JSON.stringify(resolution)} for ${decision.action}; expected "allow" or "deny"`,
      { details: { decision, resolution } },
    );
  }
}

export class SandboxPolicyDeniedError extends SandboxRunnerError {
  constructor(readonly decision: Decision) {
    super(
      "SANDBOX_POLICY_DENIED",
      `policy denied ${decision.action}${decision.subject === undefined ? "" : ` ${JSON.stringify(decision.subject)}`}: ${decision.reason}`,
      { details: decision },
    );
  }
}

export class SandboxUnrepresentablePolicyError extends SandboxRunnerError {
  constructor(action: string, rule: unknown, reason: string) {
    super(
      "SANDBOX_UNREPRESENTABLE_POLICY",
      `${action} policy cannot be enforced without widening access: ${reason}`,
      { details: { action, rule } },
    );
  }
}

export class SandboxExecutorError extends SandboxRunnerError {
  constructor(message: string, cause?: unknown, details?: unknown) {
    super("SANDBOX_EXECUTOR_FAILED", message, { cause, details });
  }
}

export class SandboxAbortedError extends SandboxRunnerError {
  constructor(message = "sandbox run was canceled") {
    super("SANDBOX_ABORTED", message);
  }
}

export class SandboxDuplicateRunError extends SandboxRunnerError {
  constructor(readonly runId: string) {
    super(
      "SANDBOX_DUPLICATE_RUN",
      `sandbox run ${JSON.stringify(runId)} is already active`,
      { details: { runId } },
    );
  }
}

export class SandboxPathChangedError extends SandboxRunnerError {
  constructor(message: string, details?: unknown) {
    super("SANDBOX_PATH_CHANGED", message, { details });
  }
}

export class SandboxDockerHostError extends SandboxRunnerError {
  constructor(host: string, reason: string) {
    super(
      "SANDBOX_UNSAFE_DOCKER_HOST",
      `unsafe Docker host ${JSON.stringify(host)}: ${reason}`,
      { details: { host, reason } },
    );
  }
}

export class SandboxUntrustedImageError extends SandboxRunnerError {
  constructor(image: string) {
    super(
      "SANDBOX_UNTRUSTED_IMAGE",
      `image ${JSON.stringify(image)} is not immutable; set trustedLocalImage: true only for a reviewed local development image`,
      { details: { image } },
    );
  }
}

export class SandboxCleanupError extends SandboxRunnerError {
  constructor(
    readonly runId: string,
    readonly containerName: string,
    details: unknown,
    executionError?: unknown,
  ) {
    super(
      "SANDBOX_CLEANUP_FAILED",
      `failed to prove cleanup of sandbox container ${JSON.stringify(containerName)} for run ${JSON.stringify(runId)}`,
      { cause: executionError, details },
    );
  }
}

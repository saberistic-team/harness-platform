export type ControlPlaneErrorCode =
  | "CP_INVALID_INPUT"
  | "CP_NOT_FOUND"
  | "CP_CONFLICT"
  | "CP_STALE_LEASE"
  | "CP_LEASE_EXPIRED"
  | "CP_PAYLOAD_TOO_LARGE"
  | "CP_UNSUPPORTED_MEDIA_TYPE"
  | "CP_NOT_READY"
  | "CP_STORAGE_FAILED"
  | "CP_INTERNAL";

const STATUS_BY_CODE: Record<ControlPlaneErrorCode, number> = {
  CP_INVALID_INPUT: 400,
  CP_NOT_FOUND: 404,
  CP_CONFLICT: 409,
  CP_STALE_LEASE: 409,
  CP_LEASE_EXPIRED: 409,
  CP_PAYLOAD_TOO_LARGE: 413,
  CP_UNSUPPORTED_MEDIA_TYPE: 415,
  CP_NOT_READY: 503,
  CP_STORAGE_FAILED: 503,
  CP_INTERNAL: 500,
};

/** A bounded, transport-safe failure. Never expose database/provider errors. */
export class ControlPlaneError extends Error {
  readonly status: number;

  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ControlPlaneError";
    this.status = STATUS_BY_CODE[code];
  }
}

export function controlPlaneError(
  error: unknown,
  fallback = "control-plane operation failed",
): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError("CP_STORAGE_FAILED", fallback, { cause: error });
}

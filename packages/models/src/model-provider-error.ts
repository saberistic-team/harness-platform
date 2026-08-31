export type ModelProviderErrorCode =
  | "MODEL_INVALID_CONFIG"
  | "MODEL_INVALID_REQUEST"
  | "MODEL_ABORTED"
  | "MODEL_TIMEOUT"
  | "MODEL_TRANSPORT_ERROR"
  | "MODEL_AUTH_ERROR"
  | "MODEL_RATE_LIMITED"
  | "MODEL_HTTP_ERROR"
  | "MODEL_INVALID_RESPONSE"
  | "MODEL_UNSUPPORTED_RESPONSE"
  | "MODEL_CONTENT_FILTERED";

export interface ModelProviderErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  status?: number;
  providerRequestId?: string;
  providerCode?: string;
  details?: unknown;
}

/**
 * Typed failure raised at the model-provider boundary.
 *
 * Messages and details are deliberately sanitized by adapters before this
 * error is constructed. Credentials and raw provider bodies must never be
 * attached because callers may turn this error into an event or run report.
 */
export class ModelProviderError extends Error {
  readonly code: ModelProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly providerRequestId?: string;
  readonly providerCode?: string;
  readonly details?: unknown;

  constructor(
    code: ModelProviderErrorCode,
    message: string,
    options: ModelProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ModelProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId;
    this.providerCode = options.providerCode;
    this.details = options.details;
  }
}

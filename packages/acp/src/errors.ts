export type AcpProtocolErrorCode =
  | "ACP_PARSE_ERROR"
  | "ACP_INVALID_REQUEST"
  | "ACP_METHOD_NOT_FOUND"
  | "ACP_INVALID_PARAMS"
  | "ACP_INVALID_RESPONSE"
  | "ACP_PROTOCOL_VERSION"
  | "ACP_NOT_INITIALIZED"
  | "ACP_SESSION_NOT_FOUND"
  | "ACP_SESSION_ALREADY_RUN"
  | "ACP_SESSION_LIMIT"
  | "ACP_PERMISSION_NOT_FOUND"
  | "ACP_PERMISSION_RESOLVED"
  | "ACP_REQUEST_TIMEOUT"
  | "ACP_TRANSPORT_CLOSED"
  | "ACP_INTERNAL_ERROR";

export const ACP_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  protocolVersion: -32001,
  notInitialized: -32002,
  sessionNotFound: -32010,
  sessionAlreadyRun: -32011,
  sessionLimit: -32012,
  permissionNotFound: -32020,
  permissionResolved: -32021,
} as const;

export class AcpProtocolError extends Error {
  constructor(
    readonly code: AcpProtocolErrorCode,
    message: string,
    readonly rpcCode: number,
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

export class AcpRemoteError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRemoteError";
  }
}

export class AcpClientError extends Error {
  constructor(
    readonly code:
      | "ACP_REQUEST_TIMEOUT"
      | "ACP_TRANSPORT_CLOSED"
      | "ACP_INVALID_RESPONSE"
      | "ACP_TRANSPORT_ERROR",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AcpClientError";
  }
}

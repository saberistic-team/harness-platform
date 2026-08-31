import type { z } from "zod";
import {
  ACP_METHODS,
  acpCancelSessionResultSchema,
  acpInitializeResultSchema,
  acpNewSessionResultSchema,
  acpPermissionResponseResultSchema,
  acpPromptResultSchema,
  decodeAcpMessage,
  type AcpCancelSessionParams,
  type AcpCancelSessionResult,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpNewSessionParams,
  type AcpNewSessionResult,
  type AcpPermissionResponseParams,
  type AcpPermissionResponseResult,
  type AcpPromptParams,
  type AcpPromptResult,
  type AcpRequestId,
  type AcpSessionEventParams,
} from "./protocol";
import { AcpClientError, AcpRemoteError } from "./errors";

interface SocketEvent {
  data?: unknown;
  error?: unknown;
}

type SocketEventType = "open" | "message" | "error" | "close";
const MAX_QUEUED_INBOUND_MESSAGES = 128;

export interface AcpWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void;
  removeEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void;
}

export type AcpWebSocketFactory = (url: string) => AcpWebSocket;

export interface AcpClientOptions {
  webSocketFactory?: AcpWebSocketFactory;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Reject inbound or outbound ACP messages above this UTF-8 byte size. */
  maxMessageBytes?: number;
  /** Bound the number of calls awaiting a response on one connection. */
  maxPendingRequests?: number;
  /** Cancels connection setup and closes the established connection later. */
  signal?: AbortSignal;
}

interface PendingRequest {
  schema: z.ZodTypeAny;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultFactory(url: string): AcpWebSocket {
  const ctor = (globalThis as unknown as {
    WebSocket?: new (value: string) => AcpWebSocket;
  }).WebSocket;
  if (!ctor) {
    throw new AcpClientError("ACP_TRANSPORT_ERROR", "this runtime does not provide a WebSocket client");
  }
  return new ctor(url);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AcpClientError("ACP_TRANSPORT_ERROR", `${name} must be a positive safe integer`);
  }
  return value;
}

function assertMessageSize(size: number, maximum: number): void {
  if (size > maximum) {
    throw new AcpClientError(
      "ACP_INVALID_RESPONSE",
      `ACP WebSocket message exceeds the ${maximum}-byte limit`,
    );
  }
}

function browserCloseCode(code: number): number {
  // The browser WebSocket API only permits 1000 or application-defined
  // 3000-4999 codes, even though peers can put other RFC codes on the wire.
  return code === 1000 || (Number.isInteger(code) && code >= 3000 && code < 5000)
    ? code
    : 1000;
}

function browserCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  let result = "";
  let bytes = 0;
  for (const character of reason) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > 123) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function messageText(data: unknown, maximum: number): string {
  // WebSocket MessageEvent.data is a string for text frames and a Blob or
  // ArrayBuffer for binary frames. ACP is text-only, so decoding binary bytes
  // as JSON would silently accept a wire-format violation.
  if (typeof data !== "string") {
    throw new AcpClientError("ACP_INVALID_RESPONSE", "ACP WebSocket delivered a non-text frame");
  }
  assertMessageSize(Buffer.byteLength(data, "utf8"), maximum);
  return data;
}

export class AcpClient {
  private nextId = 0;
  private readonly pending = new Map<AcpRequestId, PendingRequest>();
  private readonly eventListeners = new Set<(event: AcpSessionEventParams) => void>();
  private readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly maxPendingRequests: number;
  private inboundQueue: Promise<void> = Promise.resolve();
  private queuedInboundMessages = 0;
  private signal?: AbortSignal;
  private closed = false;

  private readonly onSocketMessage = (event: SocketEvent): void => {
    if (this.closed) return;
    if (this.queuedInboundMessages >= MAX_QUEUED_INBOUND_MESSAGES) {
      this.terminate(
        new AcpClientError("ACP_INVALID_RESPONSE", "ACP inbound message queue limit reached"),
        4009,
        "inbound queue limit reached",
      );
      return;
    }
    this.queuedInboundMessages++;
    this.inboundQueue = this.inboundQueue
      .then(() => this.handleMessage(event.data))
      .catch((error) => this.terminate(error, 4002, "invalid ACP message"))
      .finally(() => { this.queuedInboundMessages--; });
  };

  private readonly onSocketClose = (): void => {
    this.terminate(new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket closed"));
  };

  private readonly onSocketError = (event: SocketEvent): void => {
    this.terminate(
      new AcpClientError("ACP_TRANSPORT_ERROR", "ACP WebSocket transport failed", event.error),
      4011,
      "transport failed",
    );
  };

  private readonly onAbort = (): void => {
    this.terminate(
      new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket connection canceled"),
      1000,
      "connection canceled",
    );
  };

  private constructor(private readonly socket: AcpWebSocket, options: AcpClientOptions) {
    // A prompt can include several model turns plus an operator permission
    // pause. Keep the transport timeout above the server's ask timeout.
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? 10 * 60_000, "requestTimeoutMs");
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes ?? 1024 * 1024, "maxMessageBytes");
    this.maxPendingRequests = positiveInteger(options.maxPendingRequests ?? 128, "maxPendingRequests");
    socket.addEventListener("message", this.onSocketMessage);
    socket.addEventListener("close", this.onSocketClose);
    socket.addEventListener("error", this.onSocketError);
    this.signal = options.signal;
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal?.aborted) this.onAbort();
  }

  static async connect(url: string, options: AcpClientOptions = {}): Promise<AcpClient> {
    const timeoutMs = positiveInteger(options.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
    positiveInteger(options.requestTimeoutMs ?? 10 * 60_000, "requestTimeoutMs");
    positiveInteger(options.maxMessageBytes ?? 1024 * 1024, "maxMessageBytes");
    positiveInteger(options.maxPendingRequests ?? 128, "maxPendingRequests");
    let socket: AcpWebSocket;
    try {
      socket = (options.webSocketFactory ?? defaultFactory)(url);
    } catch (error) {
      if (error instanceof AcpClientError) throw error;
      throw new AcpClientError("ACP_TRANSPORT_ERROR", "failed to create ACP WebSocket", error);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new AcpClientError("ACP_REQUEST_TIMEOUT", `ACP connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: AcpClientError) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close(1000, "connection canceled");
        } catch {
          // The original typed connection failure remains authoritative.
        }
        reject(error);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (event: SocketEvent) => {
        fail(new AcpClientError("ACP_TRANSPORT_ERROR", "ACP WebSocket connection failed", event.error));
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket closed before connecting"));
      };
      const onAbort = () => {
        fail(new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket connection canceled"));
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else if (socket.readyState === 1) onOpen();
      else if (socket.readyState === 2 || socket.readyState === 3) onClose();
      else if (socket.readyState !== 0) {
        fail(new AcpClientError("ACP_TRANSPORT_ERROR", "ACP WebSocket has an invalid readyState"));
      }
    });
    if (options.signal?.aborted) {
      try {
        socket.close(1000, "connection canceled");
      } catch {
        // Preserve the typed cancellation below.
      }
      throw new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket connection canceled");
    }
    if (socket.readyState !== 1) {
      try {
        socket.close(1000, "connection closed");
      } catch {
        // Preserve the typed transport failure below.
      }
      throw new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket closed while connecting");
    }
    const client = new AcpClient(socket, options);
    if (client.closed) {
      throw new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket connection canceled");
    }
    return client;
  }

  onEvent(listener: (event: AcpSessionEventParams) => void): () => void {
    if (this.closed) return () => {};
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  initialize(params: AcpInitializeParams): Promise<AcpInitializeResult> {
    return this.call(ACP_METHODS.initialize, params, acpInitializeResultSchema);
  }

  newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    return this.call(ACP_METHODS.newSession, params, acpNewSessionResultSchema);
  }

  prompt(params: AcpPromptParams): Promise<AcpPromptResult> {
    return this.call(ACP_METHODS.prompt, params, acpPromptResultSchema);
  }

  respondPermission(params: AcpPermissionResponseParams): Promise<AcpPermissionResponseResult> {
    return this.call(ACP_METHODS.respondPermission, params, acpPermissionResponseResultSchema);
  }

  cancelSession(params: AcpCancelSessionParams): Promise<AcpCancelSessionResult> {
    return this.call(ACP_METHODS.cancelSession, params, acpCancelSessionResultSchema);
  }

  close(code = 1000, reason = "client closed"): void {
    if (this.closed) return;
    this.terminate(
      new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP client closed"),
      code,
      reason,
    );
  }

  private call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    if (this.closed || this.socket.readyState !== 1) {
      return Promise.reject(new AcpClientError("ACP_TRANSPORT_CLOSED", "ACP WebSocket is not open"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new AcpClientError(
        "ACP_TRANSPORT_ERROR",
        `ACP pending request limit (${this.maxPendingRequests}) reached`,
      ));
    }
    const id = `req-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      let wire: string;
      try {
        wire = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        reject(new AcpClientError("ACP_TRANSPORT_ERROR", `failed to serialize ${method}`, error));
        return;
      }
      if (Buffer.byteLength(wire, "utf8") > this.maxMessageBytes) {
        reject(new AcpClientError(
          "ACP_TRANSPORT_ERROR",
          `${method} request exceeds the ${this.maxMessageBytes}-byte limit`,
        ));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpClientError("ACP_REQUEST_TIMEOUT", `${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { schema, resolve, reject, timer });
      try {
        this.socket.send(wire);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AcpClientError("ACP_TRANSPORT_ERROR", `failed to send ${method}`, error));
      }
    });
  }

  private handleMessage(data: unknown): void {
    if (this.closed) return;
    const message = decodeAcpMessage(messageText(data, this.maxMessageBytes));
    if ("method" in message) {
      if (message.method !== ACP_METHODS.sessionEvent || "id" in message) {
        throw new AcpClientError("ACP_INVALID_RESPONSE", "ACP server sent an unexpected request");
      }
      for (const listener of this.eventListeners) {
        try {
          listener(message.params);
        } catch {
          // A consumer callback cannot corrupt response correlation or poison
          // the shared transport for other listeners.
        }
      }
      return;
    }
    const pending = this.pending.get(message.id as AcpRequestId);
    if (!pending) return;
    this.pending.delete(message.id as AcpRequestId);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(new AcpRemoteError(message.error.code, message.error.message, message.error.data));
      return;
    }
    const result = pending.schema.safeParse(message.result);
    if (!result.success) {
      pending.reject(new AcpClientError("ACP_INVALID_RESPONSE", "ACP response result failed validation", result.error));
      return;
    }
    pending.resolve(result.data);
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private terminate(error: unknown, code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("message", this.onSocketMessage);
    this.socket.removeEventListener("close", this.onSocketClose);
    this.socket.removeEventListener("error", this.onSocketError);
    this.signal?.removeEventListener("abort", this.onAbort);
    this.signal = undefined;
    this.eventListeners.clear();
    this.failAll(error);
    if (code !== undefined) {
      try {
        this.socket.close(browserCloseCode(code), browserCloseReason(reason));
      } catch {
        // The original typed failure remains authoritative.
      }
    }
  }
}

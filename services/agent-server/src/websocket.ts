import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_INCOMPLETE_FRAME_TIMEOUT_MS = 30_000;
const CLOSE_DRAIN_TIMEOUT_MS = 1_000;
const MAX_FRAGMENT_FRAMES = 1024;
const MAX_PRELISTENER_MESSAGES = 128;
const BYTE_QUEUE_BLOCK_BYTES = 8 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface WebSocketConnection {
  readonly open: boolean;
  sendText(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

export interface WebSocketUpgradeOptions {
  path?: string;
  maxMessageBytes?: number;
  /** Maximum time allowed to finish one frame or fragmented message. */
  incompleteFrameTimeoutMs?: number;
  /** Browser origins are rejected unless explicitly allow-listed. */
  allowedOrigins?: readonly string[];
  authorizeRequest?: (request: IncomingMessage) => boolean;
  onConnection(
    connection: WebSocketConnection,
    request: IncomingMessage,
  ): void | Promise<void>;
}

function frame(
  opcode: number,
  payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer<ArrayBufferLike> {
  const size = payload.length;
  let header: Buffer;
  if (size < 126) {
    header = Buffer.from([0x80 | opcode, size]);
  } else if (size <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, payload]);
}

/** A segmented byte queue avoids quadratic copying under slow, tiny writes. */
interface ByteSegment {
  buffer: Buffer;
  start: number;
  end: number;
}

class ByteQueue {
  private segments: ByteSegment[] = [];
  private segmentIndex = 0;
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.length === 0) {
      this.segments = [];
      this.segmentIndex = 0;
    }
    let sourceOffset = 0;
    while (sourceOffset < chunk.length) {
      let tail = this.segments.at(-1);
      if (!tail || tail.end === tail.buffer.length) {
        const remaining = chunk.length - sourceOffset;
        if (remaining >= BYTE_QUEUE_BLOCK_BYTES) {
          this.segments.push({ buffer: chunk, start: sourceOffset, end: chunk.length });
          sourceOffset = chunk.length;
          continue;
        }
        tail = {
          buffer: Buffer.allocUnsafe(BYTE_QUEUE_BLOCK_BYTES),
          start: 0,
          end: 0,
        };
        this.segments.push(tail);
      }
      const count = Math.min(
        tail.buffer.length - tail.end,
        chunk.length - sourceOffset,
      );
      chunk.copy(tail.buffer, tail.end, sourceOffset, sourceOffset + count);
      tail.end += count;
      sourceOffset += count;
    }
    this.length += chunk.length;
  }

  at(index: number): number {
    if (index < 0 || index >= this.length) throw new RangeError("byte queue index out of bounds");
    let segmentIndex = this.segmentIndex;
    let offset = index;
    while (segmentIndex < this.segments.length) {
      const segment = this.segments[segmentIndex]!;
      const available = segment.end - segment.start;
      if (offset < available) return segment.buffer[segment.start + offset]!;
      offset -= available;
      segmentIndex++;
    }
    throw new RangeError("byte queue index out of bounds");
  }

  read(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.length) {
      throw new RangeError("invalid byte queue read");
    }
    const output = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const segment = this.segments[this.segmentIndex]!;
      const available = segment.end - segment.start;
      const count = Math.min(available, size - written);
      segment.buffer.copy(output, written, segment.start, segment.start + count);
      written += count;
      this.consume(count);
    }
    return output;
  }

  discard(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.length) {
      throw new RangeError("invalid byte queue discard");
    }
    let remaining = size;
    while (remaining > 0) {
      const segment = this.segments[this.segmentIndex]!;
      const count = Math.min(segment.end - segment.start, remaining);
      this.consume(count);
      remaining -= count;
    }
  }

  private consume(size: number): void {
    const segment = this.segments[this.segmentIndex]!;
    segment.start += size;
    this.length -= size;
    if (segment.start === segment.end) {
      this.segmentIndex++;
    }
    if (this.length === 0) {
      this.segments = [];
      this.segmentIndex = 0;
    } else if (
      this.segmentIndex > 0 &&
      (this.segmentIndex >= 32 || this.segmentIndex * 2 >= this.segments.length)
    ) {
      this.segments = this.segments.slice(this.segmentIndex);
      this.segmentIndex = 0;
    }
  }
}

function isValidCloseCode(code: number): boolean {
  return Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014) || (code >= 3000 && code < 5000)) &&
    code !== 1004 &&
    code !== 1005 &&
    code !== 1006 &&
    code !== 1015;
}

function closeReasonBytes(reason: string): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  for (const character of reason) {
    const encoded = Buffer.from(character, "utf8");
    if (length + encoded.length > 123) break;
    chunks.push(encoded);
    length += encoded.length;
  }
  return Buffer.concat(chunks, length);
}

class SocketWebSocket implements WebSocketConnection {
  private readonly input = new ByteQueue();
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentFrames = 0;
  private fragmentOpcode: number | undefined;
  private incompleteTimer?: ReturnType<typeof setTimeout>;
  private fragmentTimer?: ReturnType<typeof setTimeout>;
  private forceDestroyTimer?: ReturnType<typeof setTimeout>;
  private messageListener?: (text: string) => void;
  private readonly queuedMessages: string[] = [];
  private queuedMessageBytes = 0;
  private closeListener?: () => void;
  private closeNotified = false;
  private closed = false;
  private readonly maxOutboundBufferedBytes: number;

  constructor(
    private readonly socket: Duplex,
    head: Buffer,
    private readonly maxMessageBytes: number,
    private readonly incompleteFrameTimeoutMs: number,
  ) {
    this.maxOutboundBufferedBytes = Math.max(64 * 1024, maxMessageBytes * 2);
    socket.on("data", (chunk: Buffer | string) => {
      try {
        this.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      } catch {
        this.shutdown(1011, "frame processing failed");
      }
    });
    socket.on("close", () => this.finishClose());
    socket.on("end", () => this.finishClose());
    socket.on("error", () => this.finishClose());
    if (head.length > 0) this.feed(head);
  }

  get open(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListener = listener;
    const queued = this.queuedMessages.splice(0);
    this.queuedMessageBytes = 0;
    for (const message of queued) {
      if (!this.invokeMessageListener(message)) break;
    }
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
    if (this.closed) this.notifyClose();
  }

  sendText(text: string): void {
    if (!this.open) return;
    const payloadBytes = Buffer.byteLength(text, "utf8");
    if (payloadBytes > this.maxMessageBytes) {
      this.shutdown(1009, "message too large");
      return;
    }
    const payload = Buffer.from(text, "utf8");
    this.writeFrame(0x1, payload);
  }

  close(code = 1000, reason = ""): void {
    this.shutdown(isValidCloseCode(code) ? code : 1002, reason);
  }

  private finishClose(): void {
    if (this.forceDestroyTimer) clearTimeout(this.forceDestroyTimer);
    this.forceDestroyTimer = undefined;
    if (this.closed) return;
    this.closed = true;
    this.clearProtocolTimers();
    this.notifyClose();
  }

  private shutdown(code: number, reason: string, payload?: Buffer): void {
    if (this.closed) return;
    this.closed = true;
    this.clearProtocolTimers();
    const closePayload = payload ?? (() => {
      const reasonBytes = closeReasonBytes(reason);
      const value = Buffer.allocUnsafe(2 + reasonBytes.length);
      value.writeUInt16BE(code, 0);
      reasonBytes.copy(value, 2);
      return value;
    })();
    if (!this.socket.destroyed) {
      try {
        this.socket.end(frame(0x8, closePayload));
        // Writable completion does not imply the peer closed its readable
        // half. Bound shutdown so server.close() cannot wait forever on a
        // peer that ignores the WebSocket close handshake.
        this.forceDestroyTimer = setTimeout(() => {
          if (!this.socket.destroyed) this.socket.destroy();
        }, CLOSE_DRAIN_TIMEOUT_MS);
        this.forceDestroyTimer.unref();
      } catch {
        this.socket.destroy();
      }
    }
    this.notifyClose();
  }

  private notifyClose(): void {
    if (this.closeNotified || !this.closeListener) return;
    this.closeNotified = true;
    try {
      this.closeListener();
    } catch {
      // Transport teardown must remain terminal even if a consumer cleanup
      // hook is faulty.
    }
  }

  private clearProtocolTimers(): void {
    if (this.incompleteTimer) clearTimeout(this.incompleteTimer);
    if (this.fragmentTimer) clearTimeout(this.fragmentTimer);
    this.incompleteTimer = undefined;
    this.fragmentTimer = undefined;
  }

  private armIncompleteTimer(): void {
    if (this.incompleteTimer || this.closed) return;
    this.incompleteTimer = setTimeout(
      () => this.shutdown(1002, "incomplete frame timeout"),
      this.incompleteFrameTimeoutMs,
    );
    this.incompleteTimer.unref();
  }

  private armFragmentTimer(): void {
    if (this.fragmentTimer || this.closed) return;
    this.fragmentTimer = setTimeout(
      () => this.shutdown(1002, "fragmented message timeout"),
      this.incompleteFrameTimeoutMs,
    );
    this.fragmentTimer.unref();
  }

  private resetFragment(): void {
    if (this.fragmentTimer) clearTimeout(this.fragmentTimer);
    this.fragmentTimer = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentFrames = 0;
    this.fragmentOpcode = undefined;
  }

  private feed(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    this.input.push(chunk);
    while (this.open) {
      if (!this.parseOne()) break;
      if (this.incompleteTimer) clearTimeout(this.incompleteTimer);
      this.incompleteTimer = undefined;
    }
    if (this.open && this.input.length > 0) this.armIncompleteTimer();
  }

  private parseOne(): boolean {
    if (this.input.length < 2) return false;
    const first = this.input.at(0);
    const second = this.input.at(1);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    if ((first & 0x70) !== 0 || !masked) {
      this.shutdown(1002, "invalid frame");
      return false;
    }
    if (![0x0, 0x1, 0x2, 0x8, 0x9, 0x0a].includes(opcode)) {
      this.shutdown(1002, "unsupported opcode");
      return false;
    }

    const lengthCode = second & 0x7f;
    const control = opcode >= 0x8;
    if (control && (!fin || lengthCode > 125)) {
      this.shutdown(1002, "invalid control frame");
      return false;
    }
    if (opcode === 0x2) {
      this.shutdown(1003, "binary frames are not supported");
      return false;
    }
    if (opcode === 0x1 && this.fragmentOpcode !== undefined) {
      this.shutdown(1002, "nested fragmented message");
      return false;
    }
    if (opcode === 0x0 && this.fragmentOpcode === undefined) {
      this.shutdown(1002, "unexpected continuation frame");
      return false;
    }

    let length = lengthCode;
    let offset = 2;
    if (lengthCode === 126) {
      if (this.input.length < 4) return false;
      length = (this.input.at(2) << 8) | this.input.at(3);
      offset = 4;
      if (length < 126) {
        this.shutdown(1002, "non-canonical frame length");
        return false;
      }
    } else if (lengthCode === 127) {
      if (this.input.length < 10) return false;
      const lengthBytes = Buffer.allocUnsafe(8);
      for (let index = 0; index < 8; index++) lengthBytes[index] = this.input.at(index + 2);
      const wide = lengthBytes.readBigUInt64BE(0);
      if ((wide & (1n << 63n)) !== 0n || wide < 65_536n) {
        this.shutdown(1002, "invalid 64-bit frame length");
        return false;
      }
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.shutdown(1009, "message too large");
        return false;
      }
      length = Number(wide);
      offset = 10;
    }

    if (!control && length > this.maxMessageBytes) {
      this.shutdown(1009, "message too large");
      return false;
    }
    if (opcode === 0x0 && this.fragmentBytes + length > this.maxMessageBytes) {
      this.shutdown(1009, "message too large");
      return false;
    }

    const completeLength = offset + 4 + length;
    if (this.input.length < completeLength) return false;
    this.input.discard(offset);
    const mask = this.input.read(4);
    const payload = this.input.read(length);
    for (let index = 0; index < payload.length; index++) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }

    if (opcode === 0x8) {
      this.receiveClose(payload);
      return false;
    }
    if (opcode === 0x9) {
      this.writeFrame(0x0a, payload);
      return true;
    }
    if (opcode === 0x0a) return true;

    if (opcode === 0x1) {
      if (fin) return this.deliver(payload);
      this.fragmentOpcode = opcode;
      this.fragments = payload.length === 0 ? [] : [payload];
      this.fragmentBytes = payload.length;
      this.fragmentFrames = 1;
      this.armFragmentTimer();
      return true;
    }

    this.fragmentFrames++;
    if (this.fragmentFrames > MAX_FRAGMENT_FRAMES) {
      this.shutdown(1009, "too many fragments");
      return false;
    }
    if (payload.length > 0) this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (!fin) return true;
    const complete = Buffer.concat(this.fragments, this.fragmentBytes);
    this.resetFragment();
    return this.deliver(complete);
  }

  private receiveClose(payload: Buffer): void {
    if (payload.length === 1) {
      this.shutdown(1002, "invalid close frame");
      return;
    }
    if (payload.length >= 2) {
      const code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) {
        this.shutdown(1002, "invalid close code");
        return;
      }
      try {
        utf8.decode(payload.subarray(2));
      } catch {
        this.shutdown(1007, "invalid close reason");
        return;
      }
    }
    this.shutdown(1000, "", payload);
  }

  private deliver(payload: Buffer): boolean {
    let text: string;
    try {
      text = utf8.decode(payload);
    } catch {
      this.shutdown(1007, "invalid UTF-8");
      return false;
    }
    if (this.messageListener) return this.invokeMessageListener(text);
    const messageBytes = Buffer.byteLength(text, "utf8");
    if (
      this.queuedMessages.length >= MAX_PRELISTENER_MESSAGES ||
      this.queuedMessageBytes + messageBytes > this.maxMessageBytes
    ) {
      this.shutdown(1009, "pre-listener message queue exceeded");
      return false;
    }
    this.queuedMessages.push(text);
    this.queuedMessageBytes += messageBytes;
    return true;
  }

  private invokeMessageListener(text: string): boolean {
    try {
      this.messageListener?.(text);
      return this.open;
    } catch {
      this.shutdown(1011, "message handler failed");
      return false;
    }
  }

  private writeFrame(opcode: number, payload: Buffer): boolean {
    if (!this.open) return false;
    const wire = frame(opcode, payload);
    // Node's write(false) means bytes have already entered the internal
    // writable queue. Check the queue before writing so a non-reading peer
    // cannot grow that queue without bound.
    if (this.socket.writableLength + wire.length > this.maxOutboundBufferedBytes) {
      this.shutdown(1013, "outbound backpressure limit exceeded");
      return false;
    }
    try {
      this.socket.write(wire);
      return true;
    } catch {
      this.finishClose();
      return false;
    }
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      () => socket.destroy(),
    );
  } catch {
    socket.destroy();
  }
}

function validWebSocketKey(key: string): boolean {
  return /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, "base64").length === 16;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

export function attachWebSocketServer(server: HttpServer, options: WebSocketUpgradeOptions): void {
  const path = options.path ?? "/acp";
  if (!path.startsWith("/")) throw new Error("WebSocket path must start with /");
  const maxMessageBytes = boundedPositiveInteger(
    options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    "maxMessageBytes",
    MAX_CONFIGURED_MESSAGE_BYTES,
  );
  const incompleteFrameTimeoutMs = boundedPositiveInteger(
    options.incompleteFrameTimeoutMs ?? DEFAULT_INCOMPLETE_FRAME_TIMEOUT_MS,
    "incompleteFrameTimeoutMs",
    10 * 60_000,
  );
  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== path) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const origin = request.headers.origin;
    let authorized = true;
    try {
      authorized = options.authorizeRequest?.(request) ?? true;
    } catch {
      authorized = false;
    }
    if (
      (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) ||
      !authorized
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const upgrade = request.headers.upgrade?.toLowerCase();
    const connection = request.headers.connection?.toLowerCase() ?? "";
    const key = request.headers["sec-websocket-key"];
    const version = request.headers["sec-websocket-version"];
    if (
      request.method !== "GET" ||
      upgrade !== "websocket" ||
      !connection.split(/\s*,\s*/).includes("upgrade") ||
      typeof key !== "string" ||
      !validWebSocketKey(key) ||
      version !== "13"
    ) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
    try {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    } catch {
      socket.destroy();
      return;
    }
    const connectionSocket = new SocketWebSocket(
      socket,
      head,
      maxMessageBytes,
      incompleteFrameTimeoutMs,
    );
    try {
      const setup = options.onConnection(connectionSocket, request);
      if (setup) {
        void setup.catch(() => connectionSocket.close(1011, "connection setup failed"));
      }
    } catch {
      connectionSocket.close(1011, "connection setup failed");
    }
  });
}

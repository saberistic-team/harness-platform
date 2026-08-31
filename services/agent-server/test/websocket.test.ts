import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachWebSocketServer,
  type WebSocketConnection,
  type WebSocketUpgradeOptions,
} from "../src/websocket";

const VALID_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

class TestDuplex extends Duplex {
  readonly writes: Buffer[] = [];
  blockAfter = Number.POSITIVE_INFINITY;
  private writeCount = 0;

  override _read(): void {}

  receive(chunk: Buffer): void {
    this.emit("data", chunk);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    this.writeCount++;
    if (this.writeCount <= this.blockAfter) callback();
  }
}

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    method: "GET",
    url: "/acp",
    headers: {
      connection: "keep-alive, Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": VALID_KEY,
      "sec-websocket-version": "13",
    },
    ...overrides,
  } as IncomingMessage;
}

function upgrade(
  options: Partial<WebSocketUpgradeOptions> = {},
  head = Buffer.alloc(0),
  socket = new TestDuplex(),
  incoming = request(),
): { socket: TestDuplex; connection?: WebSocketConnection } {
  const events = new EventEmitter();
  let connection: WebSocketConnection | undefined;
  attachWebSocketServer(events as unknown as HttpServer, {
    ...options,
    onConnection(value, req) {
      connection = value;
      options.onConnection?.(value, req);
    },
  });
  events.emit("upgrade", incoming, socket, head);
  return { socket, connection };
}

function clientFrame(opcode: number, value: string | Buffer, fin = true): Buffer {
  const payload = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (payload.length >= 126) throw new Error("test helper only supports short frames");
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index++) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([
    Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]),
    mask,
    masked,
  ]);
}

function closeCode(socket: TestDuplex): number | undefined {
  const close = socket.writes.findLast((wire) => wire[0] === 0x88);
  if (!close || (close[1]! & 0x7f) < 2) return undefined;
  return close.readUInt16BE(2);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent-server WebSocket framing", () => {
  it("reassembles a fragmented text message delivered one byte at a time", () => {
    const messages: string[] = [];
    const result = upgrade({
      onConnection(connection) {
        connection.onMessage((message) => messages.push(message));
      },
    });
    const wire = Buffer.concat([
      clientFrame(0x1, "hel", false),
      clientFrame(0x0, "lo", true),
    ]);
    for (const byte of wire) result.socket.receive(Buffer.from([byte]));
    expect(messages).toEqual(["hello"]);
    result.connection?.close();
    result.socket.destroy();
  });

  it("rejects non-canonical lengths and malformed close payloads", () => {
    const nonCanonical = upgrade();
    nonCanonical.connection?.onMessage(() => {});
    const mask = Buffer.from([1, 2, 3, 4]);
    nonCanonical.socket.receive(Buffer.concat([
      Buffer.from([0x81, 0xfe, 0, 1]),
      mask,
      Buffer.from(["x".charCodeAt(0) ^ mask[0]!]),
    ]));
    expect(closeCode(nonCanonical.socket)).toBe(1002);
    nonCanonical.socket.destroy();

    const malformedClose = upgrade();
    malformedClose.connection?.onMessage(() => {});
    malformedClose.socket.receive(clientFrame(0x8, Buffer.from([1])));
    expect(closeCode(malformedClose.socket)).toBe(1002);
    malformedClose.socket.destroy();
  });

  it("bounds messages queued from upgrade head before a listener exists", () => {
    const head = Buffer.concat(Array.from(
      { length: 129 },
      () => clientFrame(0x1, ""),
    ));
    const result = upgrade({}, head);
    expect(result.connection?.open).toBe(false);
    expect(closeCode(result.socket)).toBe(1009);
    result.socket.destroy();
  });

  it("closes when outbound buffering reaches its hard bound", () => {
    const socket = new TestDuplex();
    // Complete the HTTP handshake write, then simulate a peer that stops
    // consuming all WebSocket frames.
    socket.blockAfter = 1;
    const result = upgrade({ maxMessageBytes: 1024 }, Buffer.alloc(0), socket);
    result.connection?.onMessage(() => {});
    for (let index = 0; index < 100 && result.connection?.open; index++) {
      result.connection.sendText("x".repeat(1000));
    }
    expect(result.connection?.open).toBe(false);
    expect(socket.writableLength).toBeLessThan(66 * 1024);
    socket.destroy();
  });

  it("force-destroys a half-open peer after sending close", async () => {
    vi.useFakeTimers();
    const result = upgrade();
    result.connection?.onMessage(() => {});
    result.connection?.close(1001, "server shutdown");
    expect(result.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.socket.destroyed).toBe(true);
  });

  it("times out an incomplete frame without resetting on partial input", async () => {
    const result = upgrade({ incompleteFrameTimeoutMs: 5 });
    result.connection?.onMessage(() => {});
    result.socket.receive(Buffer.from([0x81]));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(result.connection?.open).toBe(false);
    expect(closeCode(result.socket)).toBe(1002);
    result.socket.destroy();
  });

  it("contains message-handler exceptions and returns close 1011", () => {
    const result = upgrade({
      onConnection(connection) {
        connection.onMessage(() => { throw new Error("handler failed"); });
      },
    });
    result.socket.receive(clientFrame(0x1, "hello"));
    expect(result.connection?.open).toBe(false);
    expect(closeCode(result.socket)).toBe(1011);
    result.socket.destroy();
  });

  it("validates the HTTP method and WebSocket key and fails closed on auth errors", () => {
    const invalidMethod = upgrade({}, Buffer.alloc(0), new TestDuplex(), request({ method: "POST" }));
    expect(invalidMethod.connection).toBeUndefined();
    expect(Buffer.concat(invalidMethod.socket.writes).toString()).toContain("400 Bad Request");

    const invalidKeyRequest = request();
    invalidKeyRequest.headers["sec-websocket-key"] = "not-base64";
    const invalidKey = upgrade({}, Buffer.alloc(0), new TestDuplex(), invalidKeyRequest);
    expect(invalidKey.connection).toBeUndefined();
    expect(Buffer.concat(invalidKey.socket.writes).toString()).toContain("400 Bad Request");

    const authError = upgrade({ authorizeRequest: () => { throw new Error("auth backend failed"); } });
    expect(authError.connection).toBeUndefined();
    expect(Buffer.concat(authError.socket.writes).toString()).toContain("403 Forbidden");
  });

  it("never truncates an outbound close reason into invalid UTF-8", () => {
    const result = upgrade();
    result.connection?.onMessage(() => {});
    result.connection?.close(1000, "😀".repeat(100));
    const close = result.socket.writes.findLast((wire) => wire[0] === 0x88)!;
    const payloadLength = close[1]! & 0x7f;
    expect(payloadLength).toBeLessThanOrEqual(125);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(close.subarray(4, 2 + payloadLength))).not.toThrow();
    result.socket.destroy();
  });
});

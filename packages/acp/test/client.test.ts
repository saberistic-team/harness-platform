import { describe, expect, it } from "vitest";
import { createEvent } from "@harness/events";
import {
  ACP_PROTOCOL_VERSION,
  AcpClient,
  AcpClientError,
  AcpRemoteError,
  type AcpWebSocket,
} from "../src";

type Listener = (event: { data?: unknown; error?: unknown }) => void;

class FakeSocket implements AcpWebSocket {
  readyState = 0;
  sent: string[] = [];
  closeCount = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(autoOpen = true) {
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount++;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  receiveData(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { data?: unknown; error?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("AcpClient", () => {
  it("correlates validated responses and streams decoded events", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", {
      webSocketFactory: () => socket,
      requestTimeoutMs: 100,
    });
    const events: string[] = [];
    client.onEvent(({ event }) => events.push(event.type));

    const initialized = client.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientName: "test",
      capabilities: { streaming: true },
    });
    const request = JSON.parse(socket.sent[0]!) as { id: string };
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentName: "harness",
        capabilities: { streaming: true, permissioning: true, sessions: false },
        models: ["fake-model/v1"],
      },
    });
    await expect(initialized).resolves.toMatchObject({ agentName: "harness" });

    socket.receive({
      jsonrpc: "2.0",
      method: "session/event",
      params: {
        sessionId: "s1",
        seq: 0,
        event: createEvent("session.created", { sessionId: "s1" }),
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(["session.created"]);
    client.close();
  });

  it("surfaces JSON-RPC failures as typed remote errors", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    const pending = client.newSession({ workspace: "." });
    const request = JSON.parse(socket.sent[0]!) as { id: string };
    socket.receive({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32010, message: "missing" },
    });
    await expect(pending).rejects.toBeInstanceOf(AcpRemoteError);
    client.close();
  });

  it("closes an in-flight socket when connection setup is canceled", async () => {
    const socket = new FakeSocket(false);
    const abort = new AbortController();
    const pending = AcpClient.connect("ws://test", {
      webSocketFactory: () => socket,
      connectTimeoutMs: 1_000,
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({
      code: "ACP_TRANSPORT_CLOSED",
    });
    expect(socket.closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("connects when a custom factory returns an already-open socket", async () => {
    const socket = new FakeSocket(false);
    socket.readyState = 1;
    const client = await AcpClient.connect("ws://test", {
      webSocketFactory: () => socket,
      connectTimeoutMs: 100,
    });
    client.close();
    expect(socket.closeCount).toBe(1);
  });

  it("serializes inbound handling to preserve event order", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    const events: number[] = [];
    client.onEvent(({ seq }) => events.push(seq));
    const event = (seq: number) => JSON.stringify({
      jsonrpc: "2.0",
      method: "session/event",
      params: {
        sessionId: "s1",
        seq,
        event: createEvent("session.created", { sessionId: "s1" }),
      },
    });
    socket.receiveData(event(0));
    socket.receiveData(event(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual([0, 1]);
    client.close();
  });

  it("isolates event listener exceptions from other listeners and responses", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    const events: string[] = [];
    client.onEvent(() => { throw new Error("consumer bug"); });
    client.onEvent(({ event }) => events.push(event.type));
    socket.receive({
      jsonrpc: "2.0",
      method: "session/event",
      params: {
        sessionId: "s1",
        seq: 0,
        event: createEvent("session.created", { sessionId: "s1" }),
      },
    });
    const pending = client.cancelSession({ sessionId: "s1" });
    const request = JSON.parse(socket.sent[0]!) as { id: string };
    socket.receive({ jsonrpc: "2.0", id: request.id, result: { canceled: true } });
    await expect(pending).resolves.toEqual({ canceled: true });
    expect(events).toEqual(["session.created"]);
    client.close();
  });

  it("closes and rejects pending work when a server sends a request", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    const pending = client.cancelSession({ sessionId: "s1" });
    socket.receive({
      jsonrpc: "2.0",
      id: "server-request",
      method: "initialize",
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "bad-server",
        capabilities: {},
      },
    });
    await expect(pending).rejects.toMatchObject({ code: "ACP_INVALID_RESPONSE" });
    expect(socket.closeCount).toBe(1);
    await expect(client.cancelSession({ sessionId: "s1" })).rejects.toMatchObject({
      code: "ACP_TRANSPORT_CLOSED",
    });
  });

  it("bounds pending requests and outbound message bytes", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", {
      webSocketFactory: () => socket,
      maxPendingRequests: 1,
      maxMessageBytes: 256,
    });
    const first = client.cancelSession({ sessionId: "s1" });
    await expect(client.cancelSession({ sessionId: "s2" })).rejects.toMatchObject({
      code: "ACP_TRANSPORT_ERROR",
    });
    const request = JSON.parse(socket.sent[0]!) as { id: string };
    socket.receive({ jsonrpc: "2.0", id: request.id, result: { canceled: false } });
    await expect(first).resolves.toEqual({ canceled: false });
    await expect(client.prompt({ sessionId: "s1", content: "x".repeat(300) })).rejects.toMatchObject({
      code: "ACP_TRANSPORT_ERROR",
    });
    expect(socket.sent).toHaveLength(1);
    client.close();
  });

  it("wraps custom factory failures as typed transport errors", async () => {
    await expect(AcpClient.connect("ws://test", {
      webSocketFactory: () => { throw new Error("boom"); },
    })).rejects.toBeInstanceOf(AcpClientError);
  });

  it("treats the connection signal as a lifetime cancellation", async () => {
    const socket = new FakeSocket();
    const abort = new AbortController();
    const client = await AcpClient.connect("ws://test", {
      webSocketFactory: () => socket,
      signal: abort.signal,
    });
    abort.abort();
    expect(socket.closeCount).toBe(1);
    await expect(client.cancelSession({ sessionId: "s1" })).rejects.toMatchObject({
      code: "ACP_TRANSPORT_CLOSED",
    });
  });

  it("bounds messages waiting in the inbound dispatch queue", async () => {
    const socket = new FakeSocket();
    await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    for (let index = 0; index < 129; index++) socket.receiveData("{}");
    expect(socket.closeCount).toBe(1);
  });

  it("rejects binary WebSocket frames instead of decoding them as ACP JSON", async () => {
    const socket = new FakeSocket();
    const client = await AcpClient.connect("ws://test", { webSocketFactory: () => socket });
    const pending = client.cancelSession({ sessionId: "s1" });
    socket.receiveData(Buffer.from("{}"));
    await expect(pending).rejects.toMatchObject({ code: "ACP_INVALID_RESPONSE" });
    expect(socket.closeCount).toBe(1);
  });
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentConnection,
  validateAgentAdvertisement,
  type AgentConnectionOptions,
} from "./connection";
import { attachWebSocketServer, type WebSocketConnection } from "./websocket";

export interface AgentServerOptions extends AgentConnectionOptions {
  host?: string;
  port?: number;
  path?: string;
  maxMessageBytes?: number;
  /** Required when binding beyond loopback; supplied as `?token=` on ACP URL. */
  authToken?: string;
  /**
   * Explicitly permits the service's plaintext `ws://` listener beyond
   * loopback. Only use this on a trusted hop behind a TLS-terminating reverse
   * proxy; this service does not terminate TLS itself.
   */
  allowPlaintextRemote?: boolean;
  /** Browser origins are denied by default, including on loopback. */
  allowedOrigins?: readonly string[];
  /** Deployment-owned path that must exist before readiness succeeds. */
  readinessPath?: string;
}

export interface RunningAgentServer {
  readonly httpServer: Server;
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startAgentServer(options: AgentServerOptions): Promise<RunningAgentServer> {
  // Reject wire-incompatible identities and registries before opening a port.
  validateAgentAdvertisement(options);
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8765;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !options.authToken?.trim()) {
    throw new Error("a non-loopback agent server requires authToken");
  }
  if (!loopback && options.allowPlaintextRemote !== true) {
    throw new Error(
      "a non-loopback agent server requires allowPlaintextRemote: true; " +
      "the plaintext ws:// listener is only intended for a trusted hop behind a TLS reverse proxy",
    );
  }
  const connections = new Map<AgentConnection, WebSocketConnection>();
  const draining = new Set<Promise<void>>();
  const drainStarted = new WeakSet<AgentConnection>();
  const activeSessionIds = new Set<string>();
  const beginDrain = (connection: AgentConnection): void => {
    if (drainStarted.has(connection)) return;
    drainStarted.add(connection);
    connection.close();
    let drain!: Promise<void>;
    drain = connection.waitForIdle()
      // A disconnected client has no response channel for a close failure.
      // Keep it tracked for shutdown without creating an unhandled rejection.
      .catch(() => {})
      .finally(() => draining.delete(drain));
    draining.add(drain);
  };
  let readinessInFlight: Promise<boolean> | undefined;
  let readinessCache: { ready: boolean; expiresAt: number } | undefined;
  const readinessPath = options.readinessPath === undefined
    ? undefined
    : resolve(options.workspaceRoot ?? process.cwd(), options.readinessPath);
  const ready = (): Promise<boolean> => {
    const now = Date.now();
    if (readinessCache && readinessCache.expiresAt > now) {
      return Promise.resolve(readinessCache.ready);
    }
    if (readinessInFlight) return readinessInFlight;
    const check = (async () => {
      try {
        if (options.sessionStore) await options.sessionStore.currentTime();
        if (readinessPath) await access(readinessPath);
        readinessCache = { ready: true, expiresAt: Date.now() + 1_000 };
        return true;
      } catch {
        readinessCache = { ready: false, expiresAt: Date.now() + 1_000 };
        return false;
      }
    })();
    readinessInFlight = check;
    void check.finally(() => {
      if (readinessInFlight === check) readinessInFlight = undefined;
    });
    return check;
  };
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url === "/health" || request.url === "/health/live")
    ) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "agent-server", live: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      void ready().then((isReady) => {
        response.writeHead(isReady ? 200 : 503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(isReady
          ? { service: "agent-server", ready: true }
          : { error: { code: "AGENT_NOT_READY", message: "agent server is not ready" } }));
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
  });

  attachWebSocketServer(server, {
    path: options.path ?? "/acp",
    maxMessageBytes: options.maxMessageBytes,
    allowedOrigins: options.allowedOrigins,
    authorizeRequest(request) {
      if (!options.authToken) return true;
      const supplied = new URL(request.url ?? "/", "http://localhost").searchParams.get("token");
      if (!supplied) return false;
      const expectedBytes = Buffer.from(options.authToken);
      const suppliedBytes = Buffer.from(supplied);
      return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
    },
    onConnection(socket) {
      const connection = new AgentConnection(
        (wire) => socket.sendText(wire),
        { ...options, activeSessionIds },
      );
      connections.set(connection, socket);
      socket.onMessage((wire) => connection.receive(wire));
      socket.onClose(() => {
        connections.delete(connection);
        beginDrain(connection);
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });
  const address = server.address() as AddressInfo;
  const path = options.path ?? "/acp";
  let closePromise: Promise<void> | undefined;
  return {
    httpServer: server,
    url: `ws://${host.includes(":") ? `[${host}]` : host}:${address.port}${path}`,
    host,
    port: address.port,
    close() {
      closePromise ??= (async () => {
        // Stop accepting upgrades before taking the drain snapshot.
        const httpClosed = new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
        const connectionSnapshot = [...connections];
        for (const [connection, socket] of connectionSnapshot) {
          beginDrain(connection);
          socket.close(1001, "server shutting down");
        }
        await Promise.allSettled([...draining]);
        connections.clear();
        await httpClosed;
      })();
      return closePromise;
    },
  };
}

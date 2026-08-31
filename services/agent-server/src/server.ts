import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
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
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ service: "agent-server", ready: true }));
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
      const connection = new AgentConnection((wire) => socket.sendText(wire), options);
      connections.set(connection, socket);
      socket.onMessage((wire) => connection.receive(wire));
      socket.onClose(() => {
        connection.close();
        connections.delete(connection);
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
    url: `ws://${host}:${address.port}${path}`,
    host,
    port: address.port,
    close() {
      closePromise ??= (async () => {
        // Stop accepting upgrades before taking the drain snapshot.
        const httpClosed = new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
        const draining = [...connections];
        for (const [connection, socket] of draining) {
          connection.close();
          socket.close(1001, "server shutting down");
        }
        await Promise.allSettled(
          draining.map(([connection]) => connection.waitForIdle()),
        );
        connections.clear();
        await httpClosed;
      })();
      return closePromise;
    },
  };
}

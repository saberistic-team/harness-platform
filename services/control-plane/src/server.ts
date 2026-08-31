import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "./artifacts";
import { AuditExporter } from "./audit";
import { ControlPlaneError } from "./errors";
import { Scheduler } from "./scheduler";
import type { ArtifactKind, RunRecord, TerminalRunState } from "./types";
import { defaultId, requireId, requireInteger, sha256Hex } from "./util";

export interface ControlPlaneHttpOptions {
  scheduler: Scheduler;
  artifacts: ArtifactRegistry;
  audit?: AuditExporter;
  host?: string;
  port?: number;
  authToken?: string;
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  maxRequestsPerSocket?: number;
  maxConnections?: number;
  maxInFlightRequests?: number;
  readinessCacheMs?: number;
  backgroundReady?: () => void | Promise<void>;
  newId?: (prefix: string) => string;
}

export interface RunningControlPlaneServer {
  readonly httpServer: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "request body must be a JSON object");
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ControlPlaneError("CP_INVALID_INPUT", `${name} must be a string`);
  return value;
}

function exactBodyKeys(body: JsonRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "request body contains unknown fields");
  }
}

function exactQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "request URL contains unknown query parameters");
    }
  }
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "query parameters must be singular");
    }
  }
}

function idempotencyKey(request: IncomingMessage, body: JsonRecord): string {
  const header = request.headers["idempotency-key"];
  if (Array.isArray(header)) throw new ControlPlaneError("CP_INVALID_INPUT", "idempotency-key must be singular");
  const headerKey = header === undefined ? undefined : requireId(header, "idempotency key");
  const bodyKey = body.idempotencyKey === undefined
    ? undefined
    : requireId(body.idempotencyKey, "idempotency key");
  if (headerKey !== undefined && bodyKey !== undefined && headerKey !== bodyKey) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "header and body idempotency keys must match");
  }
  return headerKey ?? bodyKey ?? requireId(undefined, "idempotency key");
}

function base64(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "contentBase64 must be canonical base64");
  }
  return Buffer.from(value, "base64");
}

async function readJson(request: IncomingMessage, maximum: number): Promise<JsonRecord> {
  const encoding = request.headers["content-encoding"];
  if (encoding !== undefined && encoding !== "identity") {
    throw new ControlPlaneError("CP_UNSUPPORTED_MEDIA_TYPE", "compressed request bodies are not accepted");
  }
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ControlPlaneError("CP_UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "content-length is invalid");
    }
    if (parsed > maximum) throw new ControlPlaneError("CP_PAYLOAD_TOO_LARGE", "request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.length;
    if (size > maximum) {
      request.resume();
      throw new ControlPlaneError("CP_PAYLOAD_TOO_LARGE", "request body is too large");
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ControlPlaneError("CP_INVALID_INPUT", "request body is required");
  try {
    return record(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError("CP_INVALID_INPUT", "request body is not valid JSON", { cause: error });
  }
}

function responseHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  };
}

function sendJson(response: ServerResponse, requestId: string, status: number, body: unknown): void {
  const wire = JSON.stringify(body);
  response.writeHead(status, {
    ...responseHeaders(requestId),
    "content-length": String(Buffer.byteLength(wire)),
  });
  response.end(wire);
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    throw new ControlPlaneError("CP_INVALID_INPUT", "request path is invalid");
  }
}

function terminalState(value: unknown): TerminalRunState {
  if (value !== "passed" && value !== "failed" && value !== "blocked" && value !== "canceled") {
    throw new ControlPlaneError("CP_INVALID_INPUT", "status must be passed, failed, blocked, or canceled");
  }
  return value;
}

function artifactKind(value: unknown): ArtifactKind {
  if (value !== "run_report" && value !== "output" && value !== "audit") {
    throw new ControlPlaneError("CP_INVALID_INPUT", "artifact kind is invalid");
  }
  return value;
}

function reconciliationAction(value: unknown): "retry" | "cancel" {
  if (value !== "retry" && value !== "cancel") {
    throw new ControlPlaneError("CP_INVALID_INPUT", "invalid reconciliation action");
  }
  return value;
}

function leaseBody(body: JsonRecord, runId: string) {
  return {
    runId,
    workerId: requireId(body.workerId, "workerId"),
    leaseId: requireId(body.leaseId, "leaseId"),
    fencingToken: requireInteger(body.fencingToken, "fencingToken", 1, Number.MAX_SAFE_INTEGER),
  };
}

function publicRun(run: RunRecord): JsonRecord {
  const result: JsonRecord = { ...run };
  delete result.leaseId;
  delete result.fencingToken;
  return result;
}

export function createControlPlaneHandler(options: ControlPlaneHttpOptions) {
  const maxRequestBytes = requireInteger(
    options.maxRequestBytes ?? 24 * 1024 * 1024,
    "maxRequestBytes",
    1_024,
    64 * 1024 * 1024,
  );
  const readinessCacheMs = requireInteger(
    options.readinessCacheMs ?? 1_000,
    "readinessCacheMs",
    1,
    60_000,
  );
  const maxInFlightRequests = requireInteger(
    options.maxInFlightRequests ?? 256,
    "maxInFlightRequests",
    1,
    10_000,
  );
  const newId = options.newId ?? defaultId;
  let readinessCache: { ready: boolean; expiresAt: number } | undefined;
  let readinessInFlight: Promise<boolean> | undefined;
  let inFlightRequests = 0;

  const ready = async (): Promise<boolean> => {
    const now = Date.now();
    if (readinessCache !== undefined && now < readinessCache.expiresAt) {
      return readinessCache.ready;
    }
    if (readinessInFlight !== undefined) return readinessInFlight;
    const check = (async () => {
      try {
        await Promise.all([options.scheduler.ready(), options.artifacts.ready()]);
        readinessCache = { ready: true, expiresAt: Date.now() + readinessCacheMs };
        return true;
      } catch {
        readinessCache = { ready: false, expiresAt: Date.now() + readinessCacheMs };
        return false;
      }
    })();
    readinessInFlight = check;
    try {
      return await check;
    } finally {
      if (readinessInFlight === check) readinessInFlight = undefined;
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = newId("http");
    let admitted = false;
    try {
      if (inFlightRequests >= maxInFlightRequests) {
        request.resume();
        sendJson(response, requestId, 503, {
          error: { code: "CP_NOT_READY", message: "control plane is busy" },
        });
        return;
      }
      inFlightRequests += 1;
      admitted = true;
      if ((request.url?.length ?? 0) > 8_192) {
        throw new ControlPlaneError("CP_INVALID_INPUT", "request URL is too long");
      }
      const url = new URL(request.url ?? "/", "http://control-plane.invalid");
      const path = decodePath(url.pathname);
      const method = request.method ?? "GET";

      if (method === "GET" && (path === "/health" || path === "/health/live")) {
        exactQueryKeys(url, []);
        sendJson(response, requestId, 200, { service: "control-plane", version: "0.4.0", live: true });
        return;
      }
      if (method === "GET" && path === "/health/ready") {
        exactQueryKeys(url, []);
        let backgroundHealthy = true;
        try {
          await options.backgroundReady?.();
        } catch {
          backgroundHealthy = false;
        }
        if (backgroundHealthy && await ready()) {
          sendJson(response, requestId, 200, { service: "control-plane", ready: true });
        } else {
          sendJson(response, requestId, 503, { error: { code: "CP_NOT_READY", message: "control plane is not ready" } });
        }
        return;
      }
      if (!authorized(request, options.authToken)) {
        sendJson(response, requestId, 401, { error: { code: "CP_UNAUTHORIZED", message: "unauthorized" } });
        return;
      }
      if (method === "POST" && path === "/v1/tasks") {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, ["manifest", "idempotencyKey"]);
        const result = await options.scheduler.admitTask(body.manifest, idempotencyKey(request, body));
        sendJson(response, requestId, result.created ? 201 : 200, { data: result.task, created: result.created });
        return;
      }
      if (method === "GET" && path === "/v1/tasks") {
        exactQueryKeys(url, ["limit"]);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        sendJson(response, requestId, 200, { data: await options.scheduler.listTasks(limit) });
        return;
      }
      const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/u);
      if (method === "GET" && taskMatch?.[1]) {
        exactQueryKeys(url, []);
        sendJson(response, requestId, 200, { data: await options.scheduler.getTask(requireId(taskMatch[1], "taskId")) });
        return;
      }

      if (method === "POST" && path === "/v1/runs") {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, ["taskId", "idempotencyKey", "runId", "priority"]);
        const result = await options.scheduler.scheduleRun({
          taskId: requireId(body.taskId, "taskId"),
          admissionKey: idempotencyKey(request, body),
          ...(body.runId === undefined ? {} : { runId: requireId(body.runId, "runId") }),
          ...(body.priority === undefined ? {} : { priority: requireInteger(body.priority, "priority", -1_000, 1_000) }),
        });
        sendJson(response, requestId, result.created ? 201 : 200, { data: result.run, created: result.created });
        return;
      }
      if (method === "GET" && path === "/v1/runs") {
        exactQueryKeys(url, ["taskId", "limit"]);
        const taskId = url.searchParams.get("taskId") ?? undefined;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
        const runs = await options.scheduler.listRuns({ taskId, limit });
        sendJson(response, requestId, 200, { data: runs.map(publicRun) });
        return;
      }
      if (method === "POST" && path === "/v1/runs/claim") {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, ["workerId", "leaseMs"]);
        const run = await options.scheduler.claimRun(
          requireId(body.workerId, "workerId"),
          body.leaseMs === undefined ? undefined : requireInteger(body.leaseMs, "leaseMs", 1_000, 24 * 60 * 60_000),
        );
        sendJson(response, requestId, 200, { data: run ?? null });
        return;
      }
      const runMatch = path.match(/^\/v1\/runs\/([^/]+)$/u);
      if (method === "GET" && runMatch?.[1]) {
        exactQueryKeys(url, []);
        const runId = requireId(runMatch[1], "runId");
        sendJson(response, requestId, 200, { data: publicRun(await options.scheduler.getRun(runId)) });
        return;
      }
      const operatorAction = path.match(/^\/v1\/runs\/([^/]+)\/(cancel|reconcile)$/u);
      if (method === "POST" && operatorAction?.[1] && operatorAction[2]) {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        const runId = requireId(operatorAction[1], "runId");
        exactBodyKeys(body, operatorAction[2] === "cancel"
          ? ["expectedVersion", "note"]
          : ["expectedVersion", "action", "note"]);
        const expectedVersion = requireInteger(
          body.expectedVersion,
          "expectedVersion",
          1,
          Number.MAX_SAFE_INTEGER,
        );
        const note = body.note === undefined ? undefined : stringValue(body.note, "note");
        let run: RunRecord;
        if (operatorAction[2] === "cancel") {
          run = await options.scheduler.cancelRun({
            runId,
            expectedVersion,
            ...(note === undefined ? {} : { note }),
          });
        } else {
          run = await options.scheduler.reconcileRun({
            runId,
            expectedVersion,
            action: reconciliationAction(body.action),
            ...(note === undefined ? {} : { note }),
          });
        }
        sendJson(response, requestId, 200, { data: publicRun(run) });
        return;
      }
      const runAction = path.match(/^\/v1\/runs\/([^/]+)\/(start|heartbeat|complete)$/u);
      if (method === "POST" && runAction?.[1] && runAction[2]) {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, runAction[2] === "start"
          ? ["workerId", "leaseId", "fencingToken"]
          : runAction[2] === "heartbeat"
            ? ["workerId", "leaseId", "fencingToken", "leaseMs"]
            : ["workerId", "leaseId", "fencingToken", "status", "idempotencyKey", "reportPath"]);
        const lease = leaseBody(body, requireId(runAction[1], "runId"));
        const run = runAction[2] === "start"
          ? await options.scheduler.startRun(lease)
          : runAction[2] === "heartbeat"
            ? await options.scheduler.heartbeatRun({
                ...lease,
                ...(body.leaseMs === undefined ? {} : { leaseMs: requireInteger(body.leaseMs, "leaseMs", 1_000, 24 * 60 * 60_000) }),
              })
            : await options.scheduler.completeRun({
                ...lease,
                status: terminalState(body.status),
                completionKey: idempotencyKey(request, body),
                ...(body.reportPath === undefined ? {} : { reportPath: stringValue(body.reportPath, "reportPath") }),
              });
        sendJson(response, requestId, 200, { data: run });
        return;
      }

      if (method === "POST" && path === "/v1/artifacts") {
        exactQueryKeys(url, []);
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, [
          "kind", "contentBase64", "contentType", "artifactId", "taskId", "runId", "sessionId", "idempotencyKey",
        ]);
        const artifactAdmissionKey = idempotencyKey(request, body);
        const result = await options.artifacts.register({
          kind: artifactKind(body.kind),
          body: base64(body.contentBase64),
          contentType: stringValue(body.contentType, "contentType"),
          artifactId: body.artifactId === undefined
            ? `artifact-${sha256Hex(artifactAdmissionKey).slice(0, 48)}`
            : requireId(body.artifactId, "artifactId"),
          ...(body.taskId === undefined ? {} : { taskId: requireId(body.taskId, "taskId") }),
          ...(body.runId === undefined ? {} : { runId: requireId(body.runId, "runId") }),
          ...(body.sessionId === undefined ? {} : { sessionId: requireId(body.sessionId, "sessionId") }),
        });
        sendJson(response, requestId, result.created ? 201 : 200, { data: result.artifact, created: result.created });
        return;
      }
      const artifactMatch = path.match(/^\/v1\/artifacts\/([^/]+)$/u);
      if (method === "GET" && artifactMatch?.[1]) {
        exactQueryKeys(url, []);
        sendJson(response, requestId, 200, { data: await options.artifacts.get(requireId(artifactMatch[1], "artifactId")) });
        return;
      }
      const artifactUrlMatch = path.match(/^\/v1\/artifacts\/([^/]+)\/url$/u);
      if (method === "GET" && artifactUrlMatch?.[1]) {
        exactQueryKeys(url, ["expires"]);
        const expires = url.searchParams.has("expires") ? Number(url.searchParams.get("expires")) : undefined;
        sendJson(response, requestId, 200, {
          data: await options.artifacts.signedGetUrl(requireId(artifactUrlMatch[1], "artifactId"), expires),
        });
        return;
      }

      if (method === "POST" && path === "/v1/audit/export") {
        exactQueryKeys(url, []);
        if (!options.audit) throw new ControlPlaneError("CP_NOT_READY", "audit export is not configured");
        const body = await readJson(request, maxRequestBytes);
        exactBodyKeys(body, ["streamId"]);
        const result = await options.audit.exportNext(requireId(body.streamId ?? "global", "streamId"));
        sendJson(response, requestId, 200, { data: result ?? null });
        return;
      }

      sendJson(response, requestId, 404, { error: { code: "CP_NOT_FOUND", message: "route not found" } });
    } catch (error) {
      const safe = error instanceof ControlPlaneError
        ? error
        : new ControlPlaneError("CP_INTERNAL", "control-plane request failed", { cause: error });
      sendJson(response, requestId, safe.status, { error: { code: safe.code, message: safe.message } });
    } finally {
      if (admitted) inFlightRequests -= 1;
    }
  };
}

export async function startControlPlaneServer(options: ControlPlaneHttpOptions): Promise<RunningControlPlaneServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8780;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !options.authToken) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "a non-loopback control plane requires authToken");
  }
  const server = createServer(createControlPlaneHandler(options));
  server.requestTimeout = requireInteger(options.requestTimeoutMs ?? 30_000, "requestTimeoutMs", 1_000, 300_000);
  server.headersTimeout = requireInteger(options.headersTimeoutMs ?? 10_000, "headersTimeoutMs", 1_000, server.requestTimeout);
  server.maxRequestsPerSocket = requireInteger(options.maxRequestsPerSocket ?? 1_000, "maxRequestsPerSocket", 1, 100_000);
  server.maxConnections = requireInteger(options.maxConnections ?? 256, "maxConnections", 1, 10_000);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, host);
  });
  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | undefined;
  return {
    httpServer: server,
    host,
    port: address.port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}

import { createEvent } from "@harness/events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactRegistry, InMemoryObjectStore } from "../src/artifacts";
import { AuditExporter } from "../src/audit";
import { startControlPlaneRuntime } from "../src/cli";
import { InMemoryControlPlaneRepository } from "../src/memory-repository";
import { Scheduler } from "../src/scheduler";
import { startControlPlaneServer, type RunningControlPlaneServer } from "../src/server";
import type { AuditEventSource } from "../src/types";

const manifest = {
  id: "http-task",
  title: "HTTP task",
  goal: "exercise the API",
  acceptance: ["requests work"],
  allowed_paths: ["services/control-plane/**"],
  permissions: { "fs.read": "allow", network: "deny" },
  delivery: { type: "none" },
};

const running: RunningControlPlaneServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function fixture(maxRequestBytes = 1_048_576) {
  const repository = new InMemoryControlPlaneRepository();
  let id = 0;
  const newId = (prefix: string) => `${prefix}-${++id}`;
  const now = () => "2026-01-01T00:00:00.000Z";
  const scheduler = new Scheduler({ repository, newId, now });
  const artifacts = new ArtifactRegistry({
    repository,
    objectStore: new InMemoryObjectStore(),
    newId,
    now,
  });
  const source: AuditEventSource = {
    async read(_streamId, afterCursor) {
      const events = afterCursor < 0 ? [{
        seq: 0,
        event: createEvent("run.recorded", {
          runId: "evidence-run", taskId: "http-task", status: "passed", reportPath: "report.json",
        }, { at: now(), eventId: "evidence-event" }),
      }] : [];
      return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
    },
  };
  const audit = new AuditExporter({ repository, source, artifacts });
  const server = await startControlPlaneServer({
    scheduler,
    artifacts,
    audit,
    host: "127.0.0.1",
    port: 0,
    authToken: "test-token",
    maxRequestBytes,
    newId,
  });
  running.push(server);
  return server;
}

async function json(response: Response) {
  return JSON.parse(await response.text()) as Record<string, any>;
}

function post(url: string, body: unknown, idempotency?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...(idempotency ? { "idempotency-key": idempotency } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("control-plane HTTP API", () => {
  it("exposes unauthenticated liveness, authenticated readiness, and core workflows", async () => {
    const server = await fixture();
    expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(200);
    expect((await fetch(`${server.url}/v1/tasks`)).status).toBe(401);

    const admittedResponse = await post(`${server.url}/v1/tasks`, { manifest }, "task-http-1");
    expect(admittedResponse.status).toBe(201);
    expect((await json(admittedResponse)).data.taskId).toBe("http-task");
    expect((await post(`${server.url}/v1/tasks`, { manifest }, "task-http-1")).status).toBe(200);

    const scheduledResponse = await post(`${server.url}/v1/runs`, { taskId: "http-task", priority: 4 }, "run-http-1");
    expect(scheduledResponse.status).toBe(201);
    const runId = (await json(scheduledResponse)).data.runId as string;
    const claim = await post(`${server.url}/v1/runs/claim`, { workerId: "worker-http", leaseMs: 10_000 });
    const leased = (await json(claim)).data;
    expect(leased).toMatchObject({ runId, status: "leased", workerId: "worker-http" });
    const identity = {
      workerId: leased.workerId,
      leaseId: leased.leaseId,
      fencingToken: leased.fencingToken,
    };
    expect((await json(await post(`${server.url}/v1/runs/${runId}/start`, identity))).data.status).toBe("running");
    expect((await json(await post(
      `${server.url}/v1/runs/${runId}/complete`,
      { ...identity, status: "passed", reportPath: "reports/result.json" },
      "completion-http-1",
    ))).data.status).toBe("passed");

    const artifactResponse = await post(`${server.url}/v1/artifacts`, {
      kind: "run_report",
      runId,
      taskId: "http-task",
      contentType: "application/json",
      contentBase64: Buffer.from('{"ok":true}').toString("base64"),
    }, "artifact-http-1");
    expect(artifactResponse.status).toBe(201);
    const artifactId = (await json(artifactResponse)).data.artifactId as string;
    const urlResponse = await fetch(`${server.url}/v1/artifacts/${artifactId}/url?expires=60`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect((await json(urlResponse)).data.url).toContain("expires=60");

    const auditResponse = await post(`${server.url}/v1/audit/export`, { streamId: "global" });
    expect((await json(auditResponse)).data).toMatchObject({ fromSeq: 0, toSeq: 0, eventCount: 1 });
  });

  it("returns bounded typed errors for malformed input and oversized bodies", async () => {
    const server = await fixture(1_024);
    const unsupported = await fetch(`${server.url}/v1/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "text/plain" },
      body: "nope",
    });
    expect(unsupported.status).toBe(415);
    expect((await json(unsupported)).error.code).toBe("CP_UNSUPPORTED_MEDIA_TYPE");

    const oversized = await post(
      `${server.url}/v1/tasks`,
      { manifest: { padding: "x".repeat(2_000) }, idempotencyKey: "too-large" },
    );
    expect(oversized.status).toBe(413);
    expect((await json(oversized)).error.code).toBe("CP_PAYLOAD_TOO_LARGE");

    const missingKey = await post(`${server.url}/v1/tasks`, { manifest });
    expect(missingKey.status).toBe(400);
    expect((await json(missingKey)).error.code).toBe("CP_INVALID_INPUT");
  });

  it("rejects unknown body fields, unknown or duplicate query parameters, and conflicting idempotency keys", async () => {
    const server = await fixture();
    const mutationCases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: "/v1/tasks", body: { manifest, idempotencyKey: "strict-task" } },
      { path: "/v1/runs", body: { taskId: "http-task", idempotencyKey: "strict-run" } },
      { path: "/v1/runs/claim", body: { workerId: "strict-worker" } },
      {
        path: "/v1/runs/strict-run/start",
        body: { workerId: "strict-worker", leaseId: "strict-lease", fencingToken: 1 },
      },
      {
        path: "/v1/runs/strict-run/heartbeat",
        body: { workerId: "strict-worker", leaseId: "strict-lease", fencingToken: 1 },
      },
      {
        path: "/v1/runs/strict-run/complete",
        body: {
          workerId: "strict-worker",
          leaseId: "strict-lease",
          fencingToken: 1,
          status: "passed",
          idempotencyKey: "strict-complete",
        },
      },
      { path: "/v1/runs/strict-run/cancel", body: { expectedVersion: 1 } },
      {
        path: "/v1/runs/strict-run/reconcile",
        body: { expectedVersion: 1, action: "retry" },
      },
      {
        path: "/v1/artifacts",
        body: {
          kind: "output",
          contentType: "text/plain",
          contentBase64: Buffer.from("strict").toString("base64"),
          idempotencyKey: "strict-artifact",
        },
      },
      { path: "/v1/audit/export", body: { streamId: "global" } },
    ];
    for (const testCase of mutationCases) {
      const response = await post(`${server.url}${testCase.path}`, { ...testCase.body, unexpected: true });
      expect(response.status, testCase.path).toBe(400);
      expect((await json(response)).error.code, testCase.path).toBe("CP_INVALID_INPUT");
    }

    const queryPaths = [
      "/health/live",
      "/health/ready",
      "/v1/tasks",
      "/v1/tasks/http-task",
      "/v1/runs",
      "/v1/runs/strict-run",
      "/v1/artifacts/strict-artifact",
      "/v1/artifacts/strict-artifact/url",
    ];
    for (const path of queryPaths) {
      const response = await fetch(`${server.url}${path}?unexpected=true`, {
        headers: { authorization: "Bearer test-token" },
      });
      expect(response.status, path).toBe(400);
      expect((await json(response)).error.code, path).toBe("CP_INVALID_INPUT");
    }
    const duplicate = await fetch(`${server.url}/v1/runs?limit=1&limit=2`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(duplicate.status).toBe(400);

    const conflict = await post(
      `${server.url}/v1/tasks`,
      { manifest, idempotencyKey: "body-key" },
      "header-key",
    );
    expect(conflict.status).toBe(400);
    expect((await json(conflict)).error.message).toBe("header and body idempotency keys must match");
    expect((await post(
      `${server.url}/v1/tasks`,
      { manifest, idempotencyKey: "matching-key" },
      "matching-key",
    )).status).toBe(201);
  });

  it("keeps lease credentials in worker responses but redacts them from general run reads", async () => {
    const server = await fixture();
    expect((await post(`${server.url}/v1/tasks`, { manifest }, "redact-task")).status).toBe(201);
    const scheduled = await post(
      `${server.url}/v1/runs`,
      { taskId: "http-task", runId: "redact-run" },
      "redact-run-key",
    );
    expect(scheduled.status).toBe(201);
    const claim = await json(await post(`${server.url}/v1/runs/claim`, { workerId: "redact-worker" }));
    expect(claim.data).toMatchObject({
      runId: "redact-run",
      leaseId: expect.any(String),
      fencingToken: 1,
    });

    const headers = { authorization: "Bearer test-token" };
    const detail = await json(await fetch(`${server.url}/v1/runs/redact-run`, { headers }));
    expect(detail.data).not.toHaveProperty("leaseId");
    expect(detail.data).not.toHaveProperty("fencingToken");
    const list = await json(await fetch(`${server.url}/v1/runs`, { headers }));
    expect(list.data[0]).not.toHaveProperty("leaseId");
    expect(list.data[0]).not.toHaveProperty("fencingToken");

    const invalidRun = await post(`${server.url}/v1/runs/bad%20run/start`, {
      workerId: claim.data.workerId,
      leaseId: claim.data.leaseId,
      fencingToken: claim.data.fencingToken,
    });
    expect(invalidRun.status).toBe(400);
    expect((await json(invalidRun)).error.code).toBe("CP_INVALID_INPUT");
  });

  it("cancels and reconciles runs through strict, credential-free operator routes", async () => {
    const cancelServer = await fixture();
    expect((await post(`${cancelServer.url}/v1/tasks`, { manifest }, "operator-task")).status).toBe(201);
    const scheduled = await json(await post(
      `${cancelServer.url}/v1/runs`,
      { taskId: "http-task", runId: "operator-cancel" },
      "operator-cancel-key",
    ));
    const canceledResponse = await post(`${cancelServer.url}/v1/runs/operator-cancel/cancel`, {
      expectedVersion: scheduled.data.version,
      note: "operator requested cancellation",
    });
    expect(canceledResponse.status).toBe(200);
    const canceled = (await json(canceledResponse)).data;
    expect(canceled).toMatchObject({ runId: "operator-cancel", status: "canceled" });
    expect(canceled).not.toHaveProperty("leaseId");
    expect(canceled).not.toHaveProperty("fencingToken");

    let clock = "2026-01-01T00:00:00.000Z";
    const repository = new InMemoryControlPlaneRepository();
    const scheduler = new Scheduler({ repository, now: () => clock });
    await scheduler.admitTask(manifest, "reconcile-task");
    await scheduler.scheduleRun({
      taskId: "http-task",
      runId: "operator-reconcile",
      admissionKey: "operator-reconcile-key",
    });
    const lease = (await scheduler.claimRun("operator-worker", 1_000))!;
    await scheduler.startRun({
      runId: lease.runId,
      workerId: lease.workerId!,
      leaseId: lease.leaseId!,
      fencingToken: lease.fencingToken,
    });
    clock = "2026-01-01T00:00:02.000Z";
    await scheduler.reapExpiredLeases();
    const indeterminate = await scheduler.getRun("operator-reconcile");
    expect(indeterminate.status).toBe("indeterminate");
    const reconcileServer = await startControlPlaneServer({
      scheduler,
      artifacts: new ArtifactRegistry({ repository, objectStore: new InMemoryObjectStore() }),
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
    });
    running.push(reconcileServer);

    const reconciledResponse = await post(`${reconcileServer.url}/v1/runs/operator-reconcile/reconcile`, {
      expectedVersion: indeterminate.version,
      action: "retry",
      note: "safe to retry",
    });
    expect(reconciledResponse.status).toBe(200);
    const reconciled = (await json(reconciledResponse)).data;
    expect(reconciled).toMatchObject({ runId: "operator-reconcile", status: "queued", attempt: 2 });
    expect(reconciled).not.toHaveProperty("leaseId");
    expect(reconciled).not.toHaveProperty("fencingToken");

    const invalidAction = await post(`${reconcileServer.url}/v1/runs/operator-reconcile/reconcile`, {
      expectedVersion: reconciled.version,
      action: "resume",
    });
    expect(invalidAction.status).toBe(400);
    expect((await json(invalidAction)).error).toMatchObject({
      code: "CP_INVALID_INPUT",
      message: "invalid reconciliation action",
    });
  });

  it("bounds concurrent connections, caches dependency checks, and immediately reflects background health", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const scheduler = new Scheduler({ repository });
    const artifacts = new ArtifactRegistry({ repository, objectStore: new InMemoryObjectStore() });
    const schedulerReady = vi.spyOn(scheduler, "ready");
    const artifactsReady = vi.spyOn(artifacts, "ready");
    let backgroundHealthy = true;
    const server = await startControlPlaneServer({
      scheduler,
      artifacts,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 7,
      readinessCacheMs: 5_000,
      backgroundReady() {
        if (!backgroundHealthy) throw new Error("background failed");
      },
    });
    running.push(server);

    const responses = await Promise.all(Array.from(
      { length: 4 },
      () => fetch(`${server.url}/health/ready`),
    ));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(200);
    expect(schedulerReady).toHaveBeenCalledTimes(1);
    expect(artifactsReady).toHaveBeenCalledTimes(1);
    expect(server.httpServer.maxConnections).toBe(7);
    backgroundHealthy = false;
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(503);
    backgroundHealthy = true;
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(200);
    expect(schedulerReady).toHaveBeenCalledTimes(1);
    expect(artifactsReady).toHaveBeenCalledTimes(1);
  });

  it("caps pipelined in-flight API requests on one socket", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const scheduler = new Scheduler({ repository });
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.spyOn(scheduler, "listTasks").mockImplementation(async () => {
      entered();
      await blocked;
      return [];
    });
    const server = await startControlPlaneServer({
      scheduler,
      artifacts: new ArtifactRegistry({ repository, objectStore: new InMemoryObjectStore() }),
      host: "127.0.0.1",
      port: 0,
      authToken: "test-token",
      maxConnections: 1,
      maxInFlightRequests: 1,
    });
    running.push(server);

    const wire = new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: server.host, port: server.port });
      let response = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(
          "GET /v1/tasks HTTP/1.1\r\nHost: control-plane\r\nAuthorization: Bearer test-token\r\n\r\n" +
          "GET /v1/tasks HTTP/1.1\r\nHost: control-plane\r\nAuthorization: Bearer test-token\r\nConnection: close\r\n\r\n",
        );
      });
      socket.on("data", (chunk: string) => { response += chunk; });
      socket.on("end", () => { resolve(response); });
      socket.on("error", reject);
    });
    await firstEntered;
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await wire).match(/HTTP\/1\.1 \d{3}/gu)).toEqual(["HTTP/1.1 200", "HTTP/1.1 503"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("marks readiness unhealthy on audit failure and recovers after a successful drain", async () => {
    let auditFails = true;
    let reportFailure!: () => void;
    const failureReported = new Promise<void>((resolve) => { reportFailure = resolve; });
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      inMemory: true,
      maxRequestBytes: 1_048_576,
      maxInFlightRequests: 16,
      maxArtifactBytes: 1_048_576,
      defaultLeaseMs: 10_000,
      maxLeaseMs: 60_000,
    }, {
      auditDrainIntervalMs: 10,
      auditDrainMaxPages: 1,
      auditSource: {
        async read(_streamId, afterCursor) {
          if (auditFails) throw new Error("audit unavailable");
          return { events: [], nextCursor: afterCursor };
        },
      },
      onBackgroundError: reportFailure,
    });
    running.push(runtime.server);
    try {
      await failureReported;
      expect((await fetch(`${runtime.server.url}/health/ready`)).status).toBe(503);
      auditFails = false;
      let status = 503;
      for (let attempt = 0; attempt < 50 && status !== 200; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await fetch(`${runtime.server.url}/health/ready`)).status;
      }
      expect(status).toBe(200);
    } finally {
      running.pop();
      await runtime.close();
    }
  });

  it("formats IPv6 listener URLs with brackets", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const server = await startControlPlaneServer({
      scheduler: new Scheduler({ repository }),
      artifacts: new ArtifactRegistry({ repository, objectStore: new InMemoryObjectStore() }),
      host: "::1",
      port: 0,
    });
    running.push(server);
    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/u);
    expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
  });

  it("refuses unauthenticated non-loopback binding", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const scheduler = new Scheduler({ repository });
    const artifacts = new ArtifactRegistry({ repository, objectStore: new InMemoryObjectStore() });
    await expect(startControlPlaneServer({
      scheduler,
      artifacts,
      host: "0.0.0.0",
      port: 0,
    })).rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
  });
});

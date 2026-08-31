import { describe, expect, it } from "vitest";
import type { AnyHarnessEvent } from "@harness/events";
import { ControlPlaneError } from "../src/errors";
import { InMemoryControlPlaneRepository } from "../src/memory-repository";
import { OutboxPublisher } from "../src/outbox";
import { Scheduler } from "../src/scheduler";
import { assertRunTransition, canTransitionRun } from "../src/state";

const manifest = {
  id: "m4-example",
  title: "M4 example",
  goal: "exercise the scheduler",
  acceptance: ["it works"],
  allowed_paths: ["services/control-plane/**"],
  permissions: { "fs.read": "allow" as const, network: "deny" as const },
  budget: { max_tool_calls: 10 },
  delivery: { type: "none" as const },
};

function fixture() {
  const repository = new InMemoryControlPlaneRepository();
  const events: AnyHarnessEvent[] = [];
  let now = "2026-01-01T00:00:00.000Z";
  let id = 0;
  const outbox = new OutboxPublisher({
    repository,
    sink: (event) => { events.push(event); },
    publisherId: "publisher-test",
    now: () => now,
    leaseMs: 1_000,
    retryDelayMs: 1,
  });
  const scheduler = new Scheduler({
    repository,
    outbox,
    now: () => now,
    newId: (prefix) => `${prefix}-${++id}`,
    defaultLeaseMs: 10_000,
    maxLeaseMs: 60_000,
  });
  return {
    repository,
    scheduler,
    events,
    flush: () => outbox.flush(),
    setNow: (value: string) => { now = value; },
  };
}

describe("run state machine", () => {
  it("allows only explicit transitions", () => {
    expect(canTransitionRun("queued", "leased")).toBe(true);
    expect(canTransitionRun("running", "indeterminate")).toBe(true);
    expect(canTransitionRun("passed", "queued")).toBe(false);
    expect(() => assertRunTransition("passed", "running")).toThrow(ControlPlaneError);
  });
});

describe("Scheduler with in-memory repository", () => {
  it("rejects an invalid injected clock before mutating scheduler state", async () => {
    const { repository, scheduler, setNow } = fixture();
    setNow("2026-01-01");
    await expect(scheduler.admitTask(manifest, "task-admission"))
      .rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
    expect(await repository.listTasks({ limit: 10 })).toEqual([]);

    setNow("2026-01-01T00:00:00.000Z");
    await scheduler.admitTask(manifest, "task-admission");
    setNow("not-a-timestamp");
    await expect(scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "run-admission" }))
      .rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
    expect(await repository.listRuns({ limit: 10 })).toEqual([]);
  });

  it("admits manifests and run requests idempotently", async () => {
    const { scheduler, events, flush } = fixture();
    const firstTask = await scheduler.admitTask(manifest, "task-admission-1");
    const retryTask = await scheduler.admitTask({ ...manifest }, "task-admission-1");
    expect(firstTask.created).toBe(true);
    expect(retryTask).toEqual({ task: firstTask.task, created: false });

    const first = await scheduler.scheduleRun({
      taskId: manifest.id,
      admissionKey: "run-admission-1",
      priority: 9,
    });
    const retry = await scheduler.scheduleRun({
      taskId: manifest.id,
      admissionKey: "run-admission-1",
      priority: 9,
    });
    expect(first.created).toBe(true);
    expect(retry).toEqual({ run: first.run, created: false });
    await flush();
    expect(events.filter((event) => event.type === "run.scheduled")).toHaveLength(1);
    expect(events.find((event) => event.type === "run.scheduled")).toMatchObject({
      data: {
        runId: first.run.runId,
        taskId: manifest.id,
        attempt: 1,
        manifestDigest: first.run.manifestDigest,
      },
    });

    await expect(scheduler.admitTask(
      { ...manifest, goal: "changed" },
      "another-task-key",
    )).rejects.toMatchObject({ code: "CP_CONFLICT" });
    await expect(scheduler.scheduleRun({
      taskId: manifest.id,
      admissionKey: "run-admission-1",
      priority: 8,
    })).rejects.toMatchObject({ code: "CP_CONFLICT" });
  });

  it("never leaves a second task idempotency key reusable after an ID collision", async () => {
    const { scheduler } = fixture();
    await scheduler.admitTask(manifest, "original-key");
    await expect(scheduler.admitTask(manifest, "unused-key"))
      .rejects.toMatchObject({ code: "CP_CONFLICT" });
    const other = { ...manifest, id: "m4-other" };
    expect((await scheduler.admitTask(other, "unused-key")).created).toBe(true);
  });

  it("claims with fencing, starts, heartbeats, and completes idempotently", async () => {
    const { scheduler, events, flush, setNow } = fixture();
    await scheduler.admitTask(manifest, "task-admission");
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "run-admission" });
    const lease = await scheduler.claimRun("worker-a", 10_000);
    await flush();
    expect(lease).toMatchObject({ status: "leased", workerId: "worker-a", fencingToken: 1 });
    expect(events.at(-1)).toMatchObject({
      type: "run.leased",
      data: {
        runId: lease!.runId,
        workerId: "worker-a",
        fencingToken: 1,
      },
    });
    const identity = {
      runId: lease!.runId,
      workerId: lease!.workerId!,
      leaseId: lease!.leaseId!,
      fencingToken: lease!.fencingToken,
    };
    expect((await scheduler.startRun(identity)).status).toBe("running");
    setNow("2026-01-01T00:00:05.000Z");
    expect((await scheduler.heartbeatRun({ ...identity, leaseMs: 20_000 })).leaseExpiresAt)
      .toBe("2026-01-01T00:00:25.000Z");
    const completed = await scheduler.completeRun({
      ...identity,
      status: "passed",
      completionKey: "completion-1",
      reportPath: "s3://reports/run.json",
    });
    expect(completed).toMatchObject({ status: "passed", completionKey: "completion-1" });
    expect(completed).not.toHaveProperty("leaseId");
    expect(await scheduler.completeRun({
      ...identity,
      status: "passed",
      completionKey: "completion-1",
      reportPath: "s3://reports/run.json",
    })).toEqual(completed);
    await expect(scheduler.completeRun({
      ...identity,
      status: "failed",
      completionKey: "completion-2",
    })).rejects.toMatchObject({ code: "CP_CONFLICT" });
    await flush();
    expect(events.filter((event) => event.type === "run.updated").map((event) => event.data.change))
      .toEqual(["started", "heartbeat", "completed"]);
    expect(JSON.stringify(events)).not.toContain(lease!.leaseId!);
    expect(JSON.stringify(events)).not.toContain("completion-1");
  });

  it("requeues an unused expired lease but quarantines interrupted running work", async () => {
    const { scheduler, events, flush, setNow } = fixture();
    await scheduler.admitTask(manifest, "task-admission");
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "run-one", priority: 10 });
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "run-two", priority: 0 });
    const first = await scheduler.claimRun("worker-a", 1_000);
    setNow("2026-01-01T00:00:02.000Z");
    const secondLease = await scheduler.claimRun("worker-b", 10_000);
    expect(secondLease).toMatchObject({ runId: first!.runId, attempt: 2, fencingToken: 2 });
    await scheduler.startRun({
      runId: secondLease!.runId,
      workerId: secondLease!.workerId!,
      leaseId: secondLease!.leaseId!,
      fencingToken: secondLease!.fencingToken,
    });
    setNow("2026-01-01T00:00:20.000Z");
    const expired = await scheduler.reapExpiredLeases();
    expect(expired.indeterminate).toHaveLength(1);
    expect(expired.indeterminate[0]).toMatchObject({ runId: first!.runId, status: "indeterminate" });
    const next = await scheduler.claimRun("worker-c", 10_000);
    expect(next?.runId).not.toBe(first!.runId);
    await flush();
    expect(events.filter((event) => event.type === "run.updated").map((event) => event.data.change))
      .toEqual(expect.arrayContaining(["lease_expired_requeued", "lease_expired_indeterminate"]));
  });

  it("cancels and reconciles with optimistic version checks", async () => {
    const { scheduler, flush, events, setNow } = fixture();
    await scheduler.admitTask(manifest, "task-admission");
    const cancelable = (await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "cancel" })).run;
    const canceled = await scheduler.cancelRun({
      runId: cancelable.runId,
      expectedVersion: cancelable.version,
      note: "operator stop",
    });
    expect(canceled.status).toBe("canceled");
    await expect(scheduler.cancelRun({ runId: cancelable.runId, expectedVersion: cancelable.version }))
      .rejects.toMatchObject({ code: "CP_CONFLICT" });
    await expect(scheduler.cancelRun({
      runId: cancelable.runId,
      expectedVersion: canceled.version,
      note: "x".repeat(2_001),
    })).rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
    await expect(scheduler.reconcileRun({
      runId: cancelable.runId,
      expectedVersion: canceled.version,
      action: "retry",
      note: "unsafe\nheader",
    })).rejects.toMatchObject({ code: "CP_INVALID_INPUT" });

    const uncertain = (await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "reconcile" })).run;
    const lease = (await scheduler.claimRun("worker-reconcile", 1_000))!;
    expect(lease.runId).toBe(uncertain.runId);
    await scheduler.startRun({
      runId: lease.runId,
      workerId: lease.workerId!,
      leaseId: lease.leaseId!,
      fencingToken: lease.fencingToken,
    });
    setNow("2026-01-01T00:00:02.000Z");
    const [indeterminate] = (await scheduler.reapExpiredLeases()).indeterminate;
    const retried = await scheduler.reconcileRun({
      runId: indeterminate!.runId,
      expectedVersion: indeterminate!.version,
      action: "retry",
      note: "provider confirmed no effect",
    });
    expect(retried).toMatchObject({ status: "queued", attempt: 2 });
    expect(retried).not.toHaveProperty("startedAt");
    setNow("2026-01-01T00:00:03.000Z");
    const retryLease = (await scheduler.claimRun("worker-retry", 10_000))!;
    const restarted = await scheduler.startRun({
      runId: retryLease.runId,
      workerId: retryLease.workerId!,
      leaseId: retryLease.leaseId!,
      fencingToken: retryLease.fencingToken,
    });
    expect(restarted.startedAt).toBe("2026-01-01T00:00:03.000Z");
    await flush();
    expect(events.some((event) => event.type === "run.updated" && event.data.change === "reconciled"))
      .toBe(true);
  });

  it("cancels an unstarted lease and rejects completion keys already used by another run", async () => {
    const { scheduler } = fixture();
    await scheduler.admitTask(manifest, "task-admission");
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "first-run", priority: 10 });
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "second-run", priority: 5 });
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "cancel-run", priority: 0 });

    const first = (await scheduler.claimRun("worker-first", 10_000))!;
    const firstIdentity = {
      runId: first.runId,
      workerId: first.workerId!,
      leaseId: first.leaseId!,
      fencingToken: first.fencingToken,
    };
    await scheduler.startRun(firstIdentity);
    await scheduler.completeRun({
      ...firstIdentity,
      status: "passed",
      completionKey: "shared-completion-key",
    });

    const second = (await scheduler.claimRun("worker-second", 10_000))!;
    const secondIdentity = {
      runId: second.runId,
      workerId: second.workerId!,
      leaseId: second.leaseId!,
      fencingToken: second.fencingToken,
    };
    await scheduler.startRun(secondIdentity);
    await expect(scheduler.completeRun({
      ...secondIdentity,
      status: "passed",
      completionKey: "shared-completion-key",
    })).rejects.toMatchObject({ code: "CP_CONFLICT" });

    const unstarted = (await scheduler.claimRun("worker-cancel", 10_000))!;
    await expect(scheduler.completeRun({
      runId: unstarted.runId,
      workerId: unstarted.workerId!,
      leaseId: unstarted.leaseId!,
      fencingToken: unstarted.fencingToken,
      status: "canceled",
      completionKey: "cancel-before-start",
    })).resolves.toMatchObject({ status: "canceled" });
  });

  it("rejects stale and expired lease mutations", async () => {
    const { scheduler, setNow } = fixture();
    await scheduler.admitTask(manifest, "task-admission");
    await scheduler.scheduleRun({ taskId: manifest.id, admissionKey: "run-one" });
    const lease = (await scheduler.claimRun("worker-a", 1_000))!;
    await expect(scheduler.startRun({
      runId: lease.runId,
      workerId: "worker-b",
      leaseId: lease.leaseId!,
      fencingToken: lease.fencingToken,
    })).rejects.toMatchObject({ code: "CP_STALE_LEASE" });
    setNow("2026-01-01T00:00:01.000Z");
    await expect(scheduler.startRun({
      runId: lease.runId,
      workerId: lease.workerId!,
      leaseId: lease.leaseId!,
      fencingToken: lease.fencingToken,
    })).rejects.toMatchObject({ code: "CP_LEASE_EXPIRED" });
  });
});

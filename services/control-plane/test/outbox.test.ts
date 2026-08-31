import type { AnyHarnessEvent } from "@harness/events";
import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/errors";
import { InMemoryControlPlaneRepository } from "../src/memory-repository";
import { OutboxPublisher } from "../src/outbox";

const manifest = {
  id: "outbox-task",
  title: "Outbox task",
  goal: "exercise durable publication",
  acceptance: ["events arrive"],
  allowed_paths: ["services/control-plane/**"],
  permissions: { "fs.read": "allow" as const, network: "deny" as const },
  delivery: { type: "none" as const },
};

async function admit(repository: InMemoryControlPlaneRepository): Promise<void> {
  await repository.admitTask({
    manifest,
    manifestDigest: "a".repeat(64),
    admissionKey: "admit-outbox-task",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("OutboxPublisher", () => {
  it("retries a sink failure without undoing or failing committed state", async () => {
    const repository = new InMemoryControlPlaneRepository();
    await admit(repository);
    expect(await repository.getTask(manifest.id)).toBeDefined();
    let now = "2026-01-01T00:00:00.000Z";
    let fail = true;
    const delivered: AnyHarnessEvent[] = [];
    const health: string[] = [];
    const publisher = new OutboxPublisher({
      repository,
      publisherId: "publisher-retry",
      now: () => now,
      leaseMs: 1_000,
      retryDelayMs: 10,
      onHealthFailure: () => { health.push("failed"); },
      onHealthRecovery: () => { health.push("recovered"); },
      sink(event) {
        if (fail) throw new Error("sink unavailable");
        delivered.push(event);
      },
    });
    expect(await publisher.flush()).toBe(0);
    expect(delivered).toEqual([]);
    expect(health).toEqual(["failed"]);
    fail = false;
    now = "2026-01-01T00:00:00.020Z";
    expect(await publisher.flush()).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(health).toEqual(["failed", "recovered"]);
    expect(delivered[0]).toMatchObject({ type: "task.updated", data: { taskId: manifest.id } });
    expect(await publisher.flush()).toBe(0);
    await publisher.close();
  });

  it("allows only one publisher to own the ordered head event", async () => {
    const repository = new InMemoryControlPlaneRepository();
    await admit(repository);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const first = new OutboxPublisher({
      repository,
      publisherId: "publisher-one",
      now: () => "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
      sink: async (event) => {
        delivered.push(event.eventId);
        await blocked;
      },
    });
    const second = new OutboxPublisher({
      repository,
      publisherId: "publisher-two",
      now: () => "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
      sink: (event) => { delivered.push(event.eventId); },
    });
    const firstFlush = first.flush();
    await Promise.resolve();
    expect(await second.flush()).toBe(0);
    release();
    expect(await firstFlush).toBe(1);
    expect(delivered).toHaveLength(1);
    await Promise.all([first.close(), second.close()]);
  });

  it("redelivers the same deterministic eventId when acknowledgement is uncertain", async () => {
    class FlakyAckRepository extends InMemoryControlPlaneRepository {
      failAck = true;
      override async markOutboxPublished(input: Parameters<InMemoryControlPlaneRepository["markOutboxPublished"]>[0]) {
        if (this.failAck) {
          this.failAck = false;
          throw new ControlPlaneError("CP_STORAGE_FAILED", "injected acknowledgement failure");
        }
        return super.markOutboxPublished(input);
      }
    }
    const repository = new FlakyAckRepository();
    await admit(repository);
    let now = "2026-01-01T00:00:00.000Z";
    const delivered: string[] = [];
    const publisher = new OutboxPublisher({
      repository,
      publisherId: "publisher-uncertain",
      now: () => now,
      leaseMs: 1_000,
      retryDelayMs: 1,
      sink: (event) => { delivered.push(event.eventId); },
    });
    await expect(publisher.flush()).rejects.toMatchObject({ code: "CP_STORAGE_FAILED" });
    now = "2026-01-01T00:00:02.000Z";
    expect(await publisher.flush()).toBe(1);
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(1);
    await publisher.close();
  });
});

import { createEvent, deserializeEvent, type AnyHarnessEvent } from "@harness/events";
import { describe, expect, it } from "vitest";
import { ArtifactRegistry, InMemoryObjectStore } from "../src/artifacts";
import { AuditExporter, SessionStoreAuditEventSource } from "../src/audit";
import { ControlPlaneError } from "../src/errors";
import { InMemoryControlPlaneRepository } from "../src/memory-repository";
import { OutboxPublisher } from "../src/outbox";
import type { AuditEventPage, AuditEventSource, ObjectPutInput, ObjectPutResult } from "../src/types";

class Events implements AuditEventSource {
  constructor(private readonly values: Array<{ seq: number; event: AnyHarnessEvent }>) {}

  async read(streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage> {
    expect(streamId).toBe("global");
    const events = this.values.filter((item) => item.seq > afterCursor).slice(0, limit);
    return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
  }
}

class CountingStore extends InMemoryObjectStore {
  puts = 0;

  override async putObject(input: ObjectPutInput): Promise<ObjectPutResult> {
    this.puts += 1;
    return super.putObject(input);
  }
}

describe("ArtifactRegistry", () => {
  it("rejects an invalid clock before uploading or registering an artifact", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const store = new CountingStore("artifact-bucket");
    const registry = new ArtifactRegistry({
      repository,
      objectStore: store,
      now: () => "2026-01-01",
    });
    await expect(registry.register({
      artifactId: "artifact-invalid-clock",
      kind: "output",
      body: "hello",
      contentType: "text/plain",
    })).rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
    expect(store.puts).toBe(0);
    expect(await repository.getArtifact("artifact-invalid-clock")).toBeUndefined();
  });

  it("uploads immutable bytes, registers metadata, signs reads, and retries by artifact id", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const store = new InMemoryObjectStore("artifact-bucket");
    const events: AnyHarnessEvent[] = [];
    const outbox = new OutboxPublisher({
      repository,
      sink: (event) => { events.push(event); },
      publisherId: "artifact-publisher",
      now: () => "2026-01-01T00:00:00.000Z",
      leaseMs: 1_000,
      retryDelayMs: 1,
    });
    const registry = new ArtifactRegistry({
      repository,
      objectStore: store,
      outbox,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const input = {
      artifactId: "artifact-1",
      kind: "output" as const,
      body: "hello",
      contentType: "text/plain",
      sessionId: "session-1",
    };
    const first = await registry.register(input);
    const retry = await registry.register(input);
    await outbox.flush();
    expect(first.created).toBe(true);
    expect(retry).toEqual({ artifact: first.artifact, created: false });
    expect(Buffer.from(store.read(first.artifact.key)!)).toEqual(Buffer.from("hello"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "artifact.registered",
      data: {
        artifactId: "artifact-1",
        kind: "output",
        bucket: "artifact-bucket",
        bytes: 5,
        sessionId: "session-1",
      },
    });
    const signed = await registry.signedGetUrl("artifact-1", 60);
    expect(signed.url).toContain("expires=60");

    await expect(registry.register({ ...input, body: "different" }))
      .rejects.toMatchObject({ code: "CP_CONFLICT" });
  });

  it("treats generated creation timestamps as metadata, not artifact identity", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const record = {
      artifactId: "artifact-stable",
      kind: "output" as const,
      bucket: "artifact-bucket",
      key: "objects/stable",
      sha256: "a".repeat(64),
      bytes: 1,
      contentType: "application/octet-stream",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await repository.registerArtifact(record)).toEqual({ record, created: true });
    expect(await repository.registerArtifact({
      ...record,
      createdAt: "2026-01-01T00:00:01.000Z",
    })).toEqual({ record, created: false });
  });
});

describe("AuditExporter", () => {
  it("rejects an invalid source timestamp before uploading audit evidence", async () => {
    const repository = new InMemoryControlPlaneRepository();
    const store = new CountingStore("audit-bucket");
    const artifacts = new ArtifactRegistry({ repository, objectStore: store });
    const event = {
      ...createEvent("session.created", { sessionId: "session-1" }),
      at: "2026-01-01",
    } as AnyHarnessEvent;
    const exporter = new AuditExporter({
      repository,
      source: new Events([{ seq: 0, event }]),
      artifacts,
    });
    await expect(exporter.exportNext("global"))
      .rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
    expect(store.puts).toBe(0);
    expect((await repository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(-1);
  });

  it("preserves the session store's opaque global cursor and gaps", async () => {
    const event = createEvent("session.created", { sessionId: "session-1" });
    const calls: unknown[] = [];
    const source = new SessionStoreAuditEventSource({
      async readAuditEvents(options) {
        calls.push(options);
        return {
          events: [{ globalSeq: 0, event }, { globalSeq: 7, event }],
          nextAfterGlobalSeq: 7,
          hasMore: false,
        };
      },
    });
    await expect(source.read("global", -1, 10)).resolves.toEqual({
      events: [{ seq: 0, event }, { seq: 7, event }],
      nextCursor: 7,
    });
    expect(calls).toEqual([{ limit: 10 }]);
  });

  function auditFixture(repository = new InMemoryControlPlaneRepository(), store = new InMemoryObjectStore("audit-bucket")) {
    const emitted: AnyHarnessEvent[] = [];
    const outbox = new OutboxPublisher({
      repository,
      sink: (event) => { emitted.push(event); },
      publisherId: "audit-publisher",
      now: () => "2099-01-01T00:00:00.000Z",
      leaseMs: 1_000,
      retryDelayMs: 1,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore: store,
      outbox,
      now: () => "2099-01-01T00:00:00.000Z",
    });
    const source = new Events([
      {
        seq: 0,
        event: createEvent("tool.call", {
          callId: "call-1",
          tool: "http",
          input: { authorization: "Bearer top-secret", safe: "yes" },
        }, { at: "2026-01-01T00:00:00.000Z", eventId: "event-1" }),
      },
      {
        // Deliberate global-sequence gap: rolled-back identities are valid.
        seq: 3,
        event: createEvent("run.recorded", {
          runId: "run-1",
          taskId: "task-1",
          status: "passed",
          reportPath: "reports/run-1.json",
        }, { at: "2026-01-01T00:00:03.000Z", eventId: "event-2" }),
      },
    ]);
    const exporter = new AuditExporter({
      repository,
      source,
      artifacts,
      outbox,
    });
    return { repository, store, emitted, exporter, outbox };
  }

  it("writes deterministic redacted JSONL before atomically advancing its opaque cursor", async () => {
    const { repository, store, emitted, exporter, outbox } = auditFixture();
    const result = await exporter.exportNext("global");
    await outbox.flush();
    expect(result).toMatchObject({
      fromSeq: 0,
      toSeq: 3,
      eventCount: 2,
      checkpointNextSeq: 3,
    });
    const wire = Buffer.from(store.read(result!.artifact.key)!).toString("utf8");
    expect(wire.endsWith("\n")).toBe(true);
    expect(wire).not.toContain("top-secret");
    expect(wire).toContain("[REDACTED]");
    const lines = wire.trimEnd().split("\n").map(deserializeEvent);
    expect(lines.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
    expect((await repository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(3);
    expect(emitted.map((event) => event.type)).toEqual(["artifact.registered", "audit.exported"]);
    expect(emitted[1]).toMatchObject({
      data: { fromSeq: 0, toSeq: 3, eventCount: 2, sha256: result!.sha256 },
    });
    expect(await exporter.exportNext("global")).toBeUndefined();
  });

  it("does not advance when object upload fails", async () => {
    class FailingStore extends InMemoryObjectStore {
      override async putObject(_input: ObjectPutInput): Promise<ObjectPutResult> {
        throw new ControlPlaneError("CP_STORAGE_FAILED", "injected object failure");
      }
    }
    const repository = new InMemoryControlPlaneRepository();
    const { exporter } = auditFixture(repository, new FailingStore("audit-bucket"));
    await expect(exporter.exportNext("global")).rejects.toMatchObject({ code: "CP_STORAGE_FAILED" });
    expect((await repository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(-1);
  });

  it("leaves the checkpoint behind after metadata failure and safely retries the uploaded object", async () => {
    class FlakyRepository extends InMemoryControlPlaneRepository {
      fail = true;
      override async commitAuditExport(input: Parameters<InMemoryControlPlaneRepository["commitAuditExport"]>[0]) {
        if (this.fail) throw new ControlPlaneError("CP_STORAGE_FAILED", "injected metadata failure");
        return super.commitAuditExport(input);
      }
    }
    const repository = new FlakyRepository();
    const store = new InMemoryObjectStore("audit-bucket");
    const { exporter } = auditFixture(repository, store);
    await expect(exporter.exportNext("global")).rejects.toMatchObject({ code: "CP_STORAGE_FAILED" });
    expect((await repository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(-1);
    repository.fail = false;
    const result = await exporter.exportNext("global");
    expect(result?.checkpointNextSeq).toBe(3);
    expect(store.read(result!.artifact.key)).toBeDefined();
  });

  it("drains its own bookkeeping tail instead of recursively exporting forever", async () => {
    class MutableStream implements AuditEventSource {
      events: Array<{ seq: number; event: AnyHarnessEvent }> = [{
        seq: 0,
        event: createEvent("run.recorded", {
          runId: "run-1", taskId: "task-1", status: "passed", reportPath: "report.json",
        }, { at: "2026-01-01T00:00:00.000Z", eventId: "seed" }),
      }];
      sink = (event: AnyHarnessEvent) => {
        this.events.push({ seq: this.events.at(-1)!.seq + 1, event });
      };
      async read(_streamId: string, afterCursor: number, limit: number): Promise<AuditEventPage> {
        const events = this.events.filter((item) => item.seq > afterCursor).slice(0, limit);
        return { events, nextCursor: events.at(-1)?.seq ?? afterCursor };
      }
    }
    const stream = new MutableStream();
    const repository = new InMemoryControlPlaneRepository();
    const outbox = new OutboxPublisher({
      repository,
      sink: stream.sink,
      publisherId: "recursive-audit-publisher",
      now: () => "2026-01-01T00:00:10.000Z",
      leaseMs: 1_000,
      retryDelayMs: 1,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore: new InMemoryObjectStore("audit-bucket"),
      outbox,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const exporter = new AuditExporter({ repository, source: stream, artifacts, outbox });
    expect((await exporter.exportNext("global"))?.eventCount).toBe(1);
    await outbox.flush();
    expect(stream.events.map((item) => item.event.type)).toEqual([
      "run.recorded", "artifact.registered", "audit.exported",
    ]);
    expect((await exporter.exportNext("global"))?.eventCount).toBe(0);
    await outbox.flush();
    expect(stream.events).toHaveLength(3);
    expect(await exporter.exportNext("global")).toBeUndefined();
  });

  it("publishes the winner's canonical events once after an idempotent losing response", async () => {
    class LosingRepository extends InMemoryControlPlaneRepository {
      override async commitAuditExport(input: Parameters<InMemoryControlPlaneRepository["commitAuditExport"]>[0]) {
        const winner = await super.commitAuditExport(input);
        return { ...winner, artifact: { ...winner.artifact, created: false }, committed: false };
      }
    }
    const repository = new LosingRepository();
    const emitted: AnyHarnessEvent[] = [];
    const outbox = new OutboxPublisher({
      repository,
      sink: (event) => { emitted.push(event); },
      publisherId: "loser-publisher",
      now: () => "2026-01-01T00:00:10.000Z",
      leaseMs: 1_000,
      retryDelayMs: 1,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore: new InMemoryObjectStore("audit-bucket"),
      outbox,
    });
    const exporter = new AuditExporter({
      repository,
      source: new Events([{
        seq: 0,
        event: createEvent("run.recorded", {
          runId: "run-1", taskId: "task-1", status: "passed", reportPath: "report.json",
        }, { at: "2026-01-01T00:00:00.000Z" }),
      }]),
      artifacts,
      outbox,
    });
    expect((await exporter.exportNext("global"))?.checkpointNextSeq).toBe(0);
    await outbox.flush();
    expect(emitted.map((event) => event.type)).toEqual(["artifact.registered", "audit.exported"]);
  });

  it("halves an oversized multi-event page and rejects one poison event", async () => {
    const events = [0, 1, 2, 3].map((seq) => ({
      seq,
      event: createEvent("tool.result", {
        callId: `call-${seq}`,
        tool: "large-output",
        ok: true,
        output: "x".repeat(220),
      }, { at: `2026-01-01T00:00:0${seq}.000Z`, eventId: `large-${seq}` }),
    }));
    const requested: number[] = [];
    const source: AuditEventSource = {
      async read(_streamId, afterCursor, limit) {
        requested.push(limit);
        const page = events.filter((item) => item.seq > afterCursor).slice(0, limit);
        return { events: page, nextCursor: page.at(-1)?.seq ?? afterCursor };
      },
    };
    const repository = new InMemoryControlPlaneRepository();
    const outbox = new OutboxPublisher({
      repository,
      publisherId: "adaptive-publisher",
      now: () => "2026-01-01T00:00:10.000Z",
      sink: () => {},
      leaseMs: 1_000,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore: new InMemoryObjectStore("audit-bucket"),
      outbox,
    });
    const exporter = new AuditExporter({
      repository,
      source,
      artifacts,
      outbox,
      maxEventsPerExport: 4,
      maxExportBytes: 600,
    });
    expect((await exporter.exportNext("global"))?.eventCount).toBe(1);
    expect(requested).toEqual([4, 2, 1]);

    const poisonRepository = new InMemoryControlPlaneRepository();
    const poisonArtifacts = new ArtifactRegistry({
      repository: poisonRepository,
      objectStore: new InMemoryObjectStore("audit-bucket"),
    });
    const poison = new AuditExporter({
      repository: poisonRepository,
      source: new Events([events[0]!]),
      artifacts: poisonArtifacts,
      maxExportBytes: 100,
    });
    await expect(poison.exportNext("global")).rejects.toMatchObject({ code: "CP_PAYLOAD_TOO_LARGE" });
    expect((await poisonRepository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(-1);
  });

  it("drains only the configured number of pages per background pass", async () => {
    const values = [0, 1, 2].map((seq) => ({
      seq,
      event: createEvent("session.created", { sessionId: `session-${seq}` }, {
        at: `2026-01-01T00:00:0${seq}.000Z`,
        eventId: `event-${seq}`,
      }),
    }));
    const repository = new InMemoryControlPlaneRepository();
    const outbox = new OutboxPublisher({
      repository,
      publisherId: "bounded-drain-publisher",
      now: () => "2026-01-01T00:00:10.000Z",
      sink: () => {},
      leaseMs: 1_000,
    });
    const artifacts = new ArtifactRegistry({
      repository,
      objectStore: new InMemoryObjectStore("audit-bucket"),
      outbox,
    });
    const exporter = new AuditExporter({
      repository,
      source: new Events(values),
      artifacts,
      outbox,
      maxEventsPerExport: 1,
    });
    expect(await exporter.drainAvailable("global", 2)).toHaveLength(2);
    expect((await repository.getAuditCheckpoint("global", "ignored")).nextSeq).toBe(1);
    expect(await exporter.drainAvailable("global", 2)).toHaveLength(1);
  });
});

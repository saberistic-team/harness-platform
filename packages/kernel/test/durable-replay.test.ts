import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteStore, SessionEventStore } from "../../sessions/src";
import { MinimalAgentRuntime, reconstructModelRequest, parseRuntimeCheckpoint, type AgentEvent } from "../src";
import { FakeModel } from "@harness/models";
import { createDevelopmentTools } from "@harness/tools";
import { LocalWorkspace } from "@harness/workspace";
import { writeFileSync } from "node:fs";
const now = () => "2026-01-01T00:00:00.000Z";
async function collect(stream: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const e of stream)
  events.push(e); return events; }
it("M14 SQLite reopen replays stable IDs and recreates exact requests and a follow-up from terminal state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m14-")), db = join(dir, "sessions.db"), root = join(dir, "workspace");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(root);
  writeFileSync(join(root, "x"), "old");
  let store = openSqliteStore(db, { now });
  try {
    await store.createSession({ sessionId: "s", metadata: { ownerId: "owner", leaseExpiresAt: "2026-01-02T00:00:00Z" } });
    const adapter = new SessionEventStore(store, "s", "owner");
    const workspace = new LocalWorkspace({ root, developerOnly: true, allowedPaths: ["x"] });
    const model = new FakeModel([{ toolCalls: [{ id: "read", name: "fs.read", arguments: { path: "x" } }] }, { content: "done" }]);
    const input = { runId: "r", sessionId: "s", turnId: "t", input: "edit", model: "fake", modelAdapter: model, eventStore: adapter, workspace, tools: createDevelopmentTools(root), permission: { decide: () => ({ effect: "allow" as const, reason: "fixture" }) }, system: "Keep constraints", providerOptions: { temperature: 0 }, maxTokens: 100, budget: { maxModelTokens: 10000 } };
    const emitted = await collect(new MinimalAgentRuntime().run(input));
    const modelCheckpoints = emitted.filter(e => e.type === "runtime.checkpoint" && e.data.payload.phase === "model");
    expect(modelCheckpoints).toHaveLength(2);
    for (let i = 0; i < modelCheckpoints.length; i++) {
      const event = modelCheckpoints[i]!;
      if (event.type !== "runtime.checkpoint")
        throw Error();
      const { signal, ...request } = model.requests[i]!;
      expect(JSON.stringify(reconstructModelRequest(event.data.payload))).toBe(JSON.stringify(request));
    }
    const before = await collect(adapter.readSession("s"));
    const checkpoint = await adapter.loadCheckpoint();
    expect(checkpoint!.revision).toBe(5);
    // Any identical old event, including an old checkpoint, is safe to redeliver.
    await adapter.append(before[0]!);
    await adapter.append(modelCheckpoints[0]!);
    expect(await collect(adapter.readSession("s"))).toEqual(before);
    await expect(adapter.append({ ...before[0]!, at: "2026-01-01T00:01:00.000Z" })).rejects.toMatchObject({ code: "SESS_EVENT_CONFLICT" });
    await store.close();
    store = openSqliteStore(db, { now });
    const reopened = new SessionEventStore(store, "s", "owner");
    expect(await collect(reopened.readSession("s"))).toEqual(before);
    expect(await reopened.loadCheckpoint()).toEqual(checkpoint);
    const runtime = new MinimalAgentRuntime();
    await runtime.restoreSession(reopened, "s");
    const follow = new FakeModel([{ content: "followed" }]);
    await collect(runtime.run({ ...input, runId: "r2", turnId: "t2", input: "follow", eventStore: reopened, modelAdapter: follow, system:undefined, providerOptions:undefined, budget:undefined }));
    expect(follow.requests[0]!.system).toBe("Keep constraints");
    expect(follow.requests[0]!.providerOptions).toEqual({temperature:0});
    expect(follow.requests[0]!.messages.slice(-2)).toEqual([{ role: "assistant", content: "done" }, { role: "user", content: "follow" }]);
    expect(follow.requests[0]!.messages.some(m => m.role === "assistant" && m.toolCalls?.[0]?.id === "read")).toBe(true);
    await store.setMetadata("s", { ownerId: "new-owner", leaseExpiresAt: "2026-01-02T00:00:00Z" }, { ownerId: "owner" });
    await expect(reopened.append(before[0]!)).rejects.toMatchObject({ code: "SESS_OWNERSHIP_LOST" });
    await expect(store.saveCheckpoint("s", { expectedRevision: checkpoint!.revision, afterSeq: checkpoint!.afterSeq, payload: checkpoint!.payload, ownerId: "owner" })).rejects.toMatchObject({ code: "SESS_OWNERSHIP_LOST" });
    expect(() => parseRuntimeCheckpoint({ ...checkpoint!.payload as object, version: 99 })).toThrow(expect.objectContaining({ code: "RUNTIME_CHECKPOINT_VERSION" }));
    await workspace.dispose();
  }
  finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("M14 records compaction and original history in restart checkpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m14-context-"));
  const store = openSqliteStore(join(dir, "s.db"), { now });
  try {
    await store.createSession({ sessionId: "s", metadata: { ownerId: "o", leaseExpiresAt: "2026-01-02T00:00:00Z" } });
    const adapter = new SessionEventStore(store, "s", "o");
    const model = new FakeModel([{ content: "summary" }, { content: "done" }]);
    const context = Array.from({ length: 8 }, () => ({ role: "user" as const, content: "x".repeat(400) }));
    const events = await collect(new MinimalAgentRuntime().run({ runId: "r", sessionId: "s", turnId: "t", input: "continue", model: "fake", modelAdapter: model, eventStore: adapter, context, contextPolicy: { windowTokens: 6000, thresholdTokens: 2000, tailMessages: 2, reserveTokens: 100 } }));
    const next = events.find(e => e.type === "runtime.checkpoint" && e.data.payload.phase === "model")!;
    if (next.type !== "runtime.checkpoint")
      throw Error();
    const cp = parseRuntimeCheckpoint(next.data.payload);
    expect(cp.messageState.messages.slice(0, 8)).toEqual(context);
    expect(cp.compaction).toMatchObject({ version: 1, summary: "summary" });
    const { signal, ...expected } = model.requests[1]!;
    expect(JSON.stringify(reconstructModelRequest(cp))).toBe(JSON.stringify(expected));
  }
  finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("M14 rejects future storage checkpoints and refuses to replay interrupted work as a follow-up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m14-version-")), store = openSqliteStore(join(dir, "s.db"), { now });
  try {
    await store.createSession({ sessionId: "s", metadata: { ownerId: "o", leaseExpiresAt: "2026-01-02T00:00:00Z" } });
    const adapter = new SessionEventStore(store, "s", "o");
    await store.saveCheckpoint("s", { ownerId: "o", expectedRevision: 0, afterSeq: -1, payload: { version: 2 } });
    await expect(adapter.loadCheckpoint()).rejects.toMatchObject({ code: "SESS_SCHEMA_VERSION" });
    await expect(new MinimalAgentRuntime().restoreSession(adapter, "s")).rejects.toMatchObject({ code: "SESS_SCHEMA_VERSION" });
    await expect(new MinimalAgentRuntime().restoreSession({ async append() { }, async *readSession() { } }, "empty")).rejects.toMatchObject({ code: "RUNTIME_CHECKPOINT_INTERRUPTED" });
    await expect(store.saveCheckpoint("s", { ownerId: "o", expectedRevision: 0, afterSeq: -1, payload: { version: 1 } })).rejects.toMatchObject({ code: "SESS_CHECKPOINT_CONFLICT" });
  }
  finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

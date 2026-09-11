import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStore, SessionEventStore } from "../../sessions/src";
import { FakeModel } from "@harness/models";
import { MinimalAgentRuntime, type AgentEvent, type EventStore } from "../src";
async function collect(stream: AsyncIterable<AgentEvent>) { const result = []; for await (const e of stream)
    result.push(e); return result; }
it("continues a safe checkpoint after database reopen once, fencing the old owner and competing recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "m15-"));
    let time = "2026-01-01T00:00:00Z";
    const path = join(root, "s.db");
    let store = openSqliteStore(path, { now: () => time });
    try {
        await store.createSession({ sessionId: "s", metadata: { ownerId: "old", leaseExpiresAt: "2026-01-01T00:00:01Z" } });
        const old = new SessionEventStore(store, "s", "old");
        let crashed = false;
        const crash: EventStore = { checkpointVersion: 1, readSession: old.readSession.bind(old), async append(e) {
                if (e.type === "model.request")
                    crashed = true;
                if (crashed)
                    throw Error("process lost");
                await old.append(e);
            } };
        const model = new FakeModel([{ content: "done" }]);
        const input = { runId: "r", sessionId: "s", turnId: "t", input: "work", model: "fake", modelAdapter: model, eventStore: crash };
        await expect(collect(new MinimalAgentRuntime().run(input))).rejects.toThrow();
        expect(model.requests).toHaveLength(0);
        store.close();
        time = "2026-01-01T00:00:02Z";
        store = openSqliteStore(path, { now: () => time });
        const recovered = new SessionEventStore(store, "s", "new");
        const stream = await new MinimalAgentRuntime().continue({ ...input, eventStore: recovered });
        await expect(new MinimalAgentRuntime().continue({ ...input, eventStore: new SessionEventStore(store, "s", "racer") })).rejects.toThrow();
        await collect(stream);
        expect(model.requests).toHaveLength(1);
        const events = await collect(recovered.readSession("s"));
        expect(events.filter(e => e.type === "turn.started")).toHaveLength(1);
        expect(events.filter(e => e.type === "model.request")).toHaveLength(1);
        expect(new Set(events.map(e => e.eventId)).size).toBe(events.length);
        await expect(new SessionEventStore(store, "s", "old").append(events[0]!)).rejects.toMatchObject({ code: "SESS_OWNERSHIP_LOST" });
    }
    finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});
it.each(["model.request", "runtime.checkpoint", "message.delta", "model.response"])("never retries uncertain model work after %s", async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), "m15-"));
    let time = "2026-01-01T00:00:00Z";
    const store = openSqliteStore(join(root, "s.db"), { now: () => time });
    try {
        await store.createSession({ sessionId: "s", metadata: { ownerId: "old", leaseExpiresAt: "2026-01-01T00:00:01Z" } });
        const adapter = new SessionEventStore(store, "s", "old");
        let dead = false;
        const crash: EventStore = { checkpointVersion: 1, readSession: adapter.readSession.bind(adapter), async append(e) {
                if (dead)
                    throw Error("crash");
                await adapter.append(e);
                if (e.type === boundary && (e.type !== "runtime.checkpoint" || e.data.payload.phase === "model")) {
                    dead = true;
                    throw Error("lost acknowledgement");
                }
            } };
        const model = new FakeModel([{ content: "done" }]);
        const input = { runId: "r", sessionId: "s", turnId: "t", input: "work", model: "fake", modelAdapter: model, eventStore: crash };
        await expect(collect(new MinimalAgentRuntime().run(input))).rejects.toThrow();
        const calls = model.requests.length;
        time = "2026-01-01T00:00:02Z";
        await expect(new MinimalAgentRuntime().continue({ ...input, eventStore: new SessionEventStore(store, "s", "new") })).rejects.toThrow();
        expect(model.requests).toHaveLength(calls);
    }
    finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});
it("crash matrix covers both sides of every request, intent, policy, result, and checkpoint append plus tool effects", async () => {
    const { createBoundedTool, ToolRegistry } = await import("@harness/tools");
    const { z } = await import("zod");
    async function scenario(cut: number, after: boolean, effectCrash?: "before" | "after") {
        const root = mkdtempSync(join(tmpdir(), "m15-matrix-"));
        let time = "2026-01-01T00:00:00Z", effects = 0, dead = false, appends = 0;
        let store = openSqliteStore(join(root, "s.db"), { now: () => time });
        try {
            await store.createSession({ sessionId: "s", metadata: { ownerId: "old", leaseExpiresAt: "2026-01-01T00:00:01Z" } });
            const adapter = new SessionEventStore(store, "s", "old");
            const tools = new ToolRegistry([createBoundedTool({ name: "effect", description: "fixture counter", parameters: z.object({}), inputSchema: { type: "object", properties: {} }, execute: () => {
                        if (effectCrash === "before") {
                            dead = true;
                            throw Error("process lost before effect");
                        }
                        effects++;
                        if (effectCrash === "after")
                            dead = true;
                        return { done: true };
                    } }, { kind: "pure" })]);
            const tape = [{ toolCalls: [{ id: "one", name: "effect", arguments: {} }] }, { content: "done" }];
            const model = new FakeModel(tape);
            const input = { runId: "r", sessionId: "s", turnId: "t", input: "work", model: "fake", modelAdapter: model, tools, eventStore: { checkpointVersion: 1 as const, readSession: adapter.readSession.bind(adapter), async append(e: AgentEvent) {
                        if (dead)
                            throw Error("process lost");
                        const index = appends++;
                        if (index === cut && !after) {
                            dead = true;
                            throw Error("before commit");
                        }
                        await adapter.append(e);
                        if (index === cut && after) {
                            dead = true;
                            throw Error("after commit before acknowledgement");
                        }
                    } } };
            try {
                await collect(new MinimalAgentRuntime().run(input));
            }
            catch (error) {
                if (!dead)
                    throw error;
            }
            const before = await collect(adapter.readSession("s"));
            if (!dead)
                return before.length;
            const used = model.requests.length, effectsBefore = effects;
            store.close();
            time = "2026-01-01T00:00:02Z";
            store = openSqliteStore(join(root, "s.db"), { now: () => time });
            const resumed = new SessionEventStore(store, "s", "new");
            const next = new FakeModel(tape.slice(used));
            const latest = before.at(-1);
            if (latest?.type === "runtime.checkpoint" && latest.data.payload.phase === "safe") {
                await collect(await new MinimalAgentRuntime().continue({ ...input, modelAdapter: next, eventStore: resumed }));
                expect(effects).toBe(1);
                expect(used + next.requests.length).toBe(2);
                const all = await collect(resumed.readSession("s"));
                expect(all.filter(e => e.type === "tool.call")).toHaveLength(1);
                expect(all.filter(e => e.type === "turn.started")).toHaveLength(1);
                expect(new Set(all.map(e => e.eventId)).size).toBe(all.length);
            }
            else {
                await expect(new MinimalAgentRuntime().continue({ ...input, modelAdapter: next, eventStore: resumed })).rejects.toThrow();
                expect(next.requests).toHaveLength(0);
                expect(effects).toBe(effectsBefore);
            }
            return before.length;
        }
        finally {
            store.close();
            rmSync(root, { recursive: true, force: true });
        }
    }
    const count = await scenario(-1, false);
    for (let cut = 0; cut < count; cut++) {
        await scenario(cut, false);
        await scenario(cut, true);
    }
    await scenario(-1, false, "before");
    await scenario(-1, false, "after");
});
it("cancellation during safe recovery persists cancellation without requesting the model", async () => {
    const root = mkdtempSync(join(tmpdir(), "m15-cancel-"));
    let time = "2026-01-01T00:00:00Z";
    const store = openSqliteStore(join(root, "s.db"), { now: () => time });
    try {
        await store.createSession({ sessionId: "s", metadata: { ownerId: "old", leaseExpiresAt: "2026-01-01T00:00:01Z" } });
        const adapter = new SessionEventStore(store, "s", "old");
        let dead = false;
        const model = new FakeModel([{ content: "must not run" }]);
        const input = { runId: "r", sessionId: "s", turnId: "t", input: "work", model: "fake", modelAdapter: model, eventStore: { checkpointVersion: 1 as const, readSession: adapter.readSession.bind(adapter), async append(e: AgentEvent) { if (dead)
                    throw Error("crash"); await adapter.append(e); if (e.type === "runtime.checkpoint") {
                    dead = true;
                    throw Error("crash");
                } } } };
        await expect(collect(new MinimalAgentRuntime().run(input))).rejects.toThrow();
        time = "2026-01-01T00:00:02Z";
        const resumed = new SessionEventStore(store, "s", "new"), controller = new AbortController();
        controller.abort();
        await collect(await new MinimalAgentRuntime().continue({ ...input, eventStore: resumed, signal: controller.signal }));
        expect(model.requests).toHaveLength(0);
        expect((await collect(resumed.readSession("s"))).findLast(e => e.type === "turn.completed")).toMatchObject({ data: { status: "canceled" } });
    }
    finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
    }
});
it("an actual SIGKILL after a committed tool round survives process restart without repeating the side effect", async () => {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { counterTools } = await import("./fixtures/continuation-process");
    const root = mkdtempSync(join(tmpdir(), "m15-process-"));
    writeFileSync(join(root, "counter"), "0");
    try {
        const fixture = fileURLToPath(new URL("./fixtures/continuation-process.ts", import.meta.url));
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {crashProcess} from ${JSON.stringify(fixture)}; await crashProcess(${JSON.stringify(root)});`], { encoding: "utf8", timeout: 10000 });
        expect(child.signal, child.stderr).toBe("SIGKILL");
        expect(readFileSync(join(root, "counter"), "utf8")).toBe("1");
        const store = openSqliteStore(join(root, "s.db"), { now: () => "2026-01-01T00:00:02Z" });
        try {
            const adapter = new SessionEventStore(store, "s", "replacement"), model = new FakeModel([{ content: "done" }]);
            await collect(await new MinimalAgentRuntime().continue({ runId: "r", sessionId: "s", turnId: "t", input: "ignored on continuation", model: "fake", modelAdapter: model, tools: counterTools(root), eventStore: adapter }));
            expect(readFileSync(join(root, "counter"), "utf8")).toBe("1");
            expect(model.requests).toHaveLength(1);
            const events = await collect(adapter.readSession("s"));
            expect(events.filter(e => e.type === "tool.call")).toHaveLength(1);
            expect(events.filter(e => e.type === "model.request")).toHaveLength(2);
        }
        finally {
            store.close();
        }
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

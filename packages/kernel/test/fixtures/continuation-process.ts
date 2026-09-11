import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createBoundedTool, ToolRegistry } from "@harness/tools";
import { FakeModel } from "@harness/models";
import { openSqliteStore, SessionEventStore } from "../../../sessions/src";
import { MinimalAgentRuntime, type AgentEvent } from "../../src";
export function counterTools(root: string): ToolRegistry {
    return new ToolRegistry([createBoundedTool({ name: "fixture.counter", description: "Crash-test counter", parameters: z.object({}), inputSchema: { type: "object", properties: {} }, execute: () => {
                const path = join(root, "counter");
                const count = Number(readFileSync(path, "utf8"));
                writeFileSync(path, String(count + 1));
                return { count: count + 1 };
            } }, { kind: "pure" })]);
}
export async function crashProcess(root: string): Promise<void> {
    const store = openSqliteStore(join(root, "s.db"), { now: () => "2026-01-01T00:00:00Z" });
    await store.createSession({ sessionId: "s", metadata: { ownerId: "dead-process", leaseExpiresAt: "2026-01-01T00:00:01Z" } });
    const adapter = new SessionEventStore(store, "s", "dead-process");
    let safe = 0;
    const eventStore = { checkpointVersion: 1 as const, readSession: adapter.readSession.bind(adapter), async append(e: AgentEvent) {
            await adapter.append(e);
            if (e.type === "runtime.checkpoint" && e.data.payload.phase === "safe" && ++safe === 2)
                process.kill(process.pid, "SIGKILL");
        } };
    for await (const _ of new MinimalAgentRuntime().run({ runId: "r", sessionId: "s", turnId: "t", input: "increment once", model: "fake", tools: counterTools(root), eventStore, modelAdapter: new FakeModel([{ toolCalls: [{ id: "counter", name: "fixture.counter", arguments: {} }] }, { content: "done" }]) })) { }
    throw Error("expected the child process to be killed");
}

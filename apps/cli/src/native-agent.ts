import { NativeBuilderError } from "./native-error";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { MinimalAgentRuntime, type EventStore, type AgentEvent } from "../../../packages/kernel/src";
import { FakeModel, type ModelAdapter } from "../../../packages/models/src";
import { createDevelopmentTools } from "../../../packages/tools/src";
import { createNativeWorkspace, DockerWorkspace, type DockerWorkspaceOptions } from "../../../packages/workspace/src";
import { openSqliteStore, SessionEventStore } from "@harness/sessions";
import { compileRules } from "@harness/policy";
import { git } from "./git";
import type { TaskAgent, TaskAgentResult, TaskAgentInput } from "./pi-agent";
export interface NativeAgentOptions {
    image: string;
    model?: string;
    modelAdapter?: ModelAdapter;
    /** Deterministic container protocol seam, never a local workspace fallback. */
    executor?: DockerWorkspaceOptions["executor"];
    /** Exercise a deliberate process loss at the first safe boundary. */
    restartAtSafeBoundary?: boolean;
}
export interface NativeRunEvidence {
    entrypoint: "MinimalAgentRuntime.TaskAgent/v1";
    image: string;
    model: string;
    sessionId: string;
    runId: string;
    workspaceId: string;
    initialSnapshot: string;
    generatedSnapshot: string;
    events: AgentEvent[];
    workspaceEvents: AgentEvent[];
    patch: string;
}
const agents = new WeakSet<TaskAgent>();
const results = new WeakMap<TaskAgentResult, {
    agent: TaskAgent;
    evidence: NativeRunEvidence;
}>();
export function isNativeTaskAgent(agent: TaskAgent): boolean { return agents.has(agent); }
export function nativeRunEvidence(agent: TaskAgent, result: TaskAgentResult): NativeRunEvidence {
    const trusted = results.get(result);
    if (!trusted || trusted.agent !== agent)
        throw Error("NATIVE_IDENTITY_INVALID: result is not from the verified runtime entrypoint");
    return structuredClone(trusted.evidence);
}
export function createNativeTaskAgent(options: NativeAgentOptions): TaskAgent {
    const config = Object.freeze({ ...options });
    const agent: TaskAgent = Object.freeze({ async run(input: TaskAgentInput) {
            const directory = mkdtempSync(join(tmpdir(), "harness-native-"));
            const database = join(directory, "session.db");
            let clock = Date.now();
            let store = openSqliteStore(database, { now: () => new Date(clock).toISOString() });
            let workspace: DockerWorkspace | undefined;
            try {
                if (Object.keys(config).some(key => !["image", "model", "modelAdapter", "executor", "restartAtSafeBoundary"].includes(key)))
                    throw new NativeBuilderError("NATIVE_CONFIG_INVALID", "unknown native builder option");
                if (typeof config.image !== "string" || !/@sha256:[a-f0-9]{64}$/u.test(config.image))
                    throw new NativeBuilderError("NATIVE_IMAGE_REQUIRED", "native execution requires a pinned image digest");
                const source = join(directory, "source");
                mkdirSync(source);
                const tracked = git(input.cwd, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
                if (!tracked.ok)
                    throw new NativeBuilderError("NATIVE_INPUT_TREE_UNAVAILABLE");
                const paths = new Set([...tracked.stdout.split("\0").filter(Boolean), relative(input.cwd, input.manifestPath)]);
                for (const path of paths) {
                    if (path.startsWith("../") || path.startsWith("/"))
                        throw new NativeBuilderError("NATIVE_INPUT_PATH");
                    // Reserved gate evidence is never source input, including a
                    // tracked placeholder in an otherwise clean repository.
                    if (path.startsWith("tasks/runs/"))
                        continue;
                    const stat = lstatSync(join(input.cwd, path));
                    if (!stat.isFile() || stat.nlink !== 1)
                        throw new NativeBuilderError("NATIVE_INPUT_NONREGULAR");
                    mkdirSync(dirname(join(source, path)), { recursive: true });
                    writeFileSync(join(source, path), readFileSync(join(input.cwd, path)));
                }
                const workspaceEvents: AgentEvent[] = [];
                const selected = await createNativeWorkspace({ root: source, allowedPaths: input.manifest.allowed_paths, image: config.image, executor: config.executor, onEvent: e => workspaceEvents.push(e) });
                if (!(selected instanceof DockerWorkspace))
                    throw new NativeBuilderError("NATIVE_ISOLATION_REQUIRED");
                workspace = selected;
                const initialSnapshot = (await workspace.snapshot()).id;
                const sessionId = randomUUID(), runId = randomUUID(), turnId = randomUUID();
                const ownerId = randomUUID();
                await store.createSession({ sessionId, taskId: input.manifest.id, metadata: { ownerId, leaseExpiresAt: new Date(clock + input.timeoutMs + 60000).toISOString() } });
                let adapter = new SessionEventStore(store, sessionId, ownerId);
                const rules = compileRules(input.manifest.permissions);
                const model = config.model ?? "fake";
                const modelAdapter = config.modelAdapter ?? new FakeModel([{ content: "No edits requested by the offline model." }]);
                const deadline = AbortSignal.timeout(input.timeoutMs);
                const runInput = { runId, sessionId, turnId, input: input.prompt, model, modelAdapter, eventStore: adapter as EventStore,
                    taskId: input.manifest.id, workspace, tools: createDevelopmentTools(source), signal: deadline,
                    budget: { maxSteps: 128, ...(input.budget?.max_model_tokens !== undefined ? { maxModelTokens: input.budget.max_model_tokens } : {}), ...(input.budget?.max_tool_calls !== undefined ? { maxToolCalls: input.budget.max_tool_calls } : {}) },
                    permission: { decide: (intent: {
                            action: string;
                            subject?: string;
                        }) => rules.decide(intent.action, intent.subject), resolve: async (request: {
                            action: string;
                        }) => ({ decision: request.action === "fs.write" && input.approvedWrite ? "allow" as const : "deny" as const, note: "trusted exit-gate write approval" }) } };
                let crashed = false;
                if (config.restartAtSafeBoundary)
                    runInput.eventStore = { checkpointVersion: 1, readSession: adapter.readSession.bind(adapter), async append(e) {
                            if (crashed)
                                throw Error("deliberate safe-boundary restart");
                            await adapter.append(e);
                            if (e.type === "runtime.checkpoint" && e.data.payload.phase === "safe") {
                                crashed = true;
                                throw Error("deliberate safe-boundary restart");
                            }
                        } };
                try {
                    for await (const _ of new MinimalAgentRuntime().run(runInput)) { /* durable store is authoritative */ }
                }
                catch (error) {
                    if (!crashed)
                        throw error;
                }
                if (crashed) {
                    store.close();
                    clock += input.timeoutMs + 60001;
                    store = openSqliteStore(database, { now: () => new Date(clock).toISOString() });
                    adapter = new SessionEventStore(store, sessionId, randomUUID());
                    for await (const _ of await new MinimalAgentRuntime().continue({ ...runInput, eventStore: adapter })) { /* drain */ }
                }
                const events: AgentEvent[] = [];
                for await (const e of adapter.readSession(sessionId))
                    events.push(e);
                const terminal = events.findLast(e => e.type === "turn.completed");
                if (terminal?.type !== "turn.completed" || terminal.data.status !== "completed")
                    throw new NativeBuilderError("NATIVE_RUN_FAILED");
                const cp = await adapter.loadCheckpoint();
                const state = cp!.payload as {
                    usage: {
                        totalTokens: number;
                    };
                    toolCalls: number;
                    modelRequests: number;
                };
                const patch = await workspace.diff();
                const generatedSnapshot = (await workspace.snapshot()).id;
                const workspaceId = workspaceEvents.find(e => e.type === "workspace.lifecycle")!;
                if (workspaceId.type !== "workspace.lifecycle")
                    throw new NativeBuilderError("NATIVE_WORKSPACE_IDENTITY");
                await workspace.dispose();
                const result: TaskAgentResult = Object.freeze({ name: "minimal-agent-runtime", finalText: events.filter(e => e.type === "message.completed" && e.data.role === "assistant").map(e => e.type === "message.completed" ? e.data.content : "").join("\n"), modelUsage: { totalModelTokens: state.usage.totalTokens, totalToolCalls: state.toolCalls, steps: state.modelRequests } });
                results.set(result, { agent, evidence: { entrypoint: "MinimalAgentRuntime.TaskAgent/v1", image: config.image, model, sessionId, runId, workspaceId: workspaceId.data.workspaceId, initialSnapshot, generatedSnapshot, events, workspaceEvents, patch } });
                return result;
            }
            finally {
                await workspace?.dispose();
                store.close();
                rmSync(directory, { recursive: true, force: true });
            }
        } });
    agents.add(agent);
    return agent;
}

import { z } from "zod";
import type { ModelRequest, Usage } from "@harness/models";
import { buildModelContext, type VersionedMessageState } from "./state";
import type { CompactionState, ContextPolicy } from "./context";
export interface RuntimeCheckpoint {
  version: 1;
  agentId?: string;
  workspaceSnapshot?: string;
  toolDefinitions?: import("@harness/models").ToolDefinition[];
  runId: string;
  sessionId: string;
  turnId: string;
  phase: "safe" | "model" | "summary" | "terminal";
  terminalStatus?: "completed" | "failed" | "canceled" | "budget_exceeded";
  messageState: VersionedMessageState;
  model: string;
  usage: Usage;
  modelRequests: number;
  toolCalls: number;
  toolTranscriptBytes: number;
  deniedCallStreak?: { fingerprint: string; count: number };
  seenModelCallIds: string[];
  runPermissionGrants: string[];
  warnedBudgets: string[];
  pendingSteering: {
    messageId: string;
    content: string;
  }[];
  sessionTurns: string[];
  compaction?: CompactionState;
  contextPolicy?: ContextPolicy;
  budget?: {
    maxSteps?: number;
    maxModelTokens?: number;
    maxToolCalls?: number;
  };
  settings: {system?:string;maxTokens?:number;providerOptions?:Record<string,unknown>;modelTimeoutMs?:number};
  nextRequest?: Omit<ModelRequest, "signal">;
}
export class RuntimeCheckpointError extends Error {
  constructor(readonly code: "RUNTIME_CHECKPOINT_VERSION" | "RUNTIME_CHECKPOINT_INVALID" | "RUNTIME_CHECKPOINT_INTERRUPTED", message: string) { super(message); this.name = "RuntimeCheckpointError"; }
}
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(256);
const schema = z.object({
  agentId:id.optional(),workspaceSnapshot:id.optional(),toolDefinitions:z.array(z.unknown()).optional(),
  version: z.literal(1), runId: id, sessionId: id, turnId: id, phase: z.enum(["safe", "model", "summary", "terminal"]),
  terminalStatus: z.enum(["completed", "failed", "canceled", "budget_exceeded"]).optional(),
  messageState: z.object({ version: z.literal(1), revision: count, messages: z.array(z.unknown()).max(10000) }).strict(),
  model: id, usage: z.object({ promptTokens: count, completionTokens: count, totalTokens: count }).strict(),
  modelRequests: count, toolCalls: count, toolTranscriptBytes: count,
  deniedCallStreak: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().min(1).max(3) }).strict().optional(),
  seenModelCallIds: z.array(id), runPermissionGrants: z.array(z.string()), warnedBudgets: z.array(z.enum(["steps", "tokens", "tool_calls"])),
  pendingSteering: z.array(z.object({ messageId: id, content: z.string().min(1).max(256 * 1024) }).strict()).max(128), sessionTurns: z.array(id).min(1),
  compaction: z.object({ version: z.literal(1), summary: z.string().min(1), tailStart: count, throughRevision: count }).strict().optional(),
  contextPolicy: z.object({ windowTokens: count, thresholdTokens: count, tailMessages: count, reserveTokens: count }).strict().optional(),
  budget: z.object({ maxSteps: count.optional(), maxModelTokens: count.optional(), maxToolCalls: count.optional() }).strict().optional(),
  settings:z.object({system:z.string().optional(),maxTokens:z.number().int().positive().optional(),providerOptions:z.record(z.unknown()).optional(),modelTimeoutMs:z.number().int().positive().optional()}).strict(),
  nextRequest: z.object({ messages: z.array(z.unknown()).max(10000), tools: z.array(z.unknown()).optional(), model: id, system: z.string().optional(), maxTokens: z.number().int().positive().optional(), providerOptions: z.record(z.unknown()).optional(), contextVersion: z.literal(1), messageRevision: count }).strict().optional(),
}).strict();
export function parseRuntimeCheckpoint(value: unknown): RuntimeCheckpoint {
  if (value && typeof value === "object" && "version" in value && value.version !== 1)
    throw new RuntimeCheckpointError("RUNTIME_CHECKPOINT_VERSION", "unsupported runtime checkpoint version");
  try {
    const wire = JSON.stringify(value);
    if (!wire || Buffer.byteLength(wire) > 16 * 1024 * 1024)
      throw Error("checkpoint size");
    const parsed = schema.parse(JSON.parse(wire));
    buildModelContext(parsed.messageState as VersionedMessageState);
    if (parsed.usage.totalTokens !== parsed.usage.promptTokens + parsed.usage.completionTokens)
      throw Error("inconsistent usage");
    if (!parsed.sessionTurns.includes(parsed.turnId) || new Set(parsed.sessionTurns).size !== parsed.sessionTurns.length)
      throw Error("invalid turn history");
    if (parsed.compaction && (parsed.compaction.tailStart > parsed.messageState.messages.length || parsed.compaction.throughRevision > parsed.messageState.revision))
      throw Error("invalid compaction cursor");
    if (parsed.contextPolicy) {
      const p = parsed.contextPolicy;
      if (Object.values(p).some(v => v <= 0) || p.thresholdTokens >= p.windowTokens || p.reserveTokens >= p.windowTokens || p.tailMessages > 10000)
        throw Error("invalid context policy");
    }
    if (new Set(parsed.seenModelCallIds).size !== parsed.seenModelCallIds.length || new Set(parsed.pendingSteering.map(m => m.messageId)).size !== parsed.pendingSteering.length)
      throw Error("duplicate tool or steering identity");
    if (parsed.phase === "terminal") {
      if (!parsed.terminalStatus || parsed.nextRequest)
        throw Error("invalid terminal checkpoint");
    }
    else if (parsed.phase === "safe") {
      if (parsed.nextRequest || parsed.terminalStatus || !parsed.agentId || !parsed.toolDefinitions) throw Error("invalid safe checkpoint");
      buildModelContext(parsed.messageState as VersionedMessageState,parsed.toolDefinitions as Parameters<typeof buildModelContext>[1]);
    }
    else {
      if (!parsed.nextRequest || parsed.terminalStatus)
        throw Error("missing next request");
      if (parsed.nextRequest.model !== parsed.model || parsed.nextRequest.messageRevision !== parsed.messageState.revision)
        throw Error("request identity mismatch");
      buildModelContext({ version: 1, revision: parsed.nextRequest.messageRevision, messages: parsed.nextRequest.messages } as VersionedMessageState, parsed.nextRequest.tools as Parameters<typeof buildModelContext>[1]);
    }
    return parsed as RuntimeCheckpoint;
  }
  catch (cause) {
    throw new RuntimeCheckpointError("RUNTIME_CHECKPOINT_INVALID", `invalid runtime checkpoint: ${cause instanceof Error ? cause.message : "malformed data"}`);
  }
}
/** Reconstruction is pure: it never repeats a possibly-executed model or tool. */
export function reconstructModelRequest(value: unknown): ModelRequest {
  const checkpoint = parseRuntimeCheckpoint(value);
  if (!checkpoint.nextRequest)
    throw new RuntimeCheckpointError("RUNTIME_CHECKPOINT_INVALID", "terminal checkpoint has no next request");
  return checkpoint.nextRequest;
}

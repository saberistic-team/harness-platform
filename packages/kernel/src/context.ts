import { buildModelContext, createMessageState, type VersionedMessageState } from "./state";
import type { ToolDefinition } from "@harness/models";

export interface ContextPolicy {
  windowTokens: number;
  thresholdTokens: number;
  tailMessages: number;
  /** Reserved output tokens, including summaries. */
  reserveTokens: number;
}
export interface CompactionState {
  version: 1;
  summary: string;
  tailStart: number;
  throughRevision: number;
}
/** Conservative, deterministic upper bound; includes schema/role/JSON overhead. */
export function contextOccupancy(messages: readonly unknown[], tools: readonly unknown[], system = ""): number {
  return Buffer.byteLength(JSON.stringify({messages,tools,system}), "utf8");
}
export function effectiveContext(state: VersionedMessageState, tools: readonly ToolDefinition[], compacted?: CompactionState) {
  const messages = compacted ? [
    ...state.messages.slice(0,compacted.tailStart).filter(m=>m.role === "system"),
    {role:"system" as const, content:`Conversation summary (v1): ${compacted.summary}`},
    ...state.messages.slice(compacted.tailStart),
  ] : state.messages;
  const context = buildModelContext(createMessageState(messages), tools);
  return {...context, messageRevision:state.revision};
}

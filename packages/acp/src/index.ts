/**
 * ACP (Agent Client Protocol) — the protocol surface between the
 * control plane (UI/TUI/CLI) and the agent server.
 *
 * M0 scope: the contract types only. The agent server (services/)
 * implements these in M3; the TUI/WUI clients consume them.
 *
 * Deliberate design: ACP is transport-agnostic (JSON-RPC shaped) and
 * event-oriented — the same harness event stream that the kernel
 * emits is what flows over ACP, so clients never invent their own
 * wire formats.
 */

export interface AcpCapabilities {
  /** Server supports streaming agent events. */
  streaming?: boolean;
  /** Server supports tool-permission negotiation. */
  permissioning?: boolean;
  /** Server supports resuming sessions by id. */
  sessions?: boolean;
}

export interface AcpInitializeParams {
  protocolVersion: string;
  clientName: string;
  clientVersion?: string;
  capabilities: AcpCapabilities;
}

export interface AcpInitializeResult {
  protocolVersion: string;
  agentName: string;
  agentVersion?: string;
  capabilities: AcpCapabilities;
  models: string[];
}

export interface AcpNewSessionParams {
  workspace: string;
  taskId?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
}

export interface AcpPromptParams {
  sessionId: string;
  content: string;
  maxModelTokens?: number;
  maxToolCalls?: number;
}

export interface AcpPromptResult {
  /** Serialized harness events captured during the prompt. */
  events: string[];
  finalText: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export const ACP_PROTOCOL_VERSION = "harness/acp/1";

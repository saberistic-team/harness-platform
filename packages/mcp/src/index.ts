import { z } from "zod";

/**
 * MCP (Model Context Protocol) bridge.
 *
 * M0 scope: wire-shape types only — the request/response envelope and
 * the initialize handshake. The live client (stdio + HTTP transports)
 * lands in M2 together with sandbox-runner, reusing these shapes.
 */

export const mcpProtocolVersion = "2025-03-26";

export const mcpRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

export const mcpResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export const mcpNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

export type McpRequest = z.infer<typeof mcpRequest>;
export type McpResponse = z.infer<typeof mcpResponse>;
export type McpMessage = McpRequest | McpResponse;

/** Client -> server capability declaration (subset we rely on). */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean };
  prompts?: Record<string, unknown>;
}

export function isMcpResponse(msg: unknown): msg is McpResponse {
  return mcpResponse.safeParse(msg).success;
}

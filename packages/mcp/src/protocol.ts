import { z } from "zod";

/** Latest initialize-era protocol revision implemented by this adapter. */
export const mcpProtocolVersion = "2025-11-25";

/**
 * Revisions whose initialize results the client can consume.
 *
 * The request advertises the first entry. A server may negotiate one of the
 * older compatible revisions, but unknown revisions are a typed hard error.
 */
export const mcpSupportedProtocolVersions = [
  mcpProtocolVersion,
  "2025-06-18",
  "2025-03-26",
] as const;

const requestId = z.union([z.string(), z.number().int()]);
const rpcError = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const mcpRequest = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: requestId,
    method: z.string().min(1),
    params: z.record(z.unknown()).optional(),
    result: z.never().optional(),
    error: z.never().optional(),
  })
  .passthrough();

export const mcpResponse = z
  .object({
    jsonrpc: z.literal("2.0"),
    // An error without an id can be emitted when the peer cannot correlate a
    // malformed request. The client treats it as a terminal protocol error.
    id: requestId.optional(),
    result: z.record(z.unknown()).optional(),
    error: rpcError.optional(),
    method: z.never().optional(),
    params: z.never().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (hasResult === hasError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON-RPC response must contain exactly one of result or error",
      });
    }
    if (hasResult && value.id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON-RPC success response must contain an id",
      });
    }
  });

export const mcpNotification = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.record(z.unknown()).optional(),
    id: z.never().optional(),
    result: z.never().optional(),
    error: z.never().optional(),
  })
  .passthrough();

export type McpRequest = z.infer<typeof mcpRequest>;
export type McpResponse = z.infer<typeof mcpResponse>;
export type McpNotification = z.infer<typeof mcpNotification>;
export type McpMessage = McpRequest | McpResponse | McpNotification;

/** Server -> client capability declaration (subset the harness uses today). */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  [capability: string]: unknown;
}

export function isMcpResponse(message: unknown): message is McpResponse {
  return mcpResponse.safeParse(message).success;
}

import { deserializeEvent, type AnyHarnessEvent } from "@harness/events";
import { z } from "zod";
import { ACP_RPC_ERROR_CODES, AcpProtocolError } from "./errors";

export const ACP_PROTOCOL_VERSION = "harness/acp/1";

// These limits sit below the default WebSocket frame limit. They make the
// wire contract safe to decode independently of a particular transport (for
// example, in tests or in a future stdio bridge).
const MAX_NAME_BYTES = 256;
const MAX_SESSION_ID_BYTES = 256;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_RESULT_TEXT_BYTES = 512 * 1024;
const MAX_MODELS = 128;
const MAX_STREAM_REPLAY_EVENTS = 128;
// Keep this aligned with @harness/sessions' durable page bound. ACP cannot
// advertise a page size that the backing store will reject after decoding.
const MAX_RESTORE_EVENTS = 1_000;

function fitsUtf8Bytes(value: string, maximum: number): boolean {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > maximum) return false;
  }
  return true;
}

const boundedText = (maximum: number) => z.string().max(maximum).refine(
  (value) => fitsUtf8Bytes(value, maximum),
  { message: `string must be at most ${maximum} UTF-8 bytes` },
);
const boundedString = (maximum: number) => boundedText(maximum).refine(
  (value) => value.length > 0,
  { message: "string must not be empty" },
);
const safeNonnegativeInteger = z.number().int().nonnegative().safe();
const safePositiveInteger = z.number().int().positive().safe();

export const ACP_METHODS = {
  initialize: "initialize",
  newSession: "session/new",
  restoreSession: "session/restore",
  prompt: "session/prompt",
  respondPermission: "permission/respond",
  cancelSession: "session/cancel",
  sessionEvent: "session/event",
} as const;

export interface AcpCapabilities {
  streaming?: boolean;
  permissioning?: boolean;
  /** Session replay/resume is an M4 capability and is false in M3. */
  sessions?: boolean;
}

const capabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  permissioning: z.boolean().optional(),
  sessions: z.boolean().optional(),
}).strict();

export const acpInitializeParamsSchema = z.object({
  protocolVersion: boundedString(128),
  clientName: boundedString(128),
  clientVersion: boundedString(64).optional(),
  capabilities: capabilitiesSchema,
}).strict();

export const acpInitializeResultSchema = z.object({
  protocolVersion: boundedString(128),
  agentName: boundedString(128),
  agentVersion: boundedString(64).optional(),
  capabilities: capabilitiesSchema,
  models: z.array(boundedString(MAX_NAME_BYTES)).max(MAX_MODELS),
}).strict();

export const acpNewSessionParamsSchema = z.object({
  workspace: boundedString(4096),
  taskId: z.string().max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  model: boundedString(MAX_NAME_BYTES).optional(),
}).strict();

export const acpNewSessionResultSchema = z.object({ sessionId: boundedString(MAX_SESSION_ID_BYTES) }).strict();

/**
 * Restore is a replay operation, not permission to repeat an interrupted turn.
 * `afterSeq` is the last sequence the client durably observed; the server only
 * streams committed events whose sequence is greater than that cursor.
 */
export const acpRestoreSessionParamsSchema = z.object({
  sessionId: boundedString(MAX_SESSION_ID_BYTES),
  afterSeq: z.number().int().min(-1).safe(),
  limit: z.number().int().positive().max(MAX_RESTORE_EVENTS).safe().default(MAX_STREAM_REPLAY_EVENTS),
}).strict();

export const acpRestoreSessionResultSchema = z.object({
  sessionId: boundedString(MAX_SESSION_ID_BYTES),
  status: z.enum(["completed", "interrupted"]),
  replayedFromSeq: z.number().int().nonnegative().safe(),
  replayedThroughSeq: z.number().int().min(-1).safe(),
  replayedEvents: z.number().int().nonnegative().max(MAX_RESTORE_EVENTS).safe(),
  hasMore: z.boolean(),
}).strict();

export const acpPromptParamsSchema = z.object({
  sessionId: boundedString(MAX_SESSION_ID_BYTES),
  content: boundedString(MAX_PROMPT_BYTES),
  maxModelTokens: safePositiveInteger.optional(),
  maxToolCalls: safePositiveInteger.optional(),
}).strict();

const usageSchema = z.object({
  promptTokens: safeNonnegativeInteger,
  completionTokens: safeNonnegativeInteger,
  totalTokens: safeNonnegativeInteger,
}).strict().refine(
  (usage) => usage.totalTokens === usage.promptTokens + usage.completionTokens,
  { message: "totalTokens must equal promptTokens + completionTokens" },
);

export const acpPromptResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  events: z.array(boundedText(MAX_RESULT_TEXT_BYTES)).max(MAX_STREAM_REPLAY_EVENTS),
  finalText: boundedText(MAX_RESULT_TEXT_BYTES),
  usage: usageSchema,
}).strict();

export const acpPermissionResponseParamsSchema = z.object({
  sessionId: boundedString(MAX_SESSION_ID_BYTES),
  permissionId: boundedString(MAX_SESSION_ID_BYTES),
  decision: z.enum(["allow", "deny"]),
  note: boundedText(4096).optional(),
}).strict();

export const acpPermissionResponseResultSchema = z.object({ accepted: z.literal(true) }).strict();
export const acpCancelSessionParamsSchema = z.object({ sessionId: boundedString(MAX_SESSION_ID_BYTES) }).strict();
export const acpCancelSessionResultSchema = z.object({ canceled: z.boolean() }).strict();

export interface AcpSessionEventParams {
  sessionId: string;
  seq: number;
  event: AnyHarnessEvent;
}

export type AcpInitializeParams = z.infer<typeof acpInitializeParamsSchema>;
export type AcpInitializeResult = z.infer<typeof acpInitializeResultSchema>;
export type AcpNewSessionParams = z.infer<typeof acpNewSessionParamsSchema>;
export type AcpNewSessionResult = z.infer<typeof acpNewSessionResultSchema>;
export type AcpRestoreSessionParams = z.infer<typeof acpRestoreSessionParamsSchema>;
export type AcpRestoreSessionResult = z.infer<typeof acpRestoreSessionResultSchema>;
export type AcpPromptParams = z.infer<typeof acpPromptParamsSchema>;
export type AcpPromptResult = z.infer<typeof acpPromptResultSchema>;
export type AcpPermissionResponseParams = z.infer<typeof acpPermissionResponseParamsSchema>;
export type AcpPermissionResponseResult = z.infer<typeof acpPermissionResponseResultSchema>;
export type AcpCancelSessionParams = z.infer<typeof acpCancelSessionParamsSchema>;
export type AcpCancelSessionResult = z.infer<typeof acpCancelSessionResultSchema>;

const rpcIdSchema = z.union([boundedText(256), z.number().int().safe()]);
export type AcpRequestId = z.infer<typeof rpcIdSchema>;
export type AcpRequestMethod = Exclude<(typeof ACP_METHODS)[keyof typeof ACP_METHODS], "session/event">;

export interface AcpRequest {
  jsonrpc: "2.0";
  id: AcpRequestId;
  method: AcpRequestMethod;
  params: unknown;
}

export interface AcpSuccessResponse {
  jsonrpc: "2.0";
  id: AcpRequestId;
  result: unknown;
}

export interface AcpErrorResponse {
  jsonrpc: "2.0";
  id: AcpRequestId | null;
  error: { code: number; message: string; data?: unknown };
}

export interface AcpNotification {
  jsonrpc: "2.0";
  method: "session/event";
  params: AcpSessionEventParams;
}

export type AcpMessage = AcpRequest | AcpSuccessResponse | AcpErrorResponse | AcpNotification;

const requestEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema,
  method: boundedString(128),
  params: z.unknown().default({}),
}).strict();
const successResponseSchema = z.object({
  jsonrpc: z.literal("2.0"), id: rpcIdSchema, result: z.unknown(),
}).strict();
const errorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcIdSchema.nullable(),
  error: z.object({
    code: z.number().int().safe(),
    message: boundedText(4096),
    data: z.unknown().optional(),
  }).strict(),
}).strict();
const notificationEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"), method: boundedString(128), params: z.unknown(),
}).strict();

const requestParamSchemas = {
  [ACP_METHODS.initialize]: acpInitializeParamsSchema,
  [ACP_METHODS.newSession]: acpNewSessionParamsSchema,
  [ACP_METHODS.restoreSession]: acpRestoreSessionParamsSchema,
  [ACP_METHODS.prompt]: acpPromptParamsSchema,
  [ACP_METHODS.respondPermission]: acpPermissionResponseParamsSchema,
  [ACP_METHODS.cancelSession]: acpCancelSessionParamsSchema,
} as const;

function parsedJson(raw: string | unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new AcpProtocolError("ACP_PARSE_ERROR", "ACP frame is not valid JSON", ACP_RPC_ERROR_CODES.parseError, raw);
  }
}

export function decodeAcpMessage(raw: string | unknown): AcpMessage {
  const value = parsedJson(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcpProtocolError("ACP_INVALID_REQUEST", "ACP frame must be a JSON object", ACP_RPC_ERROR_CODES.invalidRequest, value);
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "method") && Object.hasOwn(record, "id")) {
    const envelope = requestEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      throw new AcpProtocolError("ACP_INVALID_REQUEST", "invalid ACP JSON-RPC request envelope", ACP_RPC_ERROR_CODES.invalidRequest, value);
    }
    const method = envelope.data.method as AcpRequestMethod;
    const schema = Object.hasOwn(requestParamSchemas, method)
      ? requestParamSchemas[method]
      : undefined;
    if (!schema) {
      throw new AcpProtocolError("ACP_METHOD_NOT_FOUND", `unknown ACP method: ${envelope.data.method}`, ACP_RPC_ERROR_CODES.methodNotFound, value);
    }
    const params = schema.safeParse(envelope.data.params);
    if (!params.success) {
      throw new AcpProtocolError("ACP_INVALID_PARAMS", `invalid params for ${envelope.data.method}`, ACP_RPC_ERROR_CODES.invalidParams, params.error.issues);
    }
    return { ...envelope.data, method: envelope.data.method as AcpRequestMethod, params: params.data };
  }
  if (Object.hasOwn(record, "method")) {
    const envelope = notificationEnvelopeSchema.safeParse(value);
    if (!envelope.success || envelope.data.method !== ACP_METHODS.sessionEvent) {
      throw new AcpProtocolError("ACP_INVALID_REQUEST", "invalid ACP notification", ACP_RPC_ERROR_CODES.invalidRequest, value);
    }
    const base = z.object({
      sessionId: boundedString(MAX_SESSION_ID_BYTES),
      seq: safeNonnegativeInteger,
      event: z.unknown(),
    }).strict().safeParse(envelope.data.params);
    if (!base.success) {
      throw new AcpProtocolError("ACP_INVALID_PARAMS", "invalid session/event notification", ACP_RPC_ERROR_CODES.invalidParams, base.error.issues);
    }
    let event: AnyHarnessEvent;
    try {
      event = deserializeEvent(base.data.event);
    } catch (error) {
      throw new AcpProtocolError("ACP_INVALID_PARAMS", "session/event contains an invalid harness event", ACP_RPC_ERROR_CODES.invalidParams, error);
    }
    return { jsonrpc: "2.0", method: ACP_METHODS.sessionEvent, params: { ...base.data, event } };
  }
  if (Object.hasOwn(record, "result")) {
    const response = successResponseSchema.safeParse(value);
    if (response.success) {
      return {
        jsonrpc: "2.0",
        id: response.data.id,
        result: response.data.result,
      };
    }
  }
  if (Object.hasOwn(record, "error")) {
    const response = errorResponseSchema.safeParse(value);
    if (response.success) return response.data;
  }
  throw new AcpProtocolError("ACP_INVALID_RESPONSE", "invalid ACP JSON-RPC response", ACP_RPC_ERROR_CODES.invalidRequest, value);
}

export function acpSuccess(id: AcpRequestId, result: unknown): AcpSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function acpFailure(id: AcpRequestId | null, code: number, message: string, data?: unknown): AcpErrorResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function acpEvent(params: AcpSessionEventParams): AcpNotification {
  return decodeAcpMessage({ jsonrpc: "2.0", method: ACP_METHODS.sessionEvent, params }) as AcpNotification;
}

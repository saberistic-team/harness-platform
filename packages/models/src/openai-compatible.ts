import { z } from "zod";
import {
  estimateTokens,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResponse,
  type JsonValue,
  type Model,
  type ToolCall,
  type ToolDefinition,
  type Usage,
} from "./model";
import { ModelProviderError } from "./model-provider-error";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_MESSAGES = 10_000;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS = 128;
const MAX_PROVIDER_OPTIONS = 256;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_RESPONSE_CHUNKS = 16_384;
const MAX_MODEL_ID_LENGTH = 1_024;
const MAX_WIRE_ID_LENGTH = 1_024;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 16_384;
const MAX_BASE_URL_LENGTH = 8_192;
const RESERVED_PROVIDER_OPTIONS = new Set([
  "messages",
  "model",
  "tools",
  "stream",
  "n",
  "functions",
  "function_call",
  "max_tokens",
  "max_completion_tokens",
  "__proto__",
  "constructor",
  "prototype",
]);

const SENSITIVE_QUERY_PARAMETER_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "auth",
  "bearer",
  "credential",
  "key",
  "password",
  "secret",
  "sig",
  "signature",
  "token",
]);

const boundedNonBlankString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank")
    .refine(
      (value) =>
        !/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(
          value,
        ),
      "must not contain control characters",
    );

const safeTokenCount = z.number().int().nonnegative().safe();

const usageSchema = z
  .object({
    prompt_tokens: safeTokenCount,
    completion_tokens: safeTokenCount,
    total_tokens: safeTokenCount,
  });

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.unknown()).max(MAX_TOOL_CALLS).optional(),
  });

const completionSchema = z
  .object({
    id: boundedNonBlankString(MAX_WIRE_ID_LENGTH),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            finish_reason: boundedNonBlankString(64),
            message: assistantMessageSchema,
          }),
      )
      .length(1),
    usage: usageSchema.nullish(),
  });

const functionToolCallSchema = z
  .object({
    id: boundedNonBlankString(MAX_WIRE_ID_LENGTH),
    type: z.literal("function"),
    function: z
      .object({
        name: boundedNonBlankString(MAX_TOOL_NAME_LENGTH),
        arguments: z.string(),
      }),
  });

const providerErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        code: z.union([z.string(), z.number()]).nullish(),
        type: z.string().nullish(),
      }),
  });

export type OpenAICompatibleFetch = typeof globalThis.fetch;
export type OpenAIMaxTokensParameter =
  | "max_tokens"
  | "max_completion_tokens";

export interface OpenAICompatibleModelOptions {
  /** API base URL, normally ending in `/v1`; plaintext is loopback-only. */
  baseUrl: string;
  /** Provider model id. One adapter instance is pinned to one model. */
  model: string;
  /** Optional for local compatible servers; required by hosted OpenAI. */
  apiKey?: string;
  organization?: string;
  project?: string;
  /** Hard wall-clock deadline, including response body consumption. */
  timeoutMs?: number;
  /** Encoded request and streamed response limits; both default to 4 MiB. */
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Defaults to the broadly compatible legacy spelling. */
  maxTokensParameter?: OpenAIMaxTokensParameter;
  /** Injectable transport for deterministic, offline tests. */
  fetch?: OpenAICompatibleFetch;
}

type WireMessage = Record<string, unknown>;

function invalidConfig(message: string): ModelProviderError {
  return new ModelProviderError("MODEL_INVALID_CONFIG", message);
}

function invalidRequest(message: string): ModelProviderError {
  return new ModelProviderError("MODEL_INVALID_REQUEST", message);
}

function ownDataProperty(
  value: object,
  key: string,
  path: string,
  fail: (message: string) => never,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return fail(`${path} could not be inspected safely`);
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    return fail(`${path} must be an ordinary data property`);
  }
  return descriptor.value;
}

function configProperty(
  value: object,
  key: string,
  path = `model provider ${key}`,
): unknown {
  return ownDataProperty(value, key, path, (message) => {
    throw invalidConfig(message);
  });
}

function requestProperty(
  value: object,
  key: string,
  path: string,
): unknown {
  return ownDataProperty(value, key, path, (message) => {
    throw invalidRequest(message);
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOrdinaryArray(
  value: unknown,
  path: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidRequest(`${path} must be an array`);
  }
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw invalidRequest(`${path} could not be inspected safely`);
  }
  if (prototype !== Array.prototype) {
    throw invalidRequest(`${path} must be an ordinary array`);
  }
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw invalidRequest(`${path} had an invalid length`);
  }
  if ((length as number) > maximum) {
    throw invalidRequest(`${path} must contain at most ${maximum} entries`);
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
  } catch {
    throw invalidRequest(`${path} could not be inspected safely`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key === "symbol") ||
    keys.length !== (length as number) + 1
  ) {
    throw invalidRequest(`${path} must not contain sparse or named properties`);
  }
  const output: unknown[] = [];
  Object.defineProperty(output, "toJSON", {
    configurable: true,
    value: undefined,
  });
  for (let index = 0; index < (length as number); index++) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw invalidRequest(`${path}[${index}] must be an ordinary array item`);
    }
    output.push(descriptor.value);
  }
  return output;
}

interface JsonNormalizationState {
  ancestors: Set<object>;
  nodes: number;
  byteBudget?: RequestByteBudget;
  fail(message: string): never;
}

interface RequestByteBudget {
  used: number;
  maximum: number;
}

function chargeRequestBytes(
  budget: RequestByteBudget,
  value: string,
  path: string,
): void {
  budget.used += Buffer.byteLength(value, "utf8");
  if (budget.used > budget.maximum) {
    throw invalidRequest(`${path} exceeded the configured request size limit`);
  }
}

function ownDescriptors(
  value: object,
  path: string,
  state: JsonNormalizationState,
): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return state.fail(`${path} could not be inspected safely`);
  }
}

/**
 * Validates and clones provider JSON without invoking getters or inherited
 * `toJSON` hooks. Recursion is safe because depth is rejected at a small,
 * fixed boundary before descending.
 */
function normalizeJsonValue(
  value: unknown,
  path: string,
  state: JsonNormalizationState,
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    return state.fail(
      `${path} exceeded the JSON node limit (${MAX_JSON_NODES})`,
    );
  }
  if (depth > MAX_JSON_DEPTH) {
    return state.fail(
      `${path} exceeded the JSON depth limit (${MAX_JSON_DEPTH})`,
    );
  }
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (state.byteBudget !== undefined) {
      chargeRequestBytes(state.byteBudget, value, path);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return state.fail(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    return state.fail(`${path} must be JSON-serializable`);
  }
  if (state.ancestors.has(value)) {
    return state.fail(`${path} must not contain circular references`);
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      let prototype: object | null;
      try {
        prototype = Object.getPrototypeOf(value);
      } catch {
        return state.fail(`${path} could not be inspected safely`);
      }
      if (prototype !== Array.prototype) {
        return state.fail(`${path} must contain only ordinary JSON arrays`);
      }
      if (value.length > MAX_JSON_NODES - state.nodes) {
        return state.fail(
          `${path} exceeded the JSON node limit (${MAX_JSON_NODES})`,
        );
      }
      const descriptors = ownDescriptors(value, path, state);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol")) {
        return state.fail(`${path} must not contain symbol properties`);
      }
      if (keys.length !== value.length + 1 || !("length" in descriptors)) {
        return state.fail(`${path} must not contain sparse or named properties`);
      }
      const output: JsonValue[] = [];
      Object.defineProperty(output, "toJSON", {
        configurable: true,
        value: undefined,
      });
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          return state.fail(
            `${path}[${index}] must be an ordinary JSON array element`,
          );
        }
        output.push(
          normalizeJsonValue(
            descriptor.value,
            `${path}[${index}]`,
            state,
            depth + 1,
          ),
        );
      }
      return output;
    }

    if (!isPlainRecord(value)) {
      return state.fail(`${path} must contain only plain JSON objects`);
    }
    const descriptors = ownDescriptors(value, path, state);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_JSON_NODES - state.nodes) {
      return state.fail(
        `${path} exceeded the JSON node limit (${MAX_JSON_NODES})`,
      );
    }
    const output = Object.create(null) as { [key: string]: JsonValue };
    let propertyIndex = 0;
    for (const key of keys) {
      if (typeof key === "symbol") {
        return state.fail(`${path} must not contain symbol properties`);
      }
      if (state.byteBudget !== undefined) {
        chargeRequestBytes(state.byteBudget, key, path);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        return state.fail(`${path} must contain only ordinary JSON properties`);
      }
      const normalized = normalizeJsonValue(
        descriptor.value,
        `${path}.<property ${propertyIndex}>`,
        state,
        depth + 1,
      );
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: normalized,
        writable: true,
      });
      propertyIndex += 1;
    }
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function normalizeRequestJson(
  value: unknown,
  path: string,
  byteBudget?: RequestByteBudget,
): JsonValue {
  return normalizeJsonValue(value, path, {
    ancestors: new Set<object>(),
    nodes: 0,
    byteBudget,
    fail(message): never {
      throw invalidRequest(message);
    },
  });
}

function normalizeResponseJson(
  value: unknown,
  path: string,
  providerRequestId?: string,
): JsonValue {
  return normalizeJsonValue(value, path, {
    ancestors: new Set<object>(),
    nodes: 0,
    fail(message): never {
      throw new ModelProviderError("MODEL_INVALID_RESPONSE", message, {
        providerRequestId,
      });
    },
  });
}

interface ResolvedEndpoint {
  href: string;
  protocol: "http:" | "https:";
}

function resolveEndpoint(baseUrl: string): ResolvedEndpoint {
  if (baseUrl.length > MAX_BASE_URL_LENGTH || baseUrl !== baseUrl.trim()) {
    throw invalidConfig(
      `model provider baseUrl must be at most ${MAX_BASE_URL_LENGTH} characters and have no surrounding whitespace`,
    );
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalidConfig("model provider baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig("model provider baseUrl must use http or https");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalidConfig("model provider baseUrl must not contain credentials");
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      SENSITIVE_QUERY_PARAMETER_NAMES.has(normalized) ||
      normalized.endsWith("apikey") ||
      normalized.endsWith("credential") ||
      normalized.endsWith("password") ||
      normalized.endsWith("secret") ||
      normalized.endsWith("signature") ||
      normalized.endsWith("token")
    ) {
      throw invalidConfig(
        "model provider baseUrl must not contain credentials in its query string",
      );
    }
  }
  if (
    url.protocol === "http:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw invalidConfig(
      "plaintext model provider URLs are allowed only for loopback hosts",
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/chat/completions")) {
    url.pathname = `${path}/chat/completions`.replace(/^\/$/, "/chat/completions");
  }
  url.hash = "";
  return { href: url.toString(), protocol: url.protocol };
}

function requireHeaderValue(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidConfig(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw invalidConfig(`${field} must not be empty`);
  }
  if (
    trimmed.length > MAX_HEADER_VALUE_LENGTH ||
    !/^[\x20-\x7E]+$/.test(trimmed)
  ) {
    throw invalidConfig(
      `${field} must be a printable ASCII header value no longer than ${MAX_HEADER_VALUE_LENGTH} characters`,
    );
  }
  return trimmed;
}

function requireModelId(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_MODEL_ID_LENGTH ||
    /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(trimmed)
  ) {
    throw invalidConfig(
      `model provider model must be non-empty, control-free, and at most ${MAX_MODEL_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

function requirePositiveBoundedInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw invalidConfig(
      `${field} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return value;
}

function requireWireString(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/.test(value)
  ) {
    throw invalidRequest(
      `${path} must be non-blank, control-free, and at most ${maximum} characters`,
    );
  }
  return value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as AbortSignal).aborted === "boolean" &&
      typeof (value as AbortSignal).addEventListener === "function" &&
      typeof (value as AbortSignal).removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

function zodDetails(error: z.ZodError): unknown {
  return error.issues.slice(0, 10).map((issue) => ({
    code: issue.code,
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Non-streaming Chat Completions adapter for OpenAI-compatible HTTP APIs.
 *
 * It intentionally has no retry loop: every provider request remains one
 * observable model turn, and service-level retry policy can account for it.
 */
export class OpenAICompatibleModel implements Model {
  readonly name: string;
  readonly model: string;

  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly organization?: string;
  private readonly project?: string;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxTokensParameter: OpenAIMaxTokensParameter;
  private readonly fetchImpl: OpenAICompatibleFetch;
  private readonly secrets: string[];

  constructor(options: OpenAICompatibleModelOptions) {
    if (!isPlainRecord(options)) {
      throw invalidConfig("model provider options must be an object");
    }
    const rawModel = configProperty(options, "model");
    const rawBaseUrl = configProperty(options, "baseUrl");
    const rawTimeoutMs = configProperty(options, "timeoutMs");
    const rawMaxRequestBytes = configProperty(options, "maxRequestBytes");
    const rawMaxResponseBytes = configProperty(options, "maxResponseBytes");
    const rawFetch = configProperty(options, "fetch");
    const rawMaxTokensParameter = configProperty(
      options,
      "maxTokensParameter",
    );
    const rawApiKey = configProperty(options, "apiKey");
    const rawOrganization = configProperty(options, "organization");
    const rawProject = configProperty(options, "project");

    if (typeof rawModel !== "string") {
      throw invalidConfig("model provider model must not be empty");
    }
    if (typeof rawBaseUrl !== "string") {
      throw invalidConfig("model provider baseUrl must be a string");
    }

    const timeoutMs = requirePositiveBoundedInteger(
      (rawTimeoutMs ?? DEFAULT_TIMEOUT_MS) as number,
      "model provider timeoutMs",
      MAX_TIMEOUT_MS,
    );
    const maxRequestBytes = requirePositiveBoundedInteger(
      (rawMaxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES) as number,
      "model provider maxRequestBytes",
      MAX_BODY_BYTES,
    );
    const maxResponseBytes = requirePositiveBoundedInteger(
      (rawMaxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) as number,
      "model provider maxResponseBytes",
      MAX_BODY_BYTES,
    );

    const fetchImpl = rawFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw invalidConfig("no fetch implementation is available");
    }

    if (
      rawMaxTokensParameter !== undefined &&
      rawMaxTokensParameter !== "max_tokens" &&
      rawMaxTokensParameter !== "max_completion_tokens"
    ) {
      throw invalidConfig(
        "model provider maxTokensParameter must be max_tokens or max_completion_tokens",
      );
    }

    const endpoint = resolveEndpoint(rawBaseUrl);
    const apiKey = requireHeaderValue(rawApiKey, "model provider apiKey");
    const organization = requireHeaderValue(
      rawOrganization,
      "model provider organization",
    );
    const project = requireHeaderValue(
      rawProject,
      "model provider project",
    );
    if (
      endpoint.protocol !== "https:" &&
      (apiKey !== undefined || organization !== undefined || project !== undefined)
    ) {
      throw invalidConfig(
        "model provider credentials and account headers require HTTPS",
      );
    }

    this.model = requireModelId(rawModel);
    this.name = `openai-compatible/${this.model}`;
    this.endpoint = endpoint.href;
    this.apiKey = apiKey;
    this.organization = organization;
    this.project = project;
    this.timeoutMs = timeoutMs;
    this.maxRequestBytes = maxRequestBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.maxTokensParameter = (rawMaxTokensParameter ??
      "max_tokens") as OpenAIMaxTokensParameter;
    this.fetchImpl = fetchImpl as OpenAICompatibleFetch;
    this.secrets = [apiKey, organization, project]
      .filter((value): value is string => value !== undefined)
      .sort((left, right) => right.length - left.length);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!isPlainRecord(request)) {
      throw invalidRequest("completion request must be an object");
    }
    const rawMessages = requestProperty(
      request,
      "messages",
      "completion request messages",
    );
    const rawModel = requestProperty(
      request,
      "model",
      "completion request model",
    );
    const rawMaxTokens = requestProperty(
      request,
      "maxTokens",
      "completion request maxTokens",
    );
    const rawSystem = requestProperty(
      request,
      "system",
      "completion request system",
    );
    const rawSignal = requestProperty(
      request,
      "signal",
      "completion request signal",
    );
    const rawTools = requestProperty(
      request,
      "tools",
      "completion request tools",
    );
    const rawProviderOptions = requestProperty(
      request,
      "providerOptions",
      "completion request providerOptions",
    );
    const requestMessages = readOrdinaryArray(
      rawMessages,
      "completion request messages",
      MAX_MESSAGES,
    );
    if (rawModel !== undefined && rawModel !== this.model) {
      throw invalidRequest(
        `completion request model must match the adapter model (${this.model})`,
      );
    }
    if (
      rawMaxTokens !== undefined &&
      (!Number.isSafeInteger(rawMaxTokens) || (rawMaxTokens as number) <= 0)
    ) {
      throw invalidRequest(
        "completion request maxTokens must be a positive safe integer",
      );
    }
    if (rawSystem !== undefined && typeof rawSystem !== "string") {
      throw invalidRequest("completion request system must be a string");
    }
    const callerSignal = rawSignal;
    if (callerSignal !== undefined && !isAbortSignal(callerSignal)) {
      throw invalidRequest("completion request signal must be an AbortSignal");
    }
    if (callerSignal?.aborted) {
      throw new ModelProviderError(
        "MODEL_ABORTED",
        "model provider request was aborted by the caller",
      );
    }

    const byteBudget: RequestByteBudget = {
      used: Buffer.byteLength(this.model, "utf8"),
      maximum: this.maxRequestBytes,
    };
    const messages = this.mapMessages(
      rawSystem as string | undefined,
      requestMessages,
      byteBudget,
    );
    const tools = this.mapTools(
      rawTools as ToolDefinition[] | undefined,
      byteBudget,
    );
    const providerOptions = this.mapProviderOptions(
      rawProviderOptions as Record<string, unknown> | undefined,
      byteBudget,
    );

    const body: Record<string, unknown> = Object.assign(
      Object.create(null) as Record<string, unknown>,
      providerOptions,
      {
        model: this.model,
        messages,
        stream: false,
      },
    );
    if (tools !== undefined) body.tools = tools;
    if (rawMaxTokens !== undefined) {
      body[this.maxTokensParameter] = rawMaxTokens;
    }

    let encodedBody: string;
    try {
      encodedBody = JSON.stringify(body);
    } catch {
      throw invalidRequest("completion request could not be serialized");
    }
    if (Buffer.byteLength(encodedBody, "utf8") > this.maxRequestBytes) {
      throw invalidRequest(
        "completion request exceeded the configured size limit",
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey !== undefined) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.organization !== undefined) {
      headers["OpenAI-Organization"] = this.organization;
    }
    if (this.project !== undefined) {
      headers["OpenAI-Project"] = this.project;
    }

    const controller = new AbortController();
    let abortSource: "caller" | "timeout" | undefined;
    let rejectAbort!: (cause: ModelProviderError) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = (source: "caller" | "timeout") => {
      if (abortSource !== undefined) return;
      abortSource = source;
      const error = source === "timeout"
        ? new ModelProviderError(
            "MODEL_TIMEOUT",
            `model provider request timed out after ${this.timeoutMs}ms`,
            { retryable: true },
          )
        : new ModelProviderError(
            "MODEL_ABORTED",
            "model provider request was aborted by the caller",
          );
      controller.abort(error);
      rejectAbort(error);
    };
    const onCallerAbort = () => abort("caller");
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    // Close the race between the initial aborted check and listener install.
    if (callerSignal?.aborted) onCallerAbort();
    const timer = abortSource === undefined
      ? setTimeout(() => abort("timeout"), this.timeoutMs)
      : undefined;

    try {
      if (abortSource !== undefined) return await abortPromise;
      const operation = this.performRequest(
        encodedBody,
        headers,
        body,
        controller.signal,
      );
      return await Promise.race([operation, abortPromise]);
    } catch (cause) {
      if (cause instanceof ModelProviderError) throw cause;
      if (abortSource === "timeout") {
        throw new ModelProviderError(
          "MODEL_TIMEOUT",
          `model provider request timed out after ${this.timeoutMs}ms`,
          { retryable: true },
        );
      }
      if (abortSource === "caller") {
        throw new ModelProviderError(
          "MODEL_ABORTED",
          "model provider request was aborted by the caller",
          {},
        );
      }
      throw new ModelProviderError(
        "MODEL_TRANSPORT_ERROR",
        `model provider transport failed: ${this.sanitize(this.errorMessage(cause))}`,
        { retryable: true },
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async performRequest(
    encodedBody: string,
    headers: Record<string, string>,
    requestBody: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CompletionResponse> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: encodedBody,
      signal,
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const rawProviderRequestId = response.headers.get("x-request-id");
    const providerRequestId = rawProviderRequestId === null
      ? undefined
      : this.sanitize(rawProviderRequestId).slice(0, 200);
    const declaredLengthHeader = response.headers.get("content-length");
    if (
      declaredLengthHeader !== null &&
      /^\d+$/.test(declaredLengthHeader) &&
      Number(declaredLengthHeader) > this.maxResponseBytes
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(
        "MODEL_INVALID_RESPONSE",
        "model provider response exceeded the configured size limit",
        { providerRequestId },
      );
    }

    const text = await this.readResponseText(
      response,
      signal,
      providerRequestId,
    );
    if (!response.ok) {
      throw this.httpError(response.status, text, providerRequestId);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ModelProviderError(
        "MODEL_INVALID_RESPONSE",
        "model provider returned invalid JSON",
        { providerRequestId },
      );
    }
    return this.decodeCompletion(raw, requestBody, providerRequestId);
  }

  private async readResponseText(
    response: Response,
    signal: AbortSignal,
    providerRequestId?: string,
  ): Promise<string> {
    if (response.body === null) return "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let totalBytes = 0;
    let chunks = 0;
    const cancelReader = (reason?: unknown) => {
      try {
        void reader.cancel(reason).catch(() => undefined);
      } catch {
        // The primary typed boundary error remains authoritative.
      }
    };
    const onAbort = () => cancelReader(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) break;
        chunks += 1;
        if (chunks > MAX_RESPONSE_CHUNKS) {
          cancelReader();
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            "model provider response exceeded the stream chunk limit",
            { providerRequestId },
          );
        }
        if (!(value instanceof Uint8Array)) {
          cancelReader();
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            "model provider response contained a non-byte stream chunk",
            { providerRequestId },
          );
        }
        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          cancelReader();
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            "model provider response exceeded the configured size limit",
            { providerRequestId },
          );
        }
        try {
          const decoded = decoder.decode(value, { stream: true });
          if (decoded.length > 0) parts.push(decoded);
        } catch {
          cancelReader();
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            "model provider response was not valid UTF-8",
            { providerRequestId },
          );
        }
      }
      try {
        const tail = decoder.decode();
        if (tail.length > 0) parts.push(tail);
      } catch {
        throw new ModelProviderError(
          "MODEL_INVALID_RESPONSE",
          "model provider response was not valid UTF-8",
          { providerRequestId },
        );
      }
      return parts.join("");
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // A hostile/custom stream must not replace the typed boundary error.
      }
    }
  }

  private mapMessages(
    system: string | undefined,
    requestMessages: unknown[],
    byteBudget: RequestByteBudget,
  ): WireMessage[] {
    const messages: WireMessage[] = [];
    Object.defineProperty(messages, "toJSON", {
      configurable: true,
      value: undefined,
    });
    if (system !== undefined) {
      chargeRequestBytes(
        byteBudget,
        system,
        "completion request system",
      );
      messages.push({ role: "system", content: system });
    }
    for (let index = 0; index < requestMessages.length; index++) {
      messages.push(
        this.mapMessage(
          requestMessages[index] as ChatMessage | undefined,
          index,
          byteBudget,
        ),
      );
    }
    return messages;
  }

  private mapMessage(
    message: ChatMessage | undefined,
    index: number,
    byteBudget: RequestByteBudget,
  ): WireMessage {
    if (!isPlainRecord(message)) {
      throw invalidRequest(`completion request messages[${index}] must be an object`);
    }
    const role = requestProperty(
      message,
      "role",
      `completion request messages[${index}].role`,
    );
    const content = requestProperty(
      message,
      "content",
      `completion request messages[${index}].content`,
    );
    if (typeof content !== "string") {
      throw invalidRequest(
        `completion request messages[${index}].content must be a string`,
      );
    }
    chargeRequestBytes(
      byteBudget,
      content,
      `completion request messages[${index}].content`,
    );

    switch (role) {
      case "system":
      case "user":
        return { role, content };
      case "assistant": {
        const toolCalls = requestProperty(
          message,
          "toolCalls",
          `completion request messages[${index}].toolCalls`,
        );
        if (toolCalls === undefined) {
          return { role: "assistant", content };
        }
        const calls = readOrdinaryArray(
          toolCalls,
          `completion request messages[${index}].toolCalls`,
          MAX_TOOL_CALLS,
        );
        if (calls.length === 0) {
          return { role: "assistant", content };
        }
        const seen = new Set<string>();
        const mapped: Record<string, unknown>[] = [];
        Object.defineProperty(mapped, "toJSON", {
          configurable: true,
          value: undefined,
        });
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          const result = this.mapHistoricalToolCall(
            calls[callIndex] as ToolCall | undefined,
            index,
            callIndex,
            byteBudget,
          );
          if (seen.has(result.id)) {
            throw invalidRequest(
              `completion request messages[${index}] has a duplicate tool call id at index ${callIndex}`,
            );
          }
          seen.add(result.id);
          mapped.push(result.wire);
        }
        return {
          role: "assistant",
          content: content.length > 0 ? content : null,
          tool_calls: mapped,
        };
      }
      case "tool": {
        const name = requireWireString(
          requestProperty(
            message,
            "name",
            `completion request messages[${index}].name`,
          ),
          `completion request messages[${index}].name`,
          MAX_TOOL_NAME_LENGTH,
        );
        const toolCallId = requireWireString(
          requestProperty(
            message,
            "toolCallId",
            `completion request messages[${index}].toolCallId`,
          ),
          `completion request messages[${index}].toolCallId`,
          MAX_WIRE_ID_LENGTH,
        );
        chargeRequestBytes(
          byteBudget,
          name,
          `completion request messages[${index}].name`,
        );
        chargeRequestBytes(
          byteBudget,
          toolCallId,
          `completion request messages[${index}].toolCallId`,
        );
        return {
          role: "tool",
          content,
          tool_call_id: toolCallId,
        };
      }
      default:
        throw invalidRequest(
          `completion request messages[${index}] has an unsupported role`,
        );
    }
  }

  private mapHistoricalToolCall(
    call: ToolCall | undefined,
    messageIndex: number,
    callIndex: number,
    byteBudget: RequestByteBudget,
  ): { id: string; wire: Record<string, unknown> } {
    if (!isPlainRecord(call)) {
      throw invalidRequest(
        `completion request messages[${messageIndex}].toolCalls[${callIndex}] must be an object`,
      );
    }
    const id = requireWireString(
      requestProperty(
        call,
        "id",
        `completion request messages[${messageIndex}].toolCalls[${callIndex}].id`,
      ),
      `completion request messages[${messageIndex}].toolCalls[${callIndex}].id`,
      MAX_WIRE_ID_LENGTH,
    );
    const name = requireWireString(
      requestProperty(
        call,
        "name",
        `completion request messages[${messageIndex}].toolCalls[${callIndex}].name`,
      ),
      `completion request messages[${messageIndex}].toolCalls[${callIndex}].name`,
      MAX_TOOL_NAME_LENGTH,
    );
    chargeRequestBytes(byteBudget, id, "completion request tool call id");
    chargeRequestBytes(byteBudget, name, "completion request tool call name");
    const normalizedArguments = normalizeRequestJson(
      requestProperty(
        call,
        "arguments",
        `completion request messages[${messageIndex}].toolCalls[${callIndex}].arguments`,
      ),
      `completion request messages[${messageIndex}].toolCalls[${callIndex}].arguments`,
      byteBudget,
    );
    return {
      id,
      wire: {
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(normalizedArguments),
        },
      },
    };
  }

  private mapTools(
    definitions: ToolDefinition[] | undefined,
    byteBudget: RequestByteBudget,
  ): Record<string, unknown>[] | undefined {
    if (definitions === undefined) return undefined;
    const entries = readOrdinaryArray(
      definitions,
      "completion request tools",
      MAX_TOOLS,
    );
    if (entries.length === 0) return undefined;
    const seen = new Set<string>();
    const mapped: Record<string, unknown>[] = [];
    Object.defineProperty(mapped, "toJSON", {
      configurable: true,
      value: undefined,
    });
    for (let index = 0; index < entries.length; index++) {
      const definition = entries[index];
      if (!isPlainRecord(definition)) {
        throw invalidRequest(`completion request tools[${index}] must be an object`);
      }
      const name = requireWireString(
        requestProperty(
          definition,
          "name",
          `completion request tools[${index}].name`,
        ),
        `completion request tools[${index}].name`,
        MAX_TOOL_NAME_LENGTH,
      );
      if (seen.has(name)) {
        throw invalidRequest(
          `completion request tools contains a duplicate name at index ${index}`,
        );
      }
      seen.add(name);
      const description = requestProperty(
        definition,
        "description",
        `completion request tools[${index}].description`,
      );
      if (typeof description !== "string") {
        throw invalidRequest(
          `completion request tools[${index}].description must be a string`,
        );
      }
      chargeRequestBytes(byteBudget, name, "completion request tool name");
      chargeRequestBytes(
        byteBudget,
        description,
        "completion request tool description",
      );
      const rawInputSchema = requestProperty(
        definition,
        "inputSchema",
        `completion request tools[${index}].inputSchema`,
      );
      if (!isPlainRecord(rawInputSchema)) {
        throw invalidRequest(
          `completion request tools[${index}].inputSchema must be an object`,
        );
      }
      const inputSchema = normalizeRequestJson(
        rawInputSchema,
        `completion request tools[${index}].inputSchema`,
        byteBudget,
      );
      if (!isPlainRecord(inputSchema)) {
        throw invalidRequest(
          `completion request tools[${index}].inputSchema must be an object`,
        );
      }
      mapped.push({
        type: "function",
        function: {
          name,
          description,
          parameters: inputSchema,
        },
      });
    }
    return mapped;
  }

  private mapProviderOptions(
    options: Record<string, unknown> | undefined,
    byteBudget: RequestByteBudget,
  ): Record<string, JsonValue> {
    if (options === undefined) return {};
    if (!isPlainRecord(options)) {
      throw invalidRequest("completion request providerOptions must be an object");
    }
    const normalizedOptions = normalizeRequestJson(
      options,
      "completion request providerOptions",
      byteBudget,
    );
    if (!isPlainRecord(normalizedOptions)) {
      throw invalidRequest("completion request providerOptions must be an object");
    }
    const entries = Object.entries(normalizedOptions);
    if (entries.length > MAX_PROVIDER_OPTIONS) {
      throw invalidRequest(
        `completion request providerOptions must contain at most ${MAX_PROVIDER_OPTIONS} fields`,
      );
    }
    for (const [key, value] of entries) {
      if (RESERVED_PROVIDER_OPTIONS.has(key)) {
        throw invalidRequest(`providerOptions may not override ${key}`);
      }
    }
    return normalizedOptions;
  }

  private decodeCompletion(
    raw: unknown,
    requestBody: Record<string, unknown>,
    providerRequestId?: string,
  ): CompletionResponse {
    const parsed = completionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ModelProviderError(
        "MODEL_INVALID_RESPONSE",
        "model provider response did not match the Chat Completions schema",
        { providerRequestId, details: zodDetails(parsed.error) },
      );
    }
    if (parsed.data.choices.length !== 1 || parsed.data.choices[0]?.index !== 0) {
      throw new ModelProviderError(
        "MODEL_INVALID_RESPONSE",
        "model provider must return exactly one choice with index 0",
        { providerRequestId },
      );
    }

    const choice = parsed.data.choices[0];
    const content = choice.message.content ?? "";
    const toolCalls = this.decodeToolCalls(
      choice.message.tool_calls ?? [],
      providerRequestId,
    );

    let finishReason: CompletionResponse["finishReason"];
    switch (choice.finish_reason) {
      case "stop":
      case "length":
        if (toolCalls.length > 0) {
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            `model provider returned tool calls with finish_reason=${choice.finish_reason}`,
            { providerRequestId },
          );
        }
        finishReason = choice.finish_reason;
        break;
      case "tool_calls":
        if (toolCalls.length === 0) {
          throw new ModelProviderError(
            "MODEL_INVALID_RESPONSE",
            "model provider returned finish_reason=tool_calls without tool calls",
            { providerRequestId },
          );
        }
        finishReason = "tool_calls";
        break;
      case "content_filter":
        throw new ModelProviderError(
          "MODEL_CONTENT_FILTERED",
          "model provider filtered the completion",
          { providerRequestId },
        );
      case "function_call":
        throw new ModelProviderError(
          "MODEL_UNSUPPORTED_RESPONSE",
          "legacy function_call responses are not supported; use tool_calls",
          { providerRequestId },
        );
      default:
        throw new ModelProviderError(
          "MODEL_UNSUPPORTED_RESPONSE",
          `unsupported model provider finish reason: ${this.sanitize(choice.finish_reason)}`,
          { providerRequestId },
        );
    }

    const usage = parsed.data.usage
      ? {
          promptTokens: parsed.data.usage.prompt_tokens,
          completionTokens: parsed.data.usage.completion_tokens,
          totalTokens: parsed.data.usage.total_tokens,
        }
      : this.estimateUsage(requestBody, content, toolCalls);

    if (
      parsed.data.usage &&
      usage.totalTokens !== usage.promptTokens + usage.completionTokens
    ) {
      throw new ModelProviderError(
        "MODEL_INVALID_RESPONSE",
        "model provider usage total_tokens did not equal prompt_tokens plus completion_tokens",
        { providerRequestId },
      );
    }

    return {
      id: parsed.data.id,
      content,
      toolCalls,
      usage,
      finishReason,
    };
  }

  private decodeToolCalls(
    rawCalls: unknown[],
    providerRequestId?: string,
  ): ToolCall[] {
    const calls: ToolCall[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < rawCalls.length; index++) {
      const raw = rawCalls[index];
      if (isPlainRecord(raw) && raw.type !== "function") {
        throw new ModelProviderError(
          "MODEL_UNSUPPORTED_RESPONSE",
          `unsupported model provider tool call type at index ${index}`,
          { providerRequestId },
        );
      }
      const parsed = functionToolCallSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ModelProviderError(
          "MODEL_INVALID_RESPONSE",
          `model provider tool call ${index} was invalid`,
          { providerRequestId, details: zodDetails(parsed.error) },
        );
      }
      if (seen.has(parsed.data.id)) {
        throw new ModelProviderError(
          "MODEL_INVALID_RESPONSE",
          `model provider returned a duplicate tool call id at index ${index}`,
          { providerRequestId },
        );
      }
      seen.add(parsed.data.id);

      let args: unknown;
      try {
        args = JSON.parse(parsed.data.function.arguments);
      } catch {
        throw new ModelProviderError(
          "MODEL_INVALID_RESPONSE",
          `model provider tool call ${index} contained invalid JSON arguments`,
          { providerRequestId },
        );
      }
      args = normalizeResponseJson(
        args,
        `model provider tool call ${index} arguments`,
        providerRequestId,
      );
      calls.push({
        id: parsed.data.id,
        name: parsed.data.function.name,
        arguments: args,
      });
    }
    return calls;
  }

  private estimateUsage(
    requestBody: Record<string, unknown>,
    content: string,
    toolCalls: ToolCall[],
  ): Usage {
    const prompt = JSON.stringify({
      messages: requestBody.messages,
      tools: requestBody.tools ?? [],
    });
    const completion = [
      content,
      ...toolCalls.map((call) =>
        JSON.stringify({ name: call.name, arguments: call.arguments }),
      ),
    ].join("\n");
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(completion);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  private httpError(
    status: number,
    text: string,
    providerRequestId?: string,
  ): ModelProviderError {
    let providerMessage = text.trim();
    let providerCode: string | undefined;
    try {
      const raw: unknown = JSON.parse(text);
      const parsed = providerErrorSchema.safeParse(raw);
      if (parsed.success) {
        providerMessage = parsed.data.error.message ?? providerMessage;
        const code = parsed.data.error.code ?? parsed.data.error.type;
        providerCode = code === null || code === undefined
          ? undefined
          : this.sanitize(String(code)).slice(0, 200);
      }
    } catch {
      // Plain-text error bodies are common across compatible providers.
    }
    const suffix = providerMessage.length > 0
      ? `: ${this.sanitize(providerMessage).slice(0, 500)}`
      : "";
    const common = {
      status,
      providerRequestId,
      providerCode,
    };
    if (status === 401 || status === 403) {
      return new ModelProviderError(
        "MODEL_AUTH_ERROR",
        `model provider authentication failed with HTTP ${status}${suffix}`,
        common,
      );
    }
    if (status === 429) {
      return new ModelProviderError(
        "MODEL_RATE_LIMITED",
        `model provider rate limited the request${suffix}`,
        { ...common, retryable: true },
      );
    }
    return new ModelProviderError(
      "MODEL_HTTP_ERROR",
      `model provider returned HTTP ${status}${suffix}`,
      {
        ...common,
        retryable: status === 408 || status === 409 || status >= 500,
      },
    );
  }

  private sanitize(value: string): string {
    let sanitized = value;
    for (const secret of this.secrets) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
    return sanitized.replace(
      /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,
      " ",
    );
  }

  private errorMessage(cause: unknown): string {
    try {
      return cause instanceof Error ? cause.message : String(cause);
    } catch {
      return "unknown transport error";
    }
  }
}

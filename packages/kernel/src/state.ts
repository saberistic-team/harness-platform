import type {
  ChatMessage,
  JsonValue,
  ToolCall,
  ToolDefinition,
} from "@harness/models";

export const MESSAGE_STATE_VERSION = 1 as const;
export const MODEL_CONTEXT_VERSION = 1 as const;

/** Immutable, replayable conversation state owned by the runtime. */
export interface VersionedMessageState {
  readonly version: typeof MESSAGE_STATE_VERSION;
  readonly revision: number;
  readonly messages: readonly ChatMessage[];
}

/** A detached snapshot that is safe to hand to a model adapter. */
export interface VersionedModelContext {
  readonly version: typeof MODEL_CONTEXT_VERSION;
  readonly messageRevision: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
}

export class InvalidMessageStateError extends Error {
  readonly code = "RUNTIME_INVALID_MESSAGE_STATE";

  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageStateError";
  }
}

type PlainRecord = Record<string, unknown>;

const MAX_STATE_DEPTH = 64;
const MAX_STATE_NODES = 100_000;

interface CloneBudget {
  nodes: number;
  readonly ancestors: Set<object>;
}

function invalid(message: string): never {
  throw new InvalidMessageStateError(message);
}

function plainRecord(value: unknown, path: string): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalid(`${path} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${path} must be a plain object`);
  }
  return value as PlainRecord;
}

function ownValue(record: PlainRecord, key: string, path: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return invalid(`${path} could not be inspected`);
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    return invalid(`${path} must be an ordinary data property`);
  }
  return descriptor.value;
}

function assertOnlyKeys(
  record: PlainRecord,
  allowed: readonly string[],
  path: string,
): void {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return invalid(`${path} could not be inspected`);
  }
  const allowedKeys = new Set(allowed);
  for (const key of keys) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      return invalid(`${path} contains an unknown field`);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") return invalid(`${path} must be a string`);
  return value;
}

function arrayValues(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return invalid(`${path} must be an array`);
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
  } catch {
    return invalid(`${path} could not be inspected`);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_STATE_NODES
  ) {
    return invalid(`${path} has an invalid or oversized length`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index++) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return invalid(`${path}[${index}] must be an ordinary array item`);
    }
    result.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(descriptors).some((key) => {
      if (key === "length") return false;
      if (typeof key === "symbol") return true;
      const index = Number(key);
      return !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= (length as number) ||
        String(index) !== key;
    })
  ) {
    return invalid(`${path} must not contain named or symbol properties`);
  }
  return result;
}

/** Clone and freeze the JSON data carried by tool calls and definitions. */
function cloneJson(
  value: unknown,
  path: string,
  budget: CloneBudget = { nodes: 0, ancestors: new Set() },
  depth = 0,
): JsonValue {
  budget.nodes++;
  if (budget.nodes > MAX_STATE_NODES) {
    return invalid(`${path} exceeds the state node limit`);
  }
  if (depth > MAX_STATE_DEPTH) {
    return invalid(`${path} exceeds the state depth limit`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(`${path} must contain finite numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    return invalid(`${path} must be JSON-compatible`);
  }
  if (budget.ancestors.has(value)) {
    return invalid(`${path} must not contain cycles`);
  }
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        arrayValues(value, path).map((item, index) =>
          cloneJson(item, `${path}[${index}]`, budget, depth + 1)
        ),
      ) as unknown as JsonValue;
    }
    const source = plainRecord(value, path);
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(source);
    } catch {
      return invalid(`${path} could not be inspected`);
    }
    const cloned: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        return invalid(`${path} must not contain symbol keys`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return invalid(`${path}.${key} must be an enumerable data property`);
      }
      cloned[key] = cloneJson(
        descriptor.value,
        `${path}.${key}`,
        budget,
        depth + 1,
      );
    }
    return Object.freeze(cloned) as JsonValue;
  } finally {
    budget.ancestors.delete(value);
  }
}

function cloneToolCall(value: unknown, path: string): ToolCall {
  const source = plainRecord(value, path);
  assertOnlyKeys(source, ["id", "name", "arguments"], path);
  return Object.freeze({
    id: stringValue(ownValue(source, "id", `${path}.id`), `${path}.id`),
    name: stringValue(ownValue(source, "name", `${path}.name`), `${path}.name`),
    arguments: cloneJson(
      ownValue(source, "arguments", `${path}.arguments`),
      `${path}.arguments`,
    ),
  });
}

function cloneMessage(value: unknown, path: string): ChatMessage {
  const source = plainRecord(value, path);
  const role = ownValue(source, "role", `${path}.role`);
  const content = stringValue(
    ownValue(source, "content", `${path}.content`),
    `${path}.content`,
  );

  switch (role) {
    case "system":
    case "user":
      assertOnlyKeys(source, ["role", "content"], path);
      return Object.freeze({ role, content });
    case "assistant": {
      assertOnlyKeys(source, ["role", "content", "toolCalls"], path);
      const rawCalls = ownValue(source, "toolCalls", `${path}.toolCalls`);
      if (rawCalls === undefined) return Object.freeze({ role, content });
      const toolCalls = arrayValues(rawCalls, `${path}.toolCalls`).map(
        (call, index) => cloneToolCall(call, `${path}.toolCalls[${index}]`),
      );
      return Object.freeze({
        role,
        content,
        toolCalls: Object.freeze(toolCalls),
      });
    }
    case "tool":
      assertOnlyKeys(
        source,
        ["role", "content", "name", "toolCallId"],
        path,
      );
      return Object.freeze({
        role,
        content,
        name: stringValue(
          ownValue(source, "name", `${path}.name`),
          `${path}.name`,
        ),
        toolCallId: stringValue(
          ownValue(source, "toolCallId", `${path}.toolCallId`),
          `${path}.toolCallId`,
        ),
      });
    default:
      return invalid(`${path}.role is not a supported chat role`);
  }
}

function cloneMessages(value: unknown, path: string): readonly ChatMessage[] {
  return Object.freeze(
    arrayValues(value, path).map((message, index) =>
      cloneMessage(message, `${path}[${index}]`)
    ),
  );
}

function cloneToolDefinition(value: unknown, path: string): ToolDefinition {
  const source = plainRecord(value, path);
  assertOnlyKeys(source, ["name", "description", "inputSchema"], path);
  const inputSchema = cloneJson(
    ownValue(source, "inputSchema", `${path}.inputSchema`),
    `${path}.inputSchema`,
  );
  if (
    typeof inputSchema !== "object" ||
    inputSchema === null ||
    Array.isArray(inputSchema)
  ) {
    return invalid(`${path}.inputSchema must be an object`);
  }
  return Object.freeze({
    name: stringValue(
      ownValue(source, "name", `${path}.name`),
      `${path}.name`,
    ),
    description: stringValue(
      ownValue(source, "description", `${path}.description`),
      `${path}.description`,
    ),
    inputSchema,
  });
}

function cloneState(value: unknown): VersionedMessageState {
  const source = plainRecord(value, "message state");
  assertOnlyKeys(source, ["version", "revision", "messages"], "message state");
  const version = ownValue(source, "version", "message state.version");
  if (version !== MESSAGE_STATE_VERSION) {
    return invalid(`unsupported message state version: ${String(version)}`);
  }
  const revision = ownValue(source, "revision", "message state.revision");
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    return invalid("message state.revision must be a nonnegative safe integer");
  }
  const messages = cloneMessages(
    ownValue(source, "messages", "message state.messages"),
    "message state.messages",
  );
  if ((revision as number) < messages.length) {
    return invalid("message state.revision cannot be behind its messages");
  }
  return Object.freeze({
    version: MESSAGE_STATE_VERSION,
    revision: revision as number,
    messages,
  });
}

/** Create state from already-replayed prior model context. */
export function createMessageState(
  priorContext: readonly ChatMessage[] = [],
): VersionedMessageState {
  const messages = cloneMessages(priorContext, "prior context");
  return Object.freeze({
    version: MESSAGE_STATE_VERSION,
    revision: messages.length,
    messages,
  });
}

/** Append without retaining any mutable reference from either argument. */
export function appendMessage(
  state: VersionedMessageState,
  message: ChatMessage,
): VersionedMessageState {
  const current = cloneState(state);
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    return invalid("message state revision cannot advance safely");
  }
  return Object.freeze({
    version: MESSAGE_STATE_VERSION,
    revision: current.revision + 1,
    messages: Object.freeze([
      ...current.messages,
      cloneMessage(message, `message state.messages[${current.messages.length}]`),
    ]),
  });
}

/** Build a detached, deeply immutable request snapshot. */
export function buildModelContext(
  state: VersionedMessageState,
  toolDefinitions: readonly ToolDefinition[] = [],
): VersionedModelContext {
  const current = cloneState(state);
  const tools = Object.freeze(
    arrayValues(toolDefinitions, "tool definitions").map((tool, index) =>
      cloneToolDefinition(tool, `tool definitions[${index}]`)
    ),
  );
  return Object.freeze({
    version: MODEL_CONTEXT_VERSION,
    messageRevision: current.revision,
    messages: current.messages,
    tools,
  });
}

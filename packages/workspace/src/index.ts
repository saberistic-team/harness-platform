/**
 * Workspace contracts.
 *
 * `WorkspacePathScope` is the original lexical path-scoping seed. It remains
 * useful to trusted outer adapters, but it is deliberately not the
 * operational capability passed to the kernel or model-facing tools.
 */
import { isAbsolute, normalize, resolve, sep } from "node:path";

export class WorkspaceEscapesRootError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`path "${requested}" escapes the workspace root "${root}"`);
    this.name = "WorkspaceEscapesRootError";
  }
}

/** A lexical path scope for trusted launch and service boundaries. */
export interface WorkspacePathScope {
  /** Absolute, normalized root of the task's file access. */
  readonly root: string;
  /** Resolve a caller-supplied path inside the root or throw. */
  resolvePath(requested: string): string;
}

/**
 * Open a lexical path scope.
 *
 * This helper does not read, write, or execute anything and is not an
 * operational `Workspace` implementation.
 */
export function openWorkspace(root: string): WorkspacePathScope {
  const abs = resolve(root);
  // Ensure a path separator boundary so `workspace` and
  // `workspace-evil` do not alias.
  const boundary = abs.endsWith(sep) ? abs : abs + sep;

  return {
    root: abs,
    resolvePath(requested: string) {
      const candidate = isAbsolute(requested)
        ? normalize(requested)
        : normalize(abs + sep + requested);
      if (candidate !== abs && !candidate.startsWith(boundary)) {
        throw new WorkspaceEscapesRootError(requested, abs);
      }
      return candidate;
    },
  };
}

export type WorkspaceJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceJsonValue[]
  | { [key: string]: WorkspaceJsonValue };

export interface CommandRequest {
  argv: readonly [string, ...string[]];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface WorkspaceSnapshot {
  id: string;
  createdAt: string;
  metadata?: Readonly<Record<string, WorkspaceJsonValue>>;
}

/**
 * The operational filesystem/process capability injected into the runtime.
 *
 * This interface deliberately contains no host root, implementation selector,
 * or provider-facing operation names. Local and Docker implementations arrive
 * in later milestones. Model-facing code reaches these methods only through a
 * bounded tool and `invokeWorkspaceOperation`.
 */
export interface Workspace {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  execute(command: CommandRequest): Promise<CommandResult>;
  diff(): Promise<string>;
  snapshot(): Promise<WorkspaceSnapshot>;
  dispose(): Promise<void>;
}

/** Transport-neutral names for the operations exposed by `Workspace`. */
export const WORKSPACE_CAPABILITIES = Object.freeze([
  "readFile",
  "writeFile",
  "listFiles",
  "execute",
  "diff",
  "snapshot",
  "dispose",
] as const);

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

const workspaceCapabilitySet = new Set<WorkspaceCapability>(
  WORKSPACE_CAPABILITIES,
);

export type WorkspaceOperationErrorCode =
  | "WORKSPACE_OPERATION_REQUIRED"
  | "WORKSPACE_OPERATION_MALFORMED"
  | "WORKSPACE_OPERATION_UNKNOWN"
  | "WORKSPACE_OPERATION_UNSUPPORTED";

/** Base class for typed failures at the operational capability boundary. */
export class WorkspaceOperationError extends Error {
  constructor(
    readonly code: WorkspaceOperationErrorCode,
    message: string,
    readonly operation?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceOperationError";
  }
}

/** The caller omitted the workspace or operation required for dispatch. */
export class WorkspaceOperationRequiredError extends WorkspaceOperationError {
  constructor(message = "workspace capability is required") {
    super("WORKSPACE_OPERATION_REQUIRED", message);
    this.name = "WorkspaceOperationRequiredError";
  }
}

/** The operation envelope, arguments, capability, or result is malformed. */
export class WorkspaceOperationMalformedError extends WorkspaceOperationError {
  constructor(message: string, operation?: string, options?: ErrorOptions) {
    super("WORKSPACE_OPERATION_MALFORMED", message, operation, options);
    this.name = "WorkspaceOperationMalformedError";
  }
}

/** The caller requested a name outside the canonical operation vocabulary. */
export class WorkspaceOperationUnknownError extends WorkspaceOperationError {
  constructor(operation: string) {
    super(
      "WORKSPACE_OPERATION_UNKNOWN",
      `unknown workspace operation: ${operation}`,
      operation,
    );
    this.name = "WorkspaceOperationUnknownError";
  }
}

/** The injected implementation does not provide a canonical capability. */
export class WorkspaceOperationUnsupportedError extends WorkspaceOperationError {
  constructor(
    operation: WorkspaceCapability,
    message = `workspace does not support operation: ${operation}`,
    options?: ErrorOptions,
  ) {
    super("WORKSPACE_OPERATION_UNSUPPORTED", message, operation, options);
    this.name = "WorkspaceOperationUnsupportedError";
  }
}

export interface WorkspaceOperationRequestMap {
  readFile: Readonly<{ operation: "readFile"; path: string }>;
  writeFile: Readonly<{
    operation: "writeFile";
    path: string;
    contents: string;
  }>;
  listFiles: Readonly<{ operation: "listFiles"; path: string }>;
  execute: Readonly<{ operation: "execute"; command: CommandRequest }>;
  diff: Readonly<{ operation: "diff" }>;
  snapshot: Readonly<{ operation: "snapshot" }>;
  dispose: Readonly<{ operation: "dispose" }>;
}

export interface WorkspaceOperationResultMap {
  readFile: string;
  writeFile: void;
  listFiles: string[];
  execute: CommandResult;
  diff: string;
  snapshot: WorkspaceSnapshot;
  dispose: void;
}

export type WorkspaceOperationRequest<
  Capability extends WorkspaceCapability = WorkspaceCapability,
> = WorkspaceOperationRequestMap[Capability];

export type WorkspaceOperationResult<
  Capability extends WorkspaceCapability = WorkspaceCapability,
> = WorkspaceOperationResultMap[Capability];

type UnknownRecord = Record<PropertyKey, unknown>;
type BoundMethod = (...args: never[]) => unknown;
const MAX_WORKSPACE_ARRAY_ITEMS = 100_000;
const composeAbortSignals = AbortSignal.any.bind(AbortSignal);
const readNativeAbortState = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function ownKeys(
  value: object,
  operation?: string,
): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch (cause) {
    throw new WorkspaceOperationMalformedError(
      "workspace operation properties could not be inspected",
      operation,
      { cause },
    );
  }
}

function readOwnDataProperty(
  value: UnknownRecord,
  key: string,
  operation?: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch (cause) {
    throw new WorkspaceOperationMalformedError(
      `workspace operation property ${key} could not be inspected`,
      operation,
      { cause },
    );
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new WorkspaceOperationMalformedError(
      `workspace operation property ${key} must be a data property`,
      operation,
    );
  }
  return descriptor.value;
}

function readArrayLength(
  value: unknown[],
  operation: WorkspaceCapability,
  field: string,
): number {
  const length = readOwnDataProperty(
    value as unknown as UnknownRecord,
    "length",
    operation,
  );
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_WORKSPACE_ARRAY_ITEMS
  ) {
    throw new WorkspaceOperationMalformedError(
      `${field}.length must be between 0 and ${MAX_WORKSPACE_ARRAY_ITEMS}`,
      operation,
    );
  }
  return length as number;
}

function assertExactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  operation?: string,
): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  const unexpected = ownKeys(value, operation).find(
    (key) => !allowedKeys.has(key),
  );
  if (unexpected !== undefined) {
    throw new WorkspaceOperationMalformedError(
      `workspace operation contains unexpected property ${String(unexpected)}`,
      operation,
    );
  }
}

function requireNonemptyString(
  value: unknown,
  field: string,
  operation: WorkspaceCapability,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkspaceOperationMalformedError(
      `${operation}.${field} must be a nonempty string`,
      operation,
    );
  }
  return value;
}

function normalizeAbortSignal(value: unknown): AbortSignal {
  try {
    // The intrinsic getter performs the native internal-slot/brand check on
    // every supported Node 22+ runtime. Composition then returns an
    // unshadowed platform signal while preserving future aborts.
    if (readNativeAbortState === undefined) throw new TypeError("missing native getter");
    Reflect.apply(readNativeAbortState, value, []);
    return composeAbortSignals([value as AbortSignal]);
  } catch (cause) {
    throw new WorkspaceOperationMalformedError(
      "execute.command.signal must be a native AbortSignal when provided",
      "execute",
      { cause },
    );
  }
}

function normalizeArgv(value: unknown): [string, ...string[]] {
  const operation: WorkspaceCapability = "execute";
  let array: unknown[];
  try {
    if (!Array.isArray(value)) {
      throw new WorkspaceOperationMalformedError(
        "execute.command.argv must be an array",
        operation,
      );
    }
    array = value;
  } catch (cause) {
    if (cause instanceof WorkspaceOperationError) throw cause;
    throw new WorkspaceOperationMalformedError(
      "execute.command.argv could not be inspected",
      operation,
      { cause },
    );
  }

  const length = readArrayLength(array, operation, "execute.command.argv");
  if (length === 0) {
    throw new WorkspaceOperationMalformedError(
      "execute.command.argv must contain a program",
      operation,
    );
  }
  const expectedKeys = [
    ...Array.from({ length }, (_unused, index) => String(index)),
    "length",
  ];
  assertExactKeys(array as unknown as UnknownRecord, expectedKeys, operation);

  const argv: string[] = [];
  for (let index = 0; index < length; index++) {
    const part = readOwnDataProperty(
      array as unknown as UnknownRecord,
      String(index),
      operation,
    );
    if (typeof part !== "string" || (index === 0 && part.length === 0)) {
      throw new WorkspaceOperationMalformedError(
        index === 0
          ? "execute.command.argv[0] must be a nonempty program string"
          : `execute.command.argv[${index}] must be a string`,
        operation,
      );
    }
    argv.push(part);
  }
  return argv as [string, ...string[]];
}

function normalizeCommandRequest(value: unknown): CommandRequest {
  const operation: WorkspaceCapability = "execute";
  if (!isRecord(value)) {
    throw new WorkspaceOperationMalformedError(
      "execute.command must be an object",
      operation,
    );
  }
  assertExactKeys(value, ["argv", "cwd", "timeoutMs", "signal"], operation);

  const argv = normalizeArgv(readOwnDataProperty(value, "argv", operation));

  const cwdValue = readOwnDataProperty(value, "cwd", operation);
  if (cwdValue !== undefined && (typeof cwdValue !== "string" || cwdValue.length === 0)) {
    throw new WorkspaceOperationMalformedError(
      "execute.command.cwd must be a nonempty string when provided",
      operation,
    );
  }

  const timeoutValue = readOwnDataProperty(value, "timeoutMs", operation);
  if (
    timeoutValue !== undefined &&
    (!Number.isSafeInteger(timeoutValue) || (timeoutValue as number) < 0)
  ) {
    throw new WorkspaceOperationMalformedError(
      "execute.command.timeoutMs must be a nonnegative safe integer when provided",
      operation,
    );
  }

  const signalValue = readOwnDataProperty(value, "signal", operation);
  const signal = signalValue === undefined
    ? undefined
    : normalizeAbortSignal(signalValue);

  return {
    argv,
    ...(cwdValue === undefined ? {} : { cwd: cwdValue as string }),
    ...(timeoutValue === undefined ? {} : { timeoutMs: timeoutValue as number }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function parseOperationRequest(value: unknown): WorkspaceOperationRequest {
  if (value === undefined) {
    throw new WorkspaceOperationRequiredError("workspace operation is required");
  }
  if (!isRecord(value)) {
    throw new WorkspaceOperationMalformedError(
      "workspace operation must be an object",
    );
  }

  const operationValue = readOwnDataProperty(value, "operation");
  if (operationValue === undefined) {
    throw new WorkspaceOperationRequiredError("workspace operation name is required");
  }
  if (typeof operationValue !== "string" || operationValue.length === 0) {
    throw new WorkspaceOperationMalformedError(
      "workspace operation name must be a nonempty string",
    );
  }
  if (!workspaceCapabilitySet.has(operationValue as WorkspaceCapability)) {
    throw new WorkspaceOperationUnknownError(operationValue);
  }
  const operation = operationValue as WorkspaceCapability;

  switch (operation) {
    case "readFile":
    case "listFiles": {
      assertExactKeys(value, ["operation", "path"], operation);
      return {
        operation,
        path: requireNonemptyString(
          readOwnDataProperty(value, "path", operation),
          "path",
          operation,
        ),
      } as WorkspaceOperationRequest;
    }
    case "writeFile": {
      assertExactKeys(value, ["operation", "path", "contents"], operation);
      const contents = readOwnDataProperty(value, "contents", operation);
      if (typeof contents !== "string") {
        throw new WorkspaceOperationMalformedError(
          "writeFile.contents must be a string",
          operation,
        );
      }
      return {
        operation,
        path: requireNonemptyString(
          readOwnDataProperty(value, "path", operation),
          "path",
          operation,
        ),
        contents,
      };
    }
    case "execute": {
      assertExactKeys(value, ["operation", "command"], operation);
      return {
        operation,
        command: normalizeCommandRequest(
          readOwnDataProperty(value, "command", operation),
        ),
      };
    }
    case "diff":
    case "snapshot":
    case "dispose":
      assertExactKeys(value, ["operation"], operation);
      return { operation } as WorkspaceOperationRequest;
  }
}

/**
 * Validate and snapshot a caller-owned workspace by capturing and binding all
 * operation methods synchronously.
 *
 * Mutating or replacing methods on the original object after this function
 * returns cannot redirect the bound capability. The implementation's own
 * internal state remains intentionally shared.
 */
export function bindWorkspace(value: unknown): Workspace {
  if (value === undefined || value === null) {
    throw new WorkspaceOperationRequiredError();
  }
  if (!isRecord(value)) {
    throw new WorkspaceOperationMalformedError(
      "workspace capability must be an object",
    );
  }

  const methods = {} as Record<WorkspaceCapability, BoundMethod>;
  for (const capability of WORKSPACE_CAPABILITIES) {
    let candidate: unknown;
    try {
      candidate = Reflect.get(value, capability);
    } catch (error) {
      throw new WorkspaceOperationMalformedError(
        `workspace capability ${capability} could not be inspected`,
        capability,
        { cause: error },
      );
    }
    if (typeof candidate !== "function") {
      throw new WorkspaceOperationUnsupportedError(capability);
    }
    try {
      methods[capability] = Function.prototype.bind.call(
        candidate,
        value,
      ) as BoundMethod;
    } catch (cause) {
      throw new WorkspaceOperationMalformedError(
        `workspace capability ${capability} could not be bound`,
        capability,
        { cause },
      );
    }
  }

  return Object.freeze({
    readFile: methods.readFile,
    writeFile: methods.writeFile,
    listFiles: methods.listFiles,
    execute: methods.execute,
    diff: methods.diff,
    snapshot: methods.snapshot,
    dispose: methods.dispose,
  }) as Workspace;
}

/**
 * Create a least-privilege view that exposes exactly one reviewed operation.
 * Every other method rejects with a typed error without consulting the
 * underlying workspace.
 */
export function restrictWorkspace(
  value: unknown,
  capability: WorkspaceCapability,
): Workspace {
  if (!workspaceCapabilitySet.has(capability)) {
    throw new WorkspaceOperationUnknownError(String(capability));
  }
  const bound = bindWorkspace(value);
  const unsupported = <Result>(operation: WorkspaceCapability): Promise<Result> =>
    Promise.reject(new WorkspaceOperationUnsupportedError(
      operation,
      `workspace view grants ${capability}, not ${operation}`,
    ));

  return Object.freeze({
    readFile: (path: string) => capability === "readFile"
      ? invokeWorkspaceOperation(bound, { operation: "readFile", path })
      : unsupported<string>("readFile"),
    writeFile: (path: string, contents: string) => capability === "writeFile"
      ? invokeWorkspaceOperation(bound, { operation: "writeFile", path, contents })
      : unsupported<void>("writeFile"),
    listFiles: (path: string) => capability === "listFiles"
      ? invokeWorkspaceOperation(bound, { operation: "listFiles", path })
      : unsupported<string[]>("listFiles"),
    execute: (command: CommandRequest) => capability === "execute"
      ? invokeWorkspaceOperation(bound, { operation: "execute", command })
      : unsupported<CommandResult>("execute"),
    diff: () => capability === "diff"
      ? invokeWorkspaceOperation(bound, { operation: "diff" })
      : unsupported<string>("diff"),
    snapshot: () => capability === "snapshot"
      ? invokeWorkspaceOperation(bound, { operation: "snapshot" })
      : unsupported<WorkspaceSnapshot>("snapshot"),
    dispose: () => capability === "dispose"
      ? invokeWorkspaceOperation(bound, { operation: "dispose" })
      : unsupported<void>("dispose"),
  });
}

function malformedResult(
  operation: WorkspaceCapability,
  expectation: string,
): WorkspaceOperationMalformedError {
  return new WorkspaceOperationMalformedError(
    `${operation} returned ${expectation}`,
    operation,
  );
}

function normalizeCommandResult(value: unknown): CommandResult {
  if (!isRecord(value)) {
    throw malformedResult("execute", "a malformed command result");
  }
  assertExactKeys(value, ["exitCode", "stdout", "stderr", "timedOut"], "execute");
  const exitCode = readOwnDataProperty(value, "exitCode", "execute");
  const stdout = readOwnDataProperty(value, "stdout", "execute");
  const stderr = readOwnDataProperty(value, "stderr", "execute");
  const timedOut = readOwnDataProperty(value, "timedOut", "execute");
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
    throw malformedResult("execute", "a command result with an invalid exitCode");
  }
  if (typeof stdout !== "string" || typeof stderr !== "string") {
    throw malformedResult("execute", "a command result with invalid output");
  }
  if (timedOut !== undefined && typeof timedOut !== "boolean") {
    throw malformedResult("execute", "a command result with an invalid timedOut flag");
  }
  return Object.freeze({
    exitCode: exitCode as number | null,
    stdout,
    stderr,
    ...(timedOut === undefined ? {} : { timedOut }),
  });
}

function snapshotJsonValue(
  value: unknown,
  operation: WorkspaceCapability,
  seen: WeakSet<object>,
  depth: number,
): WorkspaceJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (depth > 64 || typeof value !== "object") {
    throw malformedResult(operation, "a snapshot containing non-JSON metadata");
  }
  if (seen.has(value)) {
    throw malformedResult(operation, "a snapshot containing cyclic metadata");
  }
  seen.add(value);
  try {
    let arrayValue: unknown[] | undefined;
    try {
      if (Array.isArray(value)) arrayValue = value;
    } catch (cause) {
      throw new WorkspaceOperationMalformedError(
        "snapshot metadata could not be inspected",
        operation,
        { cause },
      );
    }
    if (arrayValue !== undefined) {
      const length = readArrayLength(
        arrayValue,
        operation,
        "snapshot metadata array",
      );
      const expectedKeys = [
        ...Array.from({ length }, (_unused, index) => String(index)),
        "length",
      ];
      assertExactKeys(
        arrayValue as unknown as UnknownRecord,
        expectedKeys,
        operation,
      );
      const copy: WorkspaceJsonValue[] = [];
      for (let index = 0; index < length; index++) {
        copy.push(snapshotJsonValue(
          readOwnDataProperty(
            arrayValue as unknown as UnknownRecord,
            String(index),
            operation,
          ),
          operation,
          seen,
          depth + 1,
        ));
      }
      return Object.freeze(copy) as unknown as WorkspaceJsonValue[];
    }
    const record = value as UnknownRecord;
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(record);
    } catch (cause) {
      throw new WorkspaceOperationMalformedError(
        "snapshot metadata could not be inspected",
        operation,
        { cause },
      );
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw malformedResult(operation, "a snapshot containing non-plain metadata");
    }
    const copy = Object.create(null) as Record<string, WorkspaceJsonValue>;
    for (const key of ownKeys(record, operation)) {
      if (typeof key !== "string") {
        throw malformedResult(operation, "a snapshot containing symbol metadata");
      }
      const normalized = snapshotJsonValue(
        readOwnDataProperty(record, key, operation),
        operation,
        seen,
        depth + 1,
      );
      Object.defineProperty(copy, key, {
        value: normalized,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    seen.delete(value);
  }
}

function normalizeSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value)) {
    throw malformedResult("snapshot", "a malformed snapshot");
  }
  assertExactKeys(value, ["id", "createdAt", "metadata"], "snapshot");
  const id = requireNonemptyString(
    readOwnDataProperty(value, "id", "snapshot"),
    "id",
    "snapshot",
  );
  const createdAt = requireNonemptyString(
    readOwnDataProperty(value, "createdAt", "snapshot"),
    "createdAt",
    "snapshot",
  );
  const metadataValue = readOwnDataProperty(value, "metadata", "snapshot");
  let metadata: Readonly<Record<string, WorkspaceJsonValue>> | undefined;
  if (metadataValue !== undefined) {
    const normalized = snapshotJsonValue(
      metadataValue,
      "snapshot",
      new WeakSet<object>(),
      0,
    );
    if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
      throw malformedResult("snapshot", "a snapshot with non-object metadata");
    }
    metadata = normalized as Readonly<Record<string, WorkspaceJsonValue>>;
  }
  return Object.freeze({
    id,
    createdAt,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/**
 * Strictly validate and dispatch one canonical workspace operation.
 *
 * The dispatcher accepts `unknown` at its public boundary so malformed and
 * future inputs fail with typed errors rather than silently selecting an
 * operation. Inputs are copied before invocation and implementation results
 * are checked against the operational contract.
 */
export function invokeWorkspaceOperation<Request extends WorkspaceOperationRequest>(
  workspace: unknown,
  request: Request,
): Promise<WorkspaceOperationResult<Request["operation"]>>;
export function invokeWorkspaceOperation(
  workspace: unknown,
  request: unknown,
): Promise<WorkspaceOperationResult>;
export async function invokeWorkspaceOperation(
  workspace: unknown,
  request: unknown,
): Promise<WorkspaceOperationResult> {
  const operation = parseOperationRequest(request);
  const bound = bindWorkspace(workspace);

  switch (operation.operation) {
    case "readFile": {
      const result = await bound.readFile(operation.path);
      if (typeof result !== "string") {
        throw malformedResult("readFile", "a non-string result");
      }
      return result;
    }
    case "writeFile": {
      const result = await bound.writeFile(operation.path, operation.contents);
      if (result !== undefined) {
        throw malformedResult("writeFile", "a non-void result");
      }
      return undefined;
    }
    case "listFiles": {
      const result = await bound.listFiles(operation.path);
      let paths: unknown[];
      try {
        if (!Array.isArray(result)) {
          throw malformedResult("listFiles", "a malformed path list");
        }
        paths = result;
      } catch (cause) {
        if (cause instanceof WorkspaceOperationError) throw cause;
        throw new WorkspaceOperationMalformedError(
          "listFiles result could not be inspected",
          "listFiles",
          { cause },
        );
      }
      const length = readArrayLength(paths, "listFiles", "listFiles result");
      const expectedKeys = [
        ...Array.from({ length }, (_unused, index) => String(index)),
        "length",
      ];
      assertExactKeys(
        paths as unknown as UnknownRecord,
        expectedKeys,
        "listFiles",
      );
      const copy: string[] = [];
      for (let index = 0; index < length; index++) {
        const path = readOwnDataProperty(
          paths as unknown as UnknownRecord,
          String(index),
          "listFiles",
        );
        if (typeof path !== "string") {
          throw malformedResult("listFiles", "a malformed path list");
        }
        copy.push(path);
      }
      return copy;
    }
    case "execute":
      return normalizeCommandResult(await bound.execute(operation.command));
    case "diff": {
      const result = await bound.diff();
      if (typeof result !== "string") {
        throw malformedResult("diff", "a non-string result");
      }
      return result;
    }
    case "snapshot":
      return normalizeSnapshot(await bound.snapshot());
    case "dispose": {
      const result = await bound.dispose();
      if (result !== undefined) {
        throw malformedResult("dispose", "a non-void result");
      }
      return undefined;
    }
  }
}

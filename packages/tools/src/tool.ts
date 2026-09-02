import type { Workspace, WorkspaceCapability } from "@harness/workspace";
import type { z } from "zod";

export type ToolJsonValue =
  | null
  | boolean
  | number
  | string
  | ToolJsonValue[]
  | { [key: string]: ToolJsonValue };

export interface ToolPermissionIntent {
  action: string;
  subject?: string;
  scope?: "once" | "run";
}

/** Per-run information supplied by the kernel to cooperative tool calls. */
export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  /** Operational capability; workspace identity remains outer-layer metadata. */
  readonly workspace?: Workspace;
  readonly sessionId?: string;
  readonly taskId?: string;
  /** Correlates nested boundary events and permission asks to `tool.call`. */
  readonly callId?: string;
}

/**
 * Capabilities that are safe to expose from the agent-server host process.
 *
 * Generic tools are deliberately unbounded. A trusted factory must opt a tool
 * into one of these narrow capabilities before the agent server will expose it.
 */
export type ToolExecutionBoundary =
  | Readonly<{ kind: "pure" }>
  | Readonly<{
      kind: "workspace";
      access: "read";
      capability: Extract<
        WorkspaceCapability,
        "readFile" | "listFiles" | "diff" | "snapshot"
      >;
      root: string;
    }>
  | Readonly<{ kind: "sandbox"; root: string }>;

export class InvalidToolExecutionBoundaryError extends Error {
  readonly code = "TOOL_EXECUTION_BOUNDARY_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidToolExecutionBoundaryError";
  }
}

export interface ToolError {
  code: string;
  message: string;
}

/**
 * A tool the model may call. Parameters are validated with the
 * `parameters` schema before `execute` runs (the kernel does this),
 * which keeps tool code free of defensive parse errors.
 */
export interface Tool<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Result = unknown,
> {
  name: string;
  description: string;
  parameters: Params;
  /** Provider-neutral JSON Schema advertised to models. */
  inputSchema?: { [key: string]: ToolJsonValue };
  /** Policy intent derived only after `parameters` has validated the input. */
  authorization?: (params: unknown) => ToolPermissionIntent;
  execute(
    params: z.infer<Params>,
    context?: ToolExecutionContext,
  ): Result | Promise<Result>;
}

export function createTool<Params extends z.ZodTypeAny, Result = unknown>(
  def: Tool<Params, Result>,
): Tool<Params, Result> {
  return def;
}

const executionBoundaries = new WeakMap<object, ToolExecutionBoundary>();
const READ_ONLY_WORKSPACE_CAPABILITIES = new Set<string>([
  "readFile",
  "listFiles",
  "diff",
  "snapshot",
]);

function invalidBoundary(message: string, cause?: unknown): never {
  throw new InvalidToolExecutionBoundaryError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeExecutionBoundary(value: unknown): ToolExecutionBoundary {
  let record: Record<PropertyKey, unknown>;
  let keys: readonly PropertyKey[];
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalidBoundary("tool execution boundary must be an object");
    }
    record = value as Record<PropertyKey, unknown>;
    keys = Reflect.ownKeys(record);
  } catch (cause) {
    return invalidBoundary("tool execution boundary could not be inspected", cause);
  }

  const read = (key: string): unknown => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(record, key);
    } catch (cause) {
      return invalidBoundary(
        `tool execution boundary property ${key} could not be inspected`,
        cause,
      );
    }
    if (!descriptor || !("value" in descriptor)) {
      return invalidBoundary(
        `tool execution boundary property ${key} must be an own data property`,
      );
    }
    return descriptor.value;
  };
  const exactKeys = (expected: readonly string[]): void => {
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string" || !expected.includes(key))
    ) {
      invalidBoundary("tool execution boundary contains unexpected properties");
    }
  };

  const kind = read("kind");
  if (kind === "pure") {
    exactKeys(["kind"]);
    return Object.freeze({ kind: "pure" });
  }
  if (kind === "workspace") {
    exactKeys(["kind", "access", "capability", "root"]);
    const access = read("access");
    const capability = read("capability");
    const root = read("root");
    if (access !== "read") {
      return invalidBoundary("workspace tool boundary access must be read");
    }
    if (
      typeof capability !== "string" ||
      !READ_ONLY_WORKSPACE_CAPABILITIES.has(capability)
    ) {
      return invalidBoundary(
        "workspace tool boundary capability must be a reviewed read operation",
      );
    }
    if (typeof root !== "string" || root.length === 0) {
      return invalidBoundary("workspace tool boundary root must be a nonempty string");
    }
    return Object.freeze({
      kind: "workspace",
      access: "read",
      capability: capability as Extract<
        WorkspaceCapability,
        "readFile" | "listFiles" | "diff" | "snapshot"
      >,
      root,
    });
  }
  if (kind === "sandbox") {
    exactKeys(["kind", "root"]);
    const root = read("root");
    if (typeof root !== "string" || root.length === 0) {
      return invalidBoundary("sandbox tool boundary root must be a nonempty string");
    }
    return Object.freeze({ kind: "sandbox", root });
  }
  return invalidBoundary("tool execution boundary kind is unknown");
}

/**
 * Create a tool whose host-side capability has been explicitly reviewed.
 * Prefer purpose-built factories such as `createReadFileTool` over calling this
 * directly. The weak-map registration cannot be spoofed by adding a property to
 * an otherwise untrusted tool object.
 */
export function createBoundedTool<Params extends z.ZodTypeAny, Result = unknown>(
  def: Tool<Params, Result>,
  boundary: ToolExecutionBoundary,
): Tool<Params, Result> {
  const normalizedBoundary = normalizeExecutionBoundary(boundary);
  const tool = Object.freeze(createTool(def));
  executionBoundaries.set(tool, normalizedBoundary);
  return tool;
}

/** Return the reviewed host capability, or `undefined` for an unbounded tool. */
export function getToolExecutionBoundary(tool: Tool): ToolExecutionBoundary | undefined {
  return executionBoundaries.get(tool);
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }
}

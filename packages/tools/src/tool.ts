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
  readonly workspace?: string;
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
  | Readonly<{ kind: "workspace"; access: "read"; root: string }>
  | Readonly<{ kind: "sandbox"; root: string }>;

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
  const tool = Object.freeze(createTool(def));
  executionBoundaries.set(tool, Object.freeze({ ...boundary }));
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

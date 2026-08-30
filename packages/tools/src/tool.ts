import type { z } from "zod";

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
  execute(params: z.infer<Params>): Result | Promise<Result>;
}

export function createTool<Params extends z.ZodTypeAny>(
  def: Tool<Params>,
): Tool<Params> {
  return def;
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

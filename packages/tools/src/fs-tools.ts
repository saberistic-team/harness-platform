import { z } from "zod";
import { promises as fs } from "node:fs";
import { createTool, type Tool } from "./tool";

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
}

/**
 * Minimal read-only file tool for dogfooding. Real filesystem tools in
 * a sandboxed environment enforce the manifest's fs.read policy at the
 * sandbox-runner boundary, not here.
 */
export function createReadFileTool(): Tool {
  return createTool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: z.object({ path: z.string().min(1) }),
    execute: async ({ path }): Promise<ReadFileResult> => {
      const content = await fs.readFile(path, "utf8");
      return { path, content, size: content.length };
    },
  });
}

/**
 * In-memory fake tool for tests: returns a fixed payload.
 */
export function createEchoTool(name = "echo", fixed = "ok"): Tool {
  return createTool({
    name,
    description: `Fixed-response test tool: ${name}`,
    parameters: z.record(z.unknown()),
    execute: (params) => ({ echo: fixed, received: params }),
  });
}

import {
  WorkspaceOperationRequiredError,
  invokeWorkspaceOperation,
} from "@harness/workspace";
import { z } from "zod";
import { createBoundedTool, type Tool, type ToolExecutionContext } from "./tool";

export interface ReadFileResult {
  path: string;
  content: string;
  size: number;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  totalSize?: number;
  hasMore?: boolean;
}

export type WorkspaceFileAccessErrorCode =
  | "TOOL_WORKSPACE_INVALID_ROOT"
  | "TOOL_WORKSPACE_UNSUPPORTED_PLATFORM"
  | "TOOL_WORKSPACE_ESCAPE"
  | "TOOL_WORKSPACE_NOT_FILE"
  | "TOOL_WORKSPACE_CHANGED"
  | "TOOL_WORKSPACE_TOO_LARGE"
  | "TOOL_WORKSPACE_READ_FAILED"
  | "TOOL_WORKSPACE_INVALID_RANGE";

/** Tool results stay bounded independently of the injected adapter. */
export const READ_FILE_MAX_BYTES = 128 * 1024;

/**
 * Compatibility error for the existing read-file result boundary.
 *
 * Workspace operation and capability failures retain the canonical typed
 * errors exported by @harness/workspace; this error now covers only metadata
 * validation and tool-specific result constraints.
 */
export class WorkspaceFileAccessError extends Error {
  constructor(
    readonly code: WorkspaceFileAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileAccessError";
  }
}

function workspaceBoundaryRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_INVALID_ROOT",
      "fs.read requires workspace boundary metadata",
    );
  }
  return workspaceRoot;
}

async function readWorkspaceFile(
  path: string,
  context: ToolExecutionContext | undefined,
  range?: { startLine: number; maxLines: number },
): Promise<ReadFileResult> {
  if (context?.workspace === undefined) {
    throw new WorkspaceOperationRequiredError(
      "fs.read requires an injected workspace capability",
    );
  }

  context.signal?.throwIfAborted();
  const content = await invokeWorkspaceOperation(context.workspace, {
    operation: "readFile",
    path,
  });
  if (typeof content !== "string") {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_READ_FAILED",
      "fs.read workspace returned non-text content",
    );
  }

  const size = Buffer.byteLength(content, "utf8");
  if (size > READ_FILE_MAX_BYTES) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_TOO_LARGE",
      `fs.read is limited to ${READ_FILE_MAX_BYTES} bytes`,
    );
  }

  if (range) {
    const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
    if (range.startLine > lines.length) {
      throw new WorkspaceFileAccessError("TOOL_WORKSPACE_INVALID_RANGE", `startLine exceeds ${lines.length} lines`);
    }
    const endLine = Math.min(lines.length, range.startLine + range.maxLines - 1);
    const excerpt = lines.slice(range.startLine - 1, endLine).join("");
    return { path, content: excerpt, size: Buffer.byteLength(excerpt, "utf8"),
      startLine: range.startLine, endLine, totalLines: lines.length,
      totalSize: size, hasMore: endLine < lines.length };
  }
  return { path, content, size };
}

/**
 * Minimal read-only workspace tool for compatibility with the M3 host-tool
 * registry. `workspaceRoot` is reviewed boundary metadata only; all file I/O
 * is delegated to the operational Workspace injected by the kernel.
 */
export function createReadFileTool(workspaceRoot: string): Tool {
  const root = workspaceBoundaryRoot(workspaceRoot);
  return createBoundedTool({
    name: "fs.read",
    description: "Read UTF-8 workspace text. Prefer startLine (1-based) and maxLines (1-400) for source excerpts. Omit both for a whole file. A range defaults to startLine 1 and maxLines 200; returned metadata identifies omitted lines.",
    parameters: z.object({ path: z.string().min(1).max(4096), startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), maxLines: z.number().int().min(1).max(400).optional() }).strict(),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 }, startLine: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, maxLines: { type: "integer", minimum: 1, maximum: 400 } },
      required: ["path"],
      additionalProperties: false,
    },
    authorization: (params) => ({
      action: "fs.read",
      subject: (params as { path: string }).path,
      scope: "once",
    }),
    execute: ({ path, startLine, maxLines }, context): Promise<ReadFileResult> =>
      readWorkspaceFile(path, context, startLine === undefined && maxLines === undefined ? undefined : { startLine: startLine ?? 1, maxLines: maxLines ?? 200 }),
  }, { kind: "workspace", access: "read", capability: "readFile", root });
}

/**
 * In-memory fake tool for tests: returns a fixed payload.
 */
export function createEchoTool(name = "echo", fixed = "ok"): Tool {
  return createBoundedTool({
    name,
    description: `Fixed-response test tool: ${name}`,
    parameters: z.record(z.unknown()),
    inputSchema: { type: "object", additionalProperties: true },
    execute: (params) => ({ echo: fixed, received: params }),
  }, { kind: "pure" });
}

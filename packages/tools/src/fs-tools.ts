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
}

export type WorkspaceFileAccessErrorCode =
  | "TOOL_WORKSPACE_INVALID_ROOT"
  | "TOOL_WORKSPACE_UNSUPPORTED_PLATFORM"
  | "TOOL_WORKSPACE_ESCAPE"
  | "TOOL_WORKSPACE_NOT_FILE"
  | "TOOL_WORKSPACE_CHANGED"
  | "TOOL_WORKSPACE_TOO_LARGE"
  | "TOOL_WORKSPACE_READ_FAILED";

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
      "read_file requires workspace boundary metadata",
    );
  }
  return workspaceRoot;
}

async function readWorkspaceFile(
  path: string,
  context: ToolExecutionContext | undefined,
): Promise<ReadFileResult> {
  if (context?.workspace === undefined) {
    throw new WorkspaceOperationRequiredError(
      "read_file requires an injected workspace capability",
    );
  }

  const content = await invokeWorkspaceOperation(context.workspace, {
    operation: "readFile",
    path,
  });
  if (typeof content !== "string") {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_READ_FAILED",
      "read_file workspace returned non-text content",
    );
  }

  const size = Buffer.byteLength(content, "utf8");
  if (size > READ_FILE_MAX_BYTES) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_TOO_LARGE",
      `read_file is limited to ${READ_FILE_MAX_BYTES} bytes`,
    );
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
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: z.object({ path: z.string().min(1) }),
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    },
    authorization: (params) => ({
      action: "fs.read",
      subject: (params as { path: string }).path,
      scope: "once",
    }),
    execute: ({ path }, context): Promise<ReadFileResult> =>
      readWorkspaceFile(path, context),
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

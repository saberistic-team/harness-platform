import {
  WorkspaceOperationMalformedError,
  WorkspaceOperationRequiredError,
  type CommandRequest,
  type CommandResult,
  type Workspace,
  type WorkspaceSnapshot,
} from "@harness/workspace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  InvalidToolExecutionBoundaryError,
  WorkspaceFileAccessError,
  READ_FILE_MAX_BYTES,
  createBoundedTool,
  createReadFileTool,
  getToolExecutionBoundary,
} from "../src";

class MemoryWorkspace implements Workspace {
  readonly reads: string[] = [];

  constructor(private readonly content: string = "héllo\n") {}

  async readFile(path: string): Promise<string> {
    this.reads.push(path);
    return this.content;
  }

  async writeFile(_path: string, _contents: string): Promise<void> {}

  async listFiles(_path: string): Promise<string[]> {
    return [];
  }

  async execute(_command: CommandRequest): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async diff(): Promise<string> {
    return "";
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return { id: "snapshot-1", createdAt: "2026-09-02T00:00:00.000Z" };
  }

  async dispose(): Promise<void> {}
}

describe("createReadFileTool", () => {
  it("delegates reads to the injected workspace and returns a bounded UTF-8 result", async () => {
    const workspace = new MemoryWorkspace();
    const tool = createReadFileTool("/reviewed/workspace");

    await expect(tool.execute(
      { path: "hello.txt" },
      { workspace },
    )).resolves.toEqual({
      path: "hello.txt",
      content: "héllo\n",
      size: Buffer.byteLength("héllo\n", "utf8"),
    });
    expect(workspace.reads).toEqual(["hello.txt"]);
  });

  it("keeps the root only as reviewed boundary metadata", () => {
    const tool = createReadFileTool("relative/reviewed-root");

    expect(getToolExecutionBoundary(tool)).toEqual({
      kind: "workspace",
      access: "read",
      capability: "readFile",
      root: "relative/reviewed-root",
    });
  });

  it("rejects forged or structurally ambiguous execution boundaries", () => {
    const definition = {
      name: "forged_workspace_tool",
      description: "Must never gain an undeclared write capability",
      parameters: z.object({}).strict(),
      execute: () => "must not run",
    };

    expect(() => createBoundedTool(definition, {
      kind: "workspace",
      access: "read",
      capability: "writeFile",
      root: "/reviewed/workspace",
    } as never)).toThrowError(InvalidToolExecutionBoundaryError);
    expect(() => createBoundedTool(definition, {
      kind: "pure",
      capability: "readFile",
    } as never)).toThrowError(
      expect.objectContaining({ code: "TOOL_EXECUTION_BOUNDARY_INVALID" }),
    );
  });

  it("rejects missing injected workspace capability with the canonical typed error", async () => {
    const tool = createReadFileTool("/reviewed/workspace");

    await expect(tool.execute({ path: "hello.txt" })).rejects.toMatchObject({
      name: WorkspaceOperationRequiredError.name,
      code: "WORKSPACE_OPERATION_REQUIRED",
    });
  });

  it("rejects oversized workspace results deterministically", async () => {
    const workspace = new MemoryWorkspace("x".repeat(READ_FILE_MAX_BYTES + 1));
    const tool = createReadFileTool("/reviewed/workspace");

    await expect(tool.execute(
      { path: "large.txt" },
      { workspace },
    )).rejects.toMatchObject({
      name: WorkspaceFileAccessError.name,
      code: "TOOL_WORKSPACE_TOO_LARGE",
    });
    expect(workspace.reads).toEqual(["large.txt"]);
  });

  it("preserves typed workspace errors for malformed adapter results", async () => {
    const workspace = new MemoryWorkspace();
    Object.defineProperty(workspace, "readFile", {
      value: async () => 42,
    });
    const tool = createReadFileTool("/reviewed/workspace");

    await expect(tool.execute(
      { path: "invalid.txt" },
      { workspace },
    )).rejects.toMatchObject({
      name: WorkspaceOperationMalformedError.name,
      code: "WORKSPACE_OPERATION_MALFORMED",
      operation: "readFile",
    });
  });

  it("rejects malformed operations before invoking the workspace", async () => {
    const workspace = new MemoryWorkspace();
    const tool = createReadFileTool("/reviewed/workspace");

    await expect(tool.execute(
      { path: "" },
      { workspace },
    )).rejects.toMatchObject({
      name: WorkspaceOperationMalformedError.name,
      code: "WORKSPACE_OPERATION_MALFORMED",
      operation: "readFile",
    });
    expect(workspace.reads).toEqual([]);
  });

  it("rejects missing boundary metadata without consulting a workspace", () => {
    expect(() => createReadFileTool("")).toThrowError(
      expect.objectContaining({
        name: WorkspaceFileAccessError.name,
        code: "TOOL_WORKSPACE_INVALID_ROOT",
      }),
    );
  });
});

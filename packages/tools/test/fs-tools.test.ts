import { describe, expect, it } from "vitest";
import {
  WorkspaceFileAccessError,
  READ_FILE_MAX_BYTES,
  createReadFileTool,
  getToolExecutionBoundary,
} from "../src";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function workspaceFixture(): { container: string; workspace: string } {
  const container = mkdtempSync(join(tmpdir(), "harness-read-file-"));
  const workspace = join(container, "workspace");
  mkdirSync(workspace);
  return { container, workspace };
}

describe("createReadFileTool", () => {
  it("reads regular files through a canonical workspace boundary", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      writeFileSync(join(workspace, "hello.txt"), "héllo\n", "utf8");
      const tool = createReadFileTool(workspace);

      await expect(tool.execute({ path: "hello.txt" })).resolves.toEqual({
        path: "hello.txt",
        content: "héllo\n",
        size: Buffer.byteLength("héllo\n", "utf8"),
      });
      expect(getToolExecutionBoundary(tool)).toEqual({
        kind: "workspace",
        access: "read",
        root: realpathSync(workspace),
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects absolute host paths such as /etc/hosts", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      const tool = createReadFileTool(workspace);
      await expect(tool.execute({ path: "/etc/hosts" })).rejects.toMatchObject({
        name: WorkspaceFileAccessError.name,
        code: "TOOL_WORKSPACE_ESCAPE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects a workspace symlink whose canonical target is outside", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      const outside = join(container, "outside-secret.txt");
      writeFileSync(outside, "outside secret", "utf8");
      symlinkSync(outside, join(workspace, "escape.txt"));
      const tool = createReadFileTool(workspace);

      await expect(tool.execute({ path: "escape.txt" })).rejects.toMatchObject({
        name: WorkspaceFileAccessError.name,
        code: "TOOL_WORKSPACE_ESCAPE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects in-workspace symbolic and hard-link aliases", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      const target = join(workspace, "secret.txt");
      writeFileSync(target, "secret", "utf8");
      symlinkSync(target, join(workspace, "allowed-link.txt"));
      const tool = createReadFileTool(workspace);
      await expect(tool.execute({ path: "allowed-link.txt" })).rejects.toMatchObject({
        code: "TOOL_WORKSPACE_ESCAPE",
      });

      linkSync(target, join(workspace, "allowed-hardlink.txt"));
      await expect(tool.execute({ path: "allowed-hardlink.txt" })).rejects.toMatchObject({
        code: "TOOL_WORKSPACE_ESCAPE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects traversal before touching the host filesystem", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      const tool = createReadFileTool(workspace);
      await expect(tool.execute({ path: "dir/../../outside" })).rejects.toMatchObject({
        code: "TOOL_WORKSPACE_ESCAPE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects oversized files deterministically", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      writeFileSync(join(workspace, "large.txt"), Buffer.alloc(READ_FILE_MAX_BYTES + 1));
      const tool = createReadFileTool(workspace);
      await expect(tool.execute({ path: "large.txt" })).rejects.toMatchObject({
        code: "TOOL_WORKSPACE_TOO_LARGE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });

  it("rejects FIFOs without blocking on open", async () => {
    const { container, workspace } = workspaceFixture();
    try {
      const fifo = join(workspace, "pipe");
      const created = spawnSync("mkfifo", [fifo], { stdio: "ignore" });
      expect(created.status).toBe(0);
      const tool = createReadFileTool(workspace);
      await expect(tool.execute({ path: "pipe" })).rejects.toMatchObject({
        code: "TOOL_WORKSPACE_NOT_FILE",
      });
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
  });
});

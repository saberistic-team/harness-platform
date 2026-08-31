import { z } from "zod";
import {
  constants,
  promises as fs,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { createBoundedTool, type Tool } from "./tool";

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

/** Host reads stay bounded even if a regular file grows while it is open. */
export const READ_FILE_MAX_BYTES = 128 * 1024;

export class WorkspaceFileAccessError extends Error {
  constructor(
    readonly code: WorkspaceFileAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileAccessError";
  }
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_UNSUPPORTED_PLATFORM",
      "read_file requires Linux or macOS stable file identity semantics",
    );
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_INVALID_ROOT",
      "read_file requires a workspace root",
    );
  }
  try {
    const canonical = realpathSync(resolve(workspaceRoot));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_INVALID_ROOT",
      "read_file workspace root must be an existing directory",
    );
  }
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function verifyDescriptorTarget(
  root: string,
  canonical: string,
  fd: number,
): Promise<void> {
  if (process.platform !== "linux") return;
  let descriptorTarget: string;
  try {
    descriptorTarget = await fs.realpath(`/proc/self/fd/${fd}`);
  } catch {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_CHANGED",
      "read_file could not verify the opened file descriptor",
    );
  }
  if (descriptorTarget !== canonical || !isWithin(root, descriptorTarget)) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_CHANGED",
      "read_file target changed while it was being opened",
    );
  }
}

async function readFileHandleBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = READ_FILE_MAX_BYTES - total + 1;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > READ_FILE_MAX_BYTES) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_TOO_LARGE",
        `read_file is limited to ${READ_FILE_MAX_BYTES} bytes`,
      );
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function lexicalFilePath(root: string, requested: string): string {
  if (
    requested.includes("\0") ||
    isAbsolute(requested) ||
    win32.isAbsolute(requested) ||
    requested.split(/[\\/]+/u).includes("..")
  ) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_ESCAPE",
      "read_file path must be a relative path inside the workspace",
    );
  }
  const candidate = resolve(root, requested);
  if (!isWithin(root, candidate)) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_ESCAPE",
      "read_file path escapes the workspace",
    );
  }
  return candidate;
}

async function readCanonicalWorkspaceFile(
  root: string,
  requested: string,
): Promise<ReadFileResult> {
  const lexical = lexicalFilePath(root, requested);
  let canonical: string;
  try {
    canonical = await fs.realpath(lexical);
  } catch {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_READ_FAILED",
      "read_file path does not identify a readable workspace file",
    );
  }
  if (!isWithin(root, canonical)) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_ESCAPE",
      "read_file path resolves outside the workspace",
    );
  }
  // Authorize and open the same pathname. Allowing an in-workspace symlink
  // would let a rule for the link name read a different, unauthorized target.
  if (canonical !== lexical) {
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_ESCAPE",
      "read_file path must not resolve through a symbolic link",
    );
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await fs.stat(canonical, { bigint: true });
    if (!before.isFile()) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_NOT_FILE",
        "read_file only supports regular files",
      );
    }
    // A hard link has another pathname that policy cannot account for. Reject
    // aliases rather than letting an allowed name expose an unrelated file.
    if (before.nlink > 1n) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_ESCAPE",
        "read_file does not allow multiply-linked files",
      );
    }
    if (before.size > BigInt(READ_FILE_MAX_BYTES)) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_TOO_LARGE",
        `read_file is limited to ${READ_FILE_MAX_BYTES} bytes`,
      );
    }

    // O_NONBLOCK ensures that a raced-in FIFO or device cannot hang the host.
    // O_NOFOLLOW protects the final component; the identity and post-open
    // canonical checks below cover intermediate-component replacement.
    handle = await fs.open(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_NOT_FILE",
        "read_file only supports regular files",
      );
    }
    if (!sameFileIdentity(before, opened)) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_CHANGED",
        "read_file target changed while it was being opened",
      );
    }
    if (opened.size > BigInt(READ_FILE_MAX_BYTES)) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_TOO_LARGE",
        `read_file is limited to ${READ_FILE_MAX_BYTES} bytes`,
      );
    }

    const afterCanonical = await fs.realpath(canonical);
    if (afterCanonical !== canonical || !isWithin(root, afterCanonical)) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_CHANGED",
        "read_file target changed while it was being opened",
      );
    }
    const after = await fs.stat(afterCanonical, { bigint: true });
    if (!sameFileIdentity(opened, after)) {
      throw new WorkspaceFileAccessError(
        "TOOL_WORKSPACE_CHANGED",
        "read_file target changed while it was being opened",
      );
    }
    await verifyDescriptorTarget(root, canonical, handle.fd);

    const bytes = await readFileHandleBounded(handle);
    const content = bytes.toString("utf8");
    return {
      path: relative(root, canonical),
      content,
      size: bytes.length,
    };
  } catch (error) {
    if (error instanceof WorkspaceFileAccessError) throw error;
    throw new WorkspaceFileAccessError(
      "TOOL_WORKSPACE_READ_FAILED",
      "read_file could not read the workspace file",
    );
  } finally {
    await handle?.close();
  }
}

/**
 * Minimal read-only host file tool for dogfooding. It is deliberately rooted
 * to one canonical workspace and rejects absolute paths, traversal and
 * symlink targets outside that workspace.
 */
export function createReadFileTool(workspaceRoot: string): Tool {
  const root = canonicalWorkspaceRoot(workspaceRoot);
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
    execute: async ({ path }): Promise<ReadFileResult> =>
      readCanonicalWorkspaceFile(root, path),
  }, { kind: "workspace", access: "read", root });
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

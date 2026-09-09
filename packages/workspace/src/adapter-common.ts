import { createHash, randomUUID } from "node:crypto";
import { createEvent, type AnyHarnessEvent } from "@harness/events";
import { parseWorkspaceOperation, type CommandRequest, type WorkspaceSnapshot } from "./index";

export class WorkspaceAdapterError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "WorkspaceAdapterError";
  }
}
export function fail(code: string, message: string): never {
  throw new WorkspaceAdapterError(`WORKSPACE_${code}`, message);
}
export interface WorkspaceLimits {
  fileBytes: number; totalBytes: number; files: number; outputBytes: number; timeoutMs: number;
}
export const DEFAULT_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024, files: 2000,
  outputBytes: 1024 * 1024, timeoutMs: 30_000,
});
export interface AdapterOptions {
  root: string;
  allowedPaths: readonly string[];
  limits?: Partial<WorkspaceLimits>;
  onEvent?: (event: AnyHarnessEvent) => void;
}
export function validateOptions(value: unknown, backend: "local" | "docker"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MALFORMED", "workspace options must be an object");
  const keys = ["root", "allowedPaths", "limits", "onEvent", "backend", "executor",
    ...(backend === "local" ? ["developerOnly", "commands"] : ["image", "dockerHost", "diskBytes", "artifacts"])];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor || !("value" in descriptor)) fail("MALFORMED", "unknown or accessor workspace option");
  }
  const options = value as Record<string, unknown>;
  if (options.backend !== undefined && options.backend !== backend) fail("MALFORMED", "backend does not match adapter");
  if (typeof options.root !== "string" || !options.root || /[\u0000-\u001f\u007f]/u.test(options.root)) fail("MALFORMED", "invalid root");
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") fail("MALFORMED", "onEvent must be a function");
  if (options.executor !== undefined && (!options.executor || typeof (options.executor as { execute?: unknown }).execute !== "function")) fail("MALFORMED", "executor must implement execute");
}
export function limitsFor(input: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MALFORMED", "invalid limits");
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key as keyof WorkspaceLimits] * 4) {
      fail("MALFORMED", `invalid limit: ${key}`);
    }
    result[key as keyof WorkspaceLimits] = value;
  }
  return Object.freeze(result);
}
export function safePath(value: unknown, directory = false): string {
  if (directory && value === ".") return ".";
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
    /[\u0000-\u001f\u007f\\:*?"<>|]/u.test(value) ||
    value.split("/").some(s => !s || s === "." || s === ".." || s.toLowerCase() === ".git") || value.startsWith("/")) {
    fail("PATH", "expected a relative workspace path without traversal or reserved segments");
  }
  return value;
}
export function patternsFor(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) fail("MALFORMED", "allowedPaths is required");
  return Object.freeze(value.map(p => {
    if (typeof p !== "string") fail("MALFORMED", "invalid allowed path");
    if (p === "**") return p;
    safePath(p.endsWith("/**") ? p.slice(0, -3) : p);
    return p;
  }));
}
export function allows(patterns: readonly string[], path: string): boolean {
  if (path === "tasks/runs" || path.startsWith("tasks/runs/")) return false;
  return patterns.some(p => p === "**" || p === path || (p.endsWith("/**") && path.startsWith(p.slice(0, -2))));
}
export function commandFor(value: CommandRequest, limits: WorkspaceLimits): CommandRequest {
  const parsed = parseWorkspaceOperation({ operation: "execute", command: value });
  if (parsed.operation !== "execute") fail("MALFORMED", "invalid command");
  const command = parsed.command;
  if (command.argv.some(p => p.includes("\0")) || command.argv.reduce((n, p) => n + Buffer.byteLength(p), 0) > 64 * 1024) fail("MALFORMED", "invalid argv bytes");
  safePath(command.cwd ?? ".", true);
  if (command.timeoutMs === 0 || (command.timeoutMs ?? 0) > limits.timeoutMs) fail("LIMIT", "command timeout exceeds workspace limit");
  if (command.signal?.aborted) fail("CANCELED", "command canceled before execution");
  return { ...command, timeoutMs: command.timeoutMs ?? limits.timeoutMs };
}
export type FileTree = Record<string, string>;
export function validateTree(value: unknown, limits: WorkspaceLimits): FileTree {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MALFORMED", "expected file tree");
  const tree: FileTree = Object.create(null);
  const entries = Object.entries(value);
  if (entries.length > limits.files) fail("LIMIT", "too many files");
  let total = 0;
  for (const [path, data] of entries) {
    safePath(path);
    if (typeof data !== "string" || data.includes("\0")) fail("UNSUPPORTED", "only UTF-8 text files are supported");
    const bytes = Buffer.byteLength(data);
    total += bytes;
    if (bytes > limits.fileBytes || total > limits.totalBytes) fail("LIMIT", "file tree byte limit exceeded");
    tree[path] = data;
  }
  for (const path of Object.keys(tree)) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) {
      if (Object.hasOwn(tree, parts.join("/"))) fail("PATH", "file/directory collision");
      parts.pop();
    }
  }
  return tree;
}
export function assertChanges(before: FileTree, after: FileTree, paths: readonly string[]): void {
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path] && !allows(paths, path)) fail("SCOPE", `change outside allowedPaths: ${path}`);
  }
}
export function treePatch(before: FileTree, after: FileTree, maxBytes: number): string {
  let patch = "";
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[path], b = after[path];
    if (a === b) continue;
    const lines = (s: string | undefined) => s === undefined || s === "" ? [] : s.replace(/\n$/u, "").split("\n");
    const oldLines = lines(a), newLines = lines(b);
    const quote = (p: string) => JSON.stringify(p);
    patch += `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\n`;
    if (a === undefined) patch += "new file mode 100644\n";
    if (b === undefined) patch += "deleted file mode 100644\n";
    patch += `--- ${a === undefined ? "/dev/null" : quote(`a/${path}`)}\n+++ ${b === undefined ? "/dev/null" : quote(`b/${path}`)}\n`;
    if (oldLines.length || newLines.length) {
      patch += `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`;
      for (const [content, entries, prefix] of [[a, oldLines, "-"], [b, newLines, "+"]] as const) {
        patch += entries.map(line => prefix + line + "\n").join("");
        if (entries.length && !content?.endsWith("\n")) patch += "\\ No newline at end of file\n";
      }
    }
    if (Buffer.byteLength(patch) > maxBytes) fail("LIMIT", "patch exceeds output limit");
  }
  return patch;
}
export class WorkspaceAudit {
  readonly id = randomUUID();
  constructor(private readonly backend: "local" | "docker", private readonly observer?: AdapterOptions["onEvent"]) {}
  emit(phase: "opened" | "snapshot" | "disposed" | "retained" | "expired", snapshotId?: string, expiresAt?: string): void {
    this.observer?.(createEvent("workspace.lifecycle", { workspaceId: this.id, backend: this.backend, phase, snapshotId, expiresAt }, { actor: "workspace" }));
  }
  snapshot(tree: FileTree): WorkspaceSnapshot {
    const id = createHash("sha256").update(JSON.stringify(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    this.emit("snapshot", id);
    return Object.freeze({ id, createdAt: new Date().toISOString(), metadata: { files: Object.keys(tree).length } });
  }
}

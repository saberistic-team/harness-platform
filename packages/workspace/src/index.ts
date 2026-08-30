/**
 * Workspace — the root a task is allowed to see and modify.
 *
 * M0 scope: pure path scoping. All file tools (and the sandbox-runner
 * boundary) must run paths through `resolveWithinWorkspace`, so a
 * model-emitted `../../etc/passwd` cannot leave the task's tree.
 */
import { isAbsolute, normalize, resolve, sep } from "node:path";

export class WorkspaceEscapesRootError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`path "${requested}" escapes the workspace root "${root}"`);
    this.name = "WorkspaceEscapesRootError";
  }
}

export interface Workspace {
  /** Absolute, normalized root of the task's file access. */
  readonly root: string;
  /** Resolve a model/CLI-supplied path inside the root or throw. */
  resolvePath(requested: string): string;
}

export function openWorkspace(root: string): Workspace {
  const abs = resolve(root);
  // Ensure a path separator boundary so `workspace` and
  // `workspace-evil` do not alias.
  const boundary = abs.endsWith(sep) ? abs : abs + sep;

  return {
    root: abs,
    resolvePath(requested: string) {
      const candidate = isAbsolute(requested)
        ? normalize(requested)
        : normalize(abs + sep + requested);
      if (candidate !== abs && !candidate.startsWith(boundary)) {
        throw new WorkspaceEscapesRootError(requested, abs);
      }
      return candidate;
    },
  };
}

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import {
  SandboxAllowedPathError,
  SandboxPathChangedError,
  SandboxSpecError,
} from "./errors";
import type { SandboxPlan, SandboxRunSpec, WritableMount } from "./types";

export const CONTAINER_WORKSPACE = "/workspace" as const;

interface AllowedMountCandidate extends WritableMount {
  recursive: boolean;
}

export interface MountTreeOptions {
  /** Injectable only for deterministic validation tests. */
  mountPoints?: ReadonlySet<string>;
}

function containsControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function allowedPathError(
  code:
    | "SANDBOX_UNSAFE_ALLOWED_PATH"
    | "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
  pattern: string,
  reason: string,
): never {
  throw new SandboxAllowedPathError(
    code,
    pattern,
    `allowed_paths pattern ${JSON.stringify(pattern)} ${reason}`,
  );
}

function decodePattern(pattern: string): {
  relativePath: string;
  recursive: boolean;
} {
  if (pattern.length === 0 || containsControl(pattern)) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "is empty or contains control characters");
  }
  if (pattern.includes("\\") || pattern.includes(",")) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "cannot be encoded as an unambiguous Docker bind mount",
    );
  }
  if (posix.isAbsolute(pattern) || isAbsolute(pattern)) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "must be workspace-relative");
  }

  let relativePath = pattern;
  let recursive = false;
  if (pattern.endsWith("/**")) {
    relativePath = pattern.slice(0, -3);
    recursive = true;
  } else if (pattern.endsWith("/")) {
    relativePath = pattern.slice(0, -1);
    recursive = true;
  }

  if (relativePath.length === 0) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "would make the entire workspace writable",
    );
  }
  if (/[*?]/u.test(relativePath)) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "contains a wildcard that cannot be represented without a broader writable mount",
    );
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    allowedPathError(
      "SANDBOX_UNSAFE_ALLOWED_PATH",
      pattern,
      "contains an empty, current-directory, or parent-directory segment",
    );
  }
  const normalized = posix.normalize(relativePath);
  if (normalized !== relativePath || normalized === "." || normalized.startsWith("../")) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "does not normalize within the workspace");
  }
  return { relativePath, recursive };
}

export function canonicalWorkspaceRoot(workspaceRoot: string): string {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.length === 0 ||
    containsControl(workspaceRoot) ||
    workspaceRoot.includes(",")
  ) {
    throw new SandboxSpecError(
      "workspaceRoot must be a non-empty Docker-mount-safe path",
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(workspaceRoot);
  } catch (cause) {
    throw new SandboxSpecError(`workspace root does not exist: ${workspaceRoot}`, {
      cause,
    });
  }
  if (!statSync(canonical).isDirectory()) {
    throw new SandboxSpecError(`workspace root is not a directory: ${workspaceRoot}`);
  }
  return canonical;
}

export function workspaceOwner(workspaceRoot: string): {
  uid: number;
  gid: number;
  dockerUser: string;
} {
  const stats = statSync(workspaceRoot);
  const maximumId = 4_294_967_294;
  if (
    !Number.isSafeInteger(stats.uid) ||
    !Number.isSafeInteger(stats.gid) ||
    stats.uid > maximumId ||
    stats.gid > maximumId
  ) {
    throw new SandboxSpecError("workspace owner uid/gid are not representable");
  }
  if (stats.uid <= 0 || stats.gid <= 0) {
    throw new SandboxSpecError(
      "workspace is owned by root uid/gid; refusing a root sandbox identity",
    );
  }
  return { uid: stats.uid, gid: stats.gid, dockerUser: `${stats.uid}:${stats.gid}` };
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, code: string) => {
    switch (code) {
      case "040": return " ";
      case "011": return "\t";
      case "012": return "\n";
      default: return "\\";
    }
  });
}

/** Linux exposes bind mount boundaries here; other hosts still get st_dev checks. */
export function hostMountPoints(): ReadonlySet<string> {
  if (process.platform !== "linux") return new Set();
  try {
    const points = new Set<string>();
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      if (line.length === 0) continue;
      const fields = line.split(" ");
      const mountPoint = fields[4];
      if (mountPoint !== undefined) points.add(decodeMountInfoPath(mountPoint));
    }
    return points;
  } catch (cause) {
    throw new SandboxSpecError("cannot inspect host mount boundaries", { cause });
  }
}

function updateStatFingerprint(
  hash: ReturnType<typeof createHash>,
  relativeName: string,
  entry: BigIntStats,
): void {
  hash.update(relativeName).update("\0");
  hash.update([
    entry.dev,
    entry.ino,
    entry.mode,
    entry.nlink,
    entry.uid,
    entry.gid,
    entry.rdev,
    entry.size,
    entry.mtimeNs,
    entry.ctimeNs,
  ].join(":")).update("\0");
}

function validateAndFingerprintTree(
  source: string,
  pattern: string,
  kind: "file" | "directory",
  mountPoints: ReadonlySet<string>,
): string {
  const hash = createHash("sha256");
  const rootStats = lstatSync(source, { bigint: true });
  const rootDevice = rootStats.dev;

  const visit = (path: string, relativeName: string): void => {
    const entry = lstatSync(path, { bigint: true });
    updateStatFingerprint(hash, relativeName, entry);

    if (entry.isSymbolicLink()) {
      hash.update(readlinkSync(path)).update("\0");
      return;
    }
    if (entry.isFile()) {
      if (entry.nlink > 1n) {
        allowedPathError(
          "SANDBOX_UNSAFE_ALLOWED_PATH",
          pattern,
          "contains a multiply-linked file whose other names cannot be proven in scope",
        );
      }
      return;
    }
    if (!entry.isDirectory()) {
      allowedPathError(
        "SANDBOX_UNSAFE_ALLOWED_PATH",
        pattern,
        `contains a socket, device, FIFO, or other special entry at ${JSON.stringify(path)}`,
      );
    }
    if (path !== source && (entry.dev !== rootDevice || mountPoints.has(path))) {
      allowedPathError(
        "SANDBOX_UNSAFE_ALLOWED_PATH",
        pattern,
        `crosses a nested filesystem mount at ${JSON.stringify(path)}`,
      );
    }

    let children: Dirent<string>[];
    try {
      children = readdirSync(path, { withFileTypes: true, encoding: "utf8" });
    } catch {
      allowedPathError(
        "SANDBOX_UNSAFE_ALLOWED_PATH",
        pattern,
        `contains an unreadable directory at ${JSON.stringify(path)}`,
      );
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      visit(resolve(path, child.name), relativeName.length === 0 ? child.name : `${relativeName}/${child.name}`);
    }
  };

  if (mountPoints.has(source)) {
    allowedPathError(
      "SANDBOX_UNSAFE_ALLOWED_PATH",
      pattern,
      "names a nested filesystem mount rather than workspace-owned storage",
    );
  }
  visit(source, "");
  if (kind === "file" && !rootStats.isFile()) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "changed type during validation");
  }
  if (kind === "directory" && !rootStats.isDirectory()) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "changed type during validation");
  }
  return hash.digest("hex");
}

function candidateFor(
  workspaceRoot: string,
  pattern: string,
  mountPoints: ReadonlySet<string>,
): AllowedMountCandidate {
  const decoded = decodePattern(pattern);
  const requested = resolve(workspaceRoot, ...decoded.relativePath.split("/"));
  if (!within(workspaceRoot, requested)) {
    allowedPathError("SANDBOX_UNSAFE_ALLOWED_PATH", pattern, "escapes the canonical workspace root");
  }

  let entry: ReturnType<typeof lstatSync>;
  let canonical: string;
  try {
    entry = lstatSync(requested);
    canonical = realpathSync(requested);
  } catch (cause) {
    throw new SandboxAllowedPathError(
      "SANDBOX_ALLOWED_PATH_NOT_FOUND",
      pattern,
      `allowed_paths source does not exist: ${decoded.relativePath}`,
      { cause },
    );
  }
  if (entry.isSymbolicLink() || canonical !== requested || !within(workspaceRoot, canonical)) {
    allowedPathError(
      "SANDBOX_UNSAFE_ALLOWED_PATH",
      pattern,
      "resolves through a symlink or outside the canonical workspace",
    );
  }

  const target = statSync(canonical);
  const workspaceDevice = lstatSync(workspaceRoot, { bigint: true }).dev;
  const targetDevice = lstatSync(canonical, { bigint: true }).dev;
  if (targetDevice !== workspaceDevice) {
    allowedPathError(
      "SANDBOX_UNSAFE_ALLOWED_PATH",
      pattern,
      "names storage on a filesystem different from the workspace root",
    );
  }
  const kind = target.isDirectory()
    ? "directory"
    : target.isFile()
      ? "file"
      : undefined;
  if (kind === undefined) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "does not name a regular file or directory",
    );
  }
  if (kind === "directory" && !decoded.recursive) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "names a directory without /**; mounting it would also authorize unnamed descendants",
    );
  }
  if (kind === "file" && decoded.recursive) {
    allowedPathError(
      "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
      pattern,
      "uses a recursive directory pattern for a regular file",
    );
  }
  const fingerprint = validateAndFingerprintTree(canonical, pattern, kind, mountPoints);

  return {
    pattern,
    relativePath: decoded.relativePath,
    hostPath: canonical,
    containerPath: posix.join(CONTAINER_WORKSPACE, decoded.relativePath),
    kind,
    fingerprint,
    recursive: decoded.recursive,
  };
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

/** Convert exact files and directory/** patterns into non-widening mounts. */
export function planWritableMounts(
  workspaceRoot: string,
  allowedPaths: readonly string[],
  options: MountTreeOptions = {},
): WritableMount[] {
  const mountPoints = options.mountPoints ?? hostMountPoints();
  const candidates = allowedPaths.map((pattern) => candidateFor(workspaceRoot, pattern, mountPoints));
  candidates.sort(
    (a, b) =>
      pathDepth(a.relativePath) - pathDepth(b.relativePath) ||
      a.relativePath.localeCompare(b.relativePath),
  );

  const selected: AllowedMountCandidate[] = [];
  for (const candidate of candidates) {
    if (!selected.some((prior) => prior.relativePath === candidate.relativePath)) {
      selected.push(candidate);
    }
  }
  return selected.map(({ recursive: _recursive, ...mount }) => mount);
}

export function workspaceFingerprint(workspaceRoot: string): string {
  const entry = lstatSync(workspaceRoot, { bigint: true });
  const hash = createHash("sha256");
  updateStatFingerprint(hash, "workspace", entry);
  return hash.digest("hex");
}

function sameMounts(expected: readonly WritableMount[], actual: readonly WritableMount[]): boolean {
  return expected.length === actual.length && expected.every((mount, index) => {
    const candidate = actual[index];
    return candidate !== undefined &&
      mount.pattern === candidate.pattern &&
      mount.relativePath === candidate.relativePath &&
      mount.hostPath === candidate.hostPath &&
      mount.containerPath === candidate.containerPath &&
      mount.kind === candidate.kind &&
      mount.fingerprint === candidate.fingerprint;
  });
}

/** Synchronous final check; call it immediately before spawning Docker. */
export function revalidateSandboxPlan(spec: SandboxRunSpec, plan: SandboxPlan): void {
  try {
    const canonical = canonicalWorkspaceRoot(spec.workspaceRoot);
    if (
      canonical !== plan.workspaceRoot ||
      workspaceFingerprint(canonical) !== plan.workspaceFingerprint
    ) {
      throw new SandboxPathChangedError("workspace identity changed after sandbox planning");
    }
    const current = planWritableMounts(canonical, spec.manifest.allowed_paths);
    if (!sameMounts(plan.allowedPathMounts, current)) {
      throw new SandboxPathChangedError(
        "allowed_paths contents or identity changed after sandbox planning",
      );
    }
  } catch (cause) {
    if (cause instanceof SandboxPathChangedError) throw cause;
    throw new SandboxPathChangedError(
      "allowed_paths became unsafe or unrepresentable after sandbox planning",
      { cause },
    );
  }
}

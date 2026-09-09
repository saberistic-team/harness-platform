import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandbox, validateSandboxImage, validateLocalDockerHost, type CommandExecutor } from "@harness/sandbox-runner";
import { type Workspace, type CommandRequest, type CommandResult, type WorkspaceSnapshot } from "./index";
import { type AdapterOptions, type FileTree, type WorkspaceLimits, WorkspaceAudit, validateOptions, limitsFor, patternsFor, safePath, allows, commandFor, validateTree, assertChanges, treePatch, fail } from "./adapter-common";
import { LocalWorkspace } from "./local";
import { CONTAINER_PROGRAM } from "./container-program";

export interface DockerWorkspaceOptions extends AdapterOptions {
  /** Reviewed credential-free Node 22+ image pinned by sha256 digest. */
  image: string;
  executor?: CommandExecutor;
  dockerHost?: string;
  diskBytes?: number;
  /** Exact workspace-relative text output paths retrievable after disposal. */
  artifacts?: readonly string[];
}
export interface WorkspaceExport { patch: string; artifacts: Readonly<FileTree> }
/**
 * A run's state is a bounded copied text worktree. Each execute creates and
 * destroys one M3-runner container. No container, process, host mount, Git
 * configuration, model provider credential, or user environment is retained.
 */
export class DockerWorkspace implements Workspace {
  private readonly limits: WorkspaceLimits;
  private readonly allowedPaths: readonly string[];
  private readonly artifactPaths: readonly string[];
  private initial: FileTree;
  private tree: FileTree;
  private readonly audit: WorkspaceAudit;
  private readonly options: DockerWorkspaceOptions;
  private disposed = false;
  private closing?: Promise<void>;
  private busy = false;
  private readonly cancellation = new AbortController();
  private pending?: Promise<CommandResult>;
  private exported?: WorkspaceExport;
  private expiry?: ReturnType<typeof setTimeout>;
  private expiresAt?: number;
  private readonly root: string;

  private constructor(options: DockerWorkspaceOptions, files: FileTree) {
    this.options = { ...options };
    this.limits = limitsFor(options.limits);
    this.allowedPaths = patternsFor(options.allowedPaths);
    this.artifactPaths = Object.freeze([...(options.artifacts ?? [])]);
    this.initial = validateTree(files, this.limits);
    this.tree = { ...this.initial };
    this.audit = new WorkspaceAudit("docker", options.onEvent);
    this.root = mkdtempSync(join(tmpdir(), "harness-workspace-"));
  }
  static async create(options: DockerWorkspaceOptions): Promise<DockerWorkspace> {
    // All configuration validation precedes even reading the source repository.
    validateOptions(options, "docker");
    validateSandboxImage(options.image);
    validateLocalDockerHost(options.dockerHost);
    const limits = limitsFor(options.limits);
    const patterns = patternsFor(options.allowedPaths);
    if (options.diskBytes !== undefined && (!Number.isSafeInteger(options.diskBytes) || options.diskBytes < 1024 * 1024 || options.diskBytes > 512 * 1024 * 1024)) fail("MALFORMED", "invalid disk limit");
    if (options.artifacts !== undefined && (!Array.isArray(options.artifacts) || options.artifacts.length > limits.files)) fail("MALFORMED", "invalid artifact declarations");
    for (const path of options.artifacts ?? []) {
      safePath(path); if (!allows(patterns, path)) fail("SCOPE", "artifact must be inside allowedPaths");
    }
    const source = new LocalWorkspace({ root: options.root, allowedPaths: options.allowedPaths, limits, developerOnly: true });
    const files: FileTree = Object.create(null);
    try {
      for (const path of await source.listFiles(".")) {
        // Credential-bearing files are never copied, even with broad scope.
        if (/(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.docker|credentials(?:\..*)?|id_rsa|id_ed25519)(\/|$)/iu.test(path)) fail("CREDENTIAL_INPUT", "source contains a credential-bearing path; provide a sanitized worktree");
        files[path] = await source.readFile(path);
      }
    } finally { await source.dispose(); }
    const workspace = new DockerWorkspace(options, files);
    try {
      // Probe through the same immutable image and lifecycle, never a local fallback.
      await workspace.execute({ argv: ["node", "-e", "process.exit(0)"] });
      workspace.audit.emit("opened");
      return workspace;
    } catch (error) { await workspace.dispose(); throw error; }
  }
  private active(): void {
    if (this.disposed) fail("DISPOSED", "workspace is disposed");
    if (this.busy) fail("BUSY", "a workspace command is running");
  }
  async readFile(path: string): Promise<string> {
    this.active(); safePath(path);
    if (!Object.hasOwn(this.tree, path)) fail("NOT_FOUND", "file does not exist");
    return this.tree[path]!;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.active(); safePath(path);
    if (!allows(this.allowedPaths, path)) fail("SCOPE", "write outside allowedPaths");
    this.tree = validateTree({ ...this.tree, [path]: contents }, this.limits);
  }
  async listFiles(path: string): Promise<string[]> {
    this.active(); safePath(path, true);
    const prefix = path === "." ? "" : `${path}/`;
    return Object.keys(this.tree).filter(p => p.startsWith(prefix)).sort();
  }
  async execute(value: CommandRequest): Promise<CommandResult> {
    this.active(); const command = commandFor(value, this.limits);
    const signal = AbortSignal.any([this.cancellation.signal, ...(command.signal ? [command.signal] : [])]);
    this.busy = true;
    this.pending = (async () => {
      try {
        const input = JSON.stringify({ files: this.tree, command: { argv: command.argv, cwd: command.cwd, timeoutMs: command.timeoutMs }, limits: this.limits });
        if (Buffer.byteLength(input) > 32 * 1024 * 1024) fail("LIMIT", "serialized input exceeds limit");
        const result = await runSandbox({
          runId: `${this.audit.id}-${Date.now()}`, workspaceRoot: this.root,
          image: this.options.image, argv: ["node", "-e", CONTAINER_PROGRAM],
          manifest: { allowed_paths: [...this.allowedPaths], permissions: { "fs.read": "allow", "fs.write": "allow", "process.exec": "allow", network: "deny" } },
          disposableWorkspace: { input, diskBytes: this.options.diskBytes ?? 64 * 1024 * 1024 },
        }, {
          executor: this.options.executor, dockerHost: this.options.dockerHost,
          timeoutMs: command.timeoutMs! + 5000, maxOutputBytes: Math.min(64 * 1024 * 1024, this.limits.totalBytes * 6 + this.limits.outputBytes * 6 + 65536),
          signal, onEvent: this.options.onEvent,
        });
        if (result.aborted) fail("CANCELED", "container canceled");
        if (!result.ok || result.outputTruncated) fail("CONTAINER_FAILED", "container failed, exceeded limits, or Docker unavailable");
        let envelope: { version?: unknown; files?: unknown; result?: CommandResult };
        try { envelope = JSON.parse(result.stdout); } catch { fail("MALFORMED", "invalid container response"); }
        if (!envelope || Object.keys(envelope).some(k => !["version", "files", "result"].includes(k)) || envelope.version !== 1 || !envelope.result ||
          Object.keys(envelope.result).some(k => !["exitCode", "stdout", "stderr", "timedOut"].includes(k)) || !Number.isInteger(envelope.result.exitCode) ||
          typeof envelope.result.stdout !== "string" || typeof envelope.result.stderr !== "string" || typeof envelope.result.timedOut !== "boolean" ||
          Buffer.byteLength(envelope.result.stdout) + Buffer.byteLength(envelope.result.stderr) > this.limits.outputBytes) fail("MALFORMED", "invalid container result");
        const tree = validateTree(envelope.files, this.limits);
        assertChanges(this.tree, tree, this.allowedPaths);
        this.tree = tree;
        return { exitCode: envelope.result.exitCode, stdout: envelope.result.stdout, stderr: envelope.result.stderr, timedOut: envelope.result.timedOut };
      } finally { this.busy = false; }
    })();
    return this.pending;
  }
  async diff(): Promise<string> { this.active(); return treePatch(this.initial, this.tree, this.limits.outputBytes); }
  async snapshot(): Promise<WorkspaceSnapshot> { this.active(); return this.audit.snapshot(this.tree); }
  /** Retain only bounded declared outputs, never a live sandbox. Maximum one hour. */
  retain(milliseconds: number): void {
    this.active();
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 3_600_000 || this.expiresAt !== undefined) fail("MALFORMED", "retention must be a single positive lease of at most one hour");
    if (!this.options.onEvent) fail("AUDIT_REQUIRED", "retention requires an onEvent audit sink");
    const expiresAt = Date.now() + milliseconds;
    this.audit.emit("retained", undefined, new Date(expiresAt).toISOString());
    this.expiresAt = expiresAt;
    this.expiry = setTimeout(() => { this.exported = undefined; this.tree = {}; this.audit.emit("expired"); void this.dispose(); }, milliseconds);
    this.expiry.unref();
  }
  exportOutputs(): WorkspaceExport {
    if (this.expiresAt !== undefined && Date.now() >= this.expiresAt) fail("EXPIRED", "retained outputs expired");
    if (this.disposed) {
      if (!this.exported) fail("DISPOSED", "outputs unavailable");
      return this.exported;
    }
    this.active();
    return this.makeExport();
  }
  private makeExport(): WorkspaceExport {
    const artifacts: FileTree = Object.create(null);
    for (const path of this.artifactPaths) if (Object.hasOwn(this.tree, path)) artifacts[path] = this.tree[path]!;
    return Object.freeze({ patch: treePatch(this.initial, this.tree, this.limits.outputBytes), artifacts: Object.freeze(artifacts) });
  }
  async dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.cancellation.abort();
    this.closing = (async () => {
      try { await this.pending; } catch { /* Execution errors belong to caller. */ }
      try { if (this.expiresAt === undefined || Date.now() < this.expiresAt) this.exported = this.makeExport(); }
      finally {
        this.tree = {}; this.initial = {};
        rmSync(this.root, { recursive: true, force: true });
        this.audit.emit("disposed");
      }
    })();
    return this.closing;
  }
}

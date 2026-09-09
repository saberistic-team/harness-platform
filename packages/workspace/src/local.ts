import { constants, openSync, closeSync, fstatSync, readSync, writeSync, ftruncateSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeCommandExecutor, type CommandExecutor } from "@harness/sandbox-runner";
import { openWorkspace, type Workspace, type CommandRequest, type CommandResult } from "./index";
import { type AdapterOptions, type FileTree, type WorkspaceLimits, WorkspaceAudit, validateOptions, limitsFor, patternsFor, safePath, allows, commandFor, validateTree, assertChanges, treePatch, fail } from "./adapter-common";

/** Trusted callers only: process commands are exact, operator-reviewed argv vectors. */
export interface LocalWorkspaceOptions extends AdapterOptions {
  developerOnly: true;
  commands?: readonly (readonly [string, ...string[]])[];
  executor?: CommandExecutor;
}

/**
 * Synchronous identity checks keep callbacks/awaits out of filesystem critical
 * sections. O_NOFOLLOW + descriptor checks reject link substitution. This is
 * a trusted developer adapter, not an OS isolation boundary for hostile peers.
 */
export class LocalWorkspace implements Workspace {
  private readonly root: string;
  private readonly rootIdentity: NonNullable<ReturnType<typeof lstatSync>>;
  private readonly limits: WorkspaceLimits;
  private readonly allowedPaths: readonly string[];
  private readonly commands: readonly (readonly string[])[];
  private readonly executor: CommandExecutor;
  private readonly audit: WorkspaceAudit;
  private readonly initial: FileTree;
  private disposed = false;
  private busy = false;
  private readonly cancellation = new AbortController();
  private running?: Promise<CommandResult>;

  constructor(options: LocalWorkspaceOptions) {
    validateOptions(options, "local");
    if (!options || options.developerOnly !== true) fail("LOCAL_OPT_IN_REQUIRED", "local execution requires developerOnly: true");
    this.limits = limitsFor(options.limits);
    this.allowedPaths = patternsFor(options.allowedPaths);
    if (typeof options.root !== "string" || !options.root || options.root.includes("\0")) fail("MALFORMED", "invalid root");
    if (options.commands !== undefined && !Array.isArray(options.commands)) fail("MALFORMED", "commands must be argv vectors");
    this.commands = Object.freeze((options.commands ?? []).map(argv => Object.freeze([...commandFor({ argv }, this.limits).argv])));
    this.executor = options.executor ?? new NodeCommandExecutor();
    try { this.root = realpathSync(options.root); }
    catch { fail("PATH", "workspace root does not exist or cannot be resolved"); }
    this.rootIdentity = lstatSync(this.root);
    if (!this.rootIdentity.isDirectory()) fail("PATH", "root must be a directory");
    this.audit = new WorkspaceAudit("local", options.onEvent);
    this.initial = this.capture();
    this.audit.emit("opened");
  }
  private active(): void {
    if (this.disposed) fail("DISPOSED", "workspace is disposed");
    if (this.busy) fail("BUSY", "a workspace command is running");
    const now = lstatSync(this.root);
    if (now.dev !== this.rootIdentity.dev || now.ino !== this.rootIdentity.ino || now.isSymbolicLink()) fail("PATH_CHANGED", "workspace root changed");
  }
  private checked(path: string, directory = false): string {
    const root = lstatSync(this.root);
    if (root.isSymbolicLink() || root.ino !== this.rootIdentity.ino || root.dev !== this.rootIdentity.dev) fail("PATH_CHANGED", "workspace root changed");
    safePath(path, directory);
    const result = openWorkspace(this.root).resolvePath(path);
    let current = this.root;
    const segments = path === "." ? [] : path.split("/");
    for (let index = 0; index < segments.length; index++) {
      current = join(current, segments[index]!);
      let entry;
      try { entry = lstatSync(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      if (entry.isSymbolicLink() || entry.dev !== this.rootIdentity.dev || (!entry.isFile() && !entry.isDirectory()) || (entry.isFile() && entry.nlink !== 1)) fail("PATH", "links, mounts and special files are unsupported");
      if (index < segments.length - 1 && !entry.isDirectory()) fail("PATH", "non-directory ancestor");
    }
    return result;
  }
  private openFile(path: string, flags: number, mode?: number): number {
    // Darwin exposes O_NOFOLLOW_ANY in sys/fcntl.h but Node omits its named
    // constant. The kernel rejects symlinks in *any* component atomically.
    if (process.platform === "darwin") {
      try { return openSync(this.checked(path), (flags & ~constants.O_NOFOLLOW) | 0x20000000, mode); }
      catch (cause) { return fail("PATH_CHANGED", "safe file open failed"); }
    }
    if (process.platform !== "linux") return fail("UNSUPPORTED", "safe local file opens require Linux or macOS");
    // Linux directory descriptors anchor each traversal step. Never resolve
    // a multi-component pathname after checking its ancestors.
    const descriptors: number[] = [];
    try {
      let parent = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(parent);
      const root = fstatSync(parent);
      if (root.ino !== this.rootIdentity.ino || root.dev !== this.rootIdentity.dev) fail("PATH_CHANGED", "root changed during open");
      const parts = path.split("/");
      for (const component of parts.slice(0, -1)) {
        parent = openSync(`/proc/self/fd/${parent}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        descriptors.push(parent);
        if (fstatSync(parent).dev !== root.dev) fail("PATH", "cross-device traversal");
      }
      return openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, flags | constants.O_NOFOLLOW, mode);
    } catch { return fail("PATH_CHANGED", "safe file open failed"); }
    finally { for (const fd of descriptors.reverse()) closeSync(fd); }
  }
  private read(path: string): string {
    const target = this.checked(path);
    let before;
    try { before = lstatSync(target); }
    catch { return fail("NOT_FOUND", "file does not exist"); }
    if ((before.mode & 0o111) !== 0) fail("UNSUPPORTED", "executable file modes are outside the text snapshot domain");
    if (!before.isFile() || before.nlink !== 1 || before.size > this.limits.fileBytes) fail("LIMIT", "not a bounded single-link regular file");
    const fd = this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || !stat.isFile()) fail("PATH_CHANGED", "file changed during open");
      this.checked(path);
      const buffer = Buffer.alloc(this.limits.fileBytes + 1);
      let bytes = 0, count = 0;
      do { count = readSync(fd, buffer, bytes, buffer.length - bytes, null); bytes += count; } while (count && bytes < buffer.length);
      if (bytes > this.limits.fileBytes) fail("LIMIT", "read exceeds byte limit");
      const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail("PATH_CHANGED", "file changed during read");
      let result: string;
      try { result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); }
      catch { return fail("UNSUPPORTED", "only UTF-8 text files are supported"); }
      if (result.includes("\0")) fail("UNSUPPORTED", "binary files are unsupported");
      return result;
    } finally { closeSync(fd); }
  }
  private capture(): FileTree {
    const tree: FileTree = Object.create(null);
    let bytes = 0, entries = 0;
    const walk = (path: string): void => {
      const directory = this.checked(path, true);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (path === "." && entry.name === ".git") continue;
        if (++entries > this.limits.files * 2) fail("LIMIT", "tree entry limit exceeded");
        const relative = path === "." ? entry.name : `${path}/${entry.name}`;
        this.checked(relative);
        if (entry.isDirectory()) walk(relative);
        else {
          const data = this.read(relative); bytes += Buffer.byteLength(data);
          if (bytes > this.limits.totalBytes || Object.keys(tree).length >= this.limits.files) fail("LIMIT", "tree limit exceeded");
          tree[relative] = data;
        }
      }
    };
    walk(".");
    return tree;
  }
  async readFile(path: string): Promise<string> { this.active(); return this.read(path); }
  async listFiles(path: string): Promise<string[]> {
    this.active(); this.checked(path, true);
    const prefix = path === "." ? "" : `${path}/`;
    return Object.keys(this.capture()).filter(p => p.startsWith(prefix)).sort();
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.active(); safePath(path);
    if (!allows(this.allowedPaths, path)) fail("SCOPE", "write outside allowedPaths");
    const before = this.capture();
    validateTree({ ...before, [path]: contents }, this.limits);
    const target = this.checked(path);
    // Directory creation is not part of the M8 capability. Missing parents
    // are unsupported rather than using race-prone recursive mkdir.
    try { if (!lstatSync(dirname(target)).isDirectory()) fail("PATH", "parent must be a directory"); }
    catch { fail("UNSUPPORTED", "writeFile requires an existing parent directory"); }
    const parentStat = lstatSync(dirname(target));
    let existed = true;
    let stat: NonNullable<ReturnType<typeof lstatSync>> | undefined;
    try { stat = lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }
    // Never truncate until all identity and link checks pass on the opened fd.
    const fd = this.openFile(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (existed ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    try {
      const opened = fstatSync(fd), nowParent = lstatSync(dirname(target));
      if (!opened.isFile() || opened.nlink !== 1 || (stat && (stat.ino !== opened.ino || stat.dev !== opened.dev)) || parentStat.ino !== nowParent.ino || parentStat.dev !== nowParent.dev) fail("PATH_CHANGED", "write target changed");
      this.checked(path);
      const data = Buffer.from(contents);
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset, offset);
      ftruncateSync(fd, data.length);
    } finally { closeSync(fd); }
  }
  async execute(value: CommandRequest): Promise<CommandResult> {
    this.active();
    const command = commandFor(value, this.limits);
    if (!this.commands.some(argv => JSON.stringify(argv) === JSON.stringify(command.argv))) fail("UNSUPPORTED", "command is not an explicitly reviewed local argv vector");
    const cwd = this.checked(command.cwd ?? ".", true);
    if (!lstatSync(cwd).isDirectory()) fail("PATH", "cwd must be a directory");
    const before = this.capture();
    this.busy = true;
    const signal = AbortSignal.any([this.cancellation.signal, ...(command.signal ? [command.signal] : [])]);
    this.running = (async () => {
      try {
        const result = await this.executor.execute(command.argv[0], command.argv.slice(1), {
          cwd, timeoutMs: command.timeoutMs!, maxOutputBytes: this.limits.outputBytes,
          environment: { PATH: "/usr/bin:/bin:/usr/local/bin", LANG: "C", LC_ALL: "C" }, signal,
        });
        assertChanges(before, this.capture(), this.allowedPaths);
        if (result.outputTruncated) fail("LIMIT", "command output exceeded limit");
        if (result.aborted) fail("CANCELED", "command canceled");
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
      } finally { this.busy = false; }
    })();
    return this.running;
  }
  async diff(): Promise<string> {
    this.active(); const tree = this.capture(); assertChanges(this.initial, tree, this.allowedPaths);
    return treePatch(this.initial, tree, this.limits.outputBytes);
  }
  async snapshot() { this.active(); return this.audit.snapshot(this.capture()); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true; this.cancellation.abort();
    try { await this.running; } catch { /* Caller receives execution failure. */ }
    this.audit.emit("disposed");
  }
}

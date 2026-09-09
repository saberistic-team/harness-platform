import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSandboxPlan, NodeCommandExecutor, type CommandExecutor, type ExecuteOptions, type ExecuteResult } from "@harness/sandbox-runner";
import { LocalWorkspace, DockerWorkspace, createNativeWorkspace, invokeWorkspaceOperation, treePatch, type Workspace, type FileTree } from "../src/index";
import { CONTAINER_PROGRAM } from "../src/container-program";

const IMAGE = `node@sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const workspaces: Workspace[] = [];
function repository() {
  const root = mkdtempSync(join(tmpdir(), "workspace-conformance-")); roots.push(root);
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/a.txt"), "before\n");
  writeFileSync(join(root, "fixed.txt"), "read only\n");
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) await workspace.dispose().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const success = (stdout = ""): ExecuteResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, aborted: false, outputTruncated: false });
class DockerFixture implements CommandExecutor {
  calls: { executable: string; args: readonly string[]; options: ExecuteOptions }[] = [];
  transform?: (files: FileTree) => FileTree;
  fail = false;
  cleanupFail = false;
  async execute(executable: string, args: readonly string[], options: ExecuteOptions): Promise<ExecuteResult> {
    this.calls.push({ executable, args, options });
    if (args[0] === "rm") {
      if (this.cleanupFail) return { ...success(), exitCode: 1, stderr: "daemon failure" };
      return success();
    }
    if (args[0] !== "run") throw Error(`unexpected Docker operation ${args[0]}`);
    options.onSpawn?.();
    writeFileSync(args[args.indexOf("--cidfile") + 1]!, "a".repeat(64));
    if (this.fail) return { ...success(), exitCode: 125 };
    const input = JSON.parse(options.input!);
    return success(JSON.stringify({ version: 1, files: this.transform?.(input.files) ?? input.files, result: { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false } }));
  }
}

for (const backend of ["local", "docker"] as const) {
  describe(`${backend} Workspace conformance`, () => {
    async function open(): Promise<{ workspace: Workspace; root: string; fixture: DockerFixture }> {
      const root = repository(); const fixture = new DockerFixture();
      const workspace = backend === "local"
        ? new LocalWorkspace({ root, developerOnly: true, allowedPaths: ["src/**"], commands: [[process.execPath, "-e", "console.log('ok')"]] })
        : await DockerWorkspace.create({ root, allowedPaths: ["src/**"], image: IMAGE, executor: fixture });
      workspaces.push(workspace); return { workspace, root, fixture };
    }
    it("reads, lists, writes, snapshots and emits an applicable bounded Git patch", async () => {
      const { workspace, root } = await open();
      expect(await workspace.readFile("src/a.txt")).toBe("before\n");
      expect(await workspace.listFiles("src")).toEqual(["src/a.txt"]);
      const before = await workspace.snapshot();
      await workspace.writeFile("src/a.txt", "after\n");
      await workspace.writeFile("src/new.txt", "new text");
      const after = await workspace.snapshot();
      expect(after.id).not.toBe(before.id);
      expect((await workspace.snapshot()).id).toBe(after.id);
      const patch = await workspace.diff(); expect(patch).toContain("+after");
      const applyRoot = repository();
      execFileSync("git", ["apply", "--check", "-"], { cwd: applyRoot, input: patch });
      execFileSync("git", ["apply", "-"], { cwd: applyRoot, input: patch });
      expect(readFileSync(join(applyRoot, "src/new.txt"), "utf8")).toBe("new text");
      if (backend === "docker") expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("before\n");
    });
    it("rejects traversal, malformed input, unknown operations and out-of-scope writes without effects", async () => {
      const { workspace, root, fixture } = await open();
      const calls = fixture.calls.length;
      for (const path of ["../escape", "/tmp/escape", "src/../../escape", "src/./a.txt", "src\\escape", "src/\0bad", ".git/config"]) {
        await expect(workspace.writeFile(path, "bad")).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
      }
      await expect(workspace.writeFile("fixed.txt", "bad")).rejects.toMatchObject({ code: "WORKSPACE_SCOPE" });
      await expect(workspace.writeFile("src/a.txt", 42 as never)).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
      await expect(workspace.execute({ argv: [] } as never)).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });
      await expect(workspace.execute({ argv: ["node"], cwd: "../bad" })).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
      await expect(invokeWorkspaceOperation(workspace, { operation: "restore" } as never)).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_UNKNOWN" });
      expect(fixture.calls.length).toBe(calls);
      expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("before\n");
    });
    it("runs argv commands and cancels before process creation", async () => {
      const { workspace, fixture } = await open();
      expect((await workspace.execute({ argv: [process.execPath, "-e", "console.log('ok')"] })).stdout).toBe("ok\n");
      const calls = fixture.calls.length;
      await expect(workspace.execute({ argv: ["node"], signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "WORKSPACE_CANCELED" });
      expect(fixture.calls.length).toBe(calls);
    });
    it("bounds writes and makes disposal terminal and idempotent", async () => {
      const { workspace } = await open();
      await expect(workspace.writeFile("src/a.txt", "x".repeat(1024 * 1024 + 1))).rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
      await workspace.dispose(); await workspace.dispose();
      await expect(workspace.readFile("src/a.txt")).rejects.toMatchObject({ code: "WORKSPACE_DISPOSED" });
      await expect(workspace.execute({ argv: ["node"] })).rejects.toMatchObject({ code: "WORKSPACE_DISPOSED" });
      await expect(workspace.snapshot()).rejects.toMatchObject({ code: "WORKSPACE_DISPOSED" });
    });
  });
}

describe("LocalWorkspace trust and filesystem boundary", () => {
  it("requires explicit local opt-in before accessing even a nonexistent root", async () => {
    expect(() => new LocalWorkspace({ root: "/nonexistent", allowedPaths: ["src/**"] } as never)).toThrow(expect.objectContaining({ code: "WORKSPACE_LOCAL_OPT_IN_REQUIRED" }));
    await expect(createNativeWorkspace({ backend: "local", root: "/nonexistent", allowedPaths: ["src/**"] } as never)).rejects.toMatchObject({ code: "WORKSPACE_LOCAL_OPT_IN_REQUIRED" });
  });
  it.each(["symlink", "hardlink", "ancestor"])("rejects %s substitution and leaves the victim untouched", async kind => {
    const root = repository(), outside = repository();
    const workspace = new LocalWorkspace({ root, developerOnly: true, allowedPaths: ["src/**"] }); workspaces.push(workspace);
    const victim = join(outside, "src/a.txt"), target = join(root, "src/a.txt");
    rmSync(target);
    if (kind === "symlink") symlinkSync(victim, target);
    if (kind === "hardlink") linkSync(victim, target);
    if (kind === "ancestor") { rmSync(join(root, "src"), { recursive: true }); symlinkSync(join(outside, "src"), join(root, "src")); }
    await expect(workspace.readFile("src/a.txt")).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
    await expect(workspace.writeFile("src/a.txt", "attacked")).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
    expect(readFileSync(victim, "utf8")).toBe("before\n");
  });
  it("rejects unreviewed argv without invoking the executor", async () => {
    const execute = vi.fn(); const workspace = new LocalWorkspace({ root: repository(), developerOnly: true, allowedPaths: ["src/**"], executor: { execute } }); workspaces.push(workspace);
    await expect(workspace.execute({ argv: ["sh", "-c", "touch bad"] })).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("detects a trusted command changing out-of-scope files", async () => {
    const root = repository();
    const workspace = new LocalWorkspace({ root, developerOnly: true, allowedPaths: ["src/**"], commands: [["reviewed"]], executor: { async execute() { writeFileSync(join(root, "fixed.txt"), "bad"); return success(); } } }); workspaces.push(workspace);
    await expect(workspace.execute({ argv: ["reviewed"] })).rejects.toMatchObject({ code: "WORKSPACE_SCOPE" });
  });
  it("aborts running commands during disposal", async () => {
    const argv = [process.execPath, "-e", "setInterval(()=>{},1000)"] as const;
    const workspace = new LocalWorkspace({ root: repository(), developerOnly: true, allowedPaths: ["src/**"], commands: [argv] }); workspaces.push(workspace);
    const pending = workspace.execute({ argv });
    const rejected = expect(pending).rejects.toMatchObject({ code: "WORKSPACE_CANCELED" });
    await workspace.dispose(); await rejected;
  });
});

describe("DockerWorkspace M3 lifecycle adaptation", () => {
  it("defaults native selection to Docker and uses no host mount or inherited credentials", async () => {
    const root = repository(), fixture = new DockerFixture();
    const workspace = await createNativeWorkspace({ root, allowedPaths: ["src/**"], image: IMAGE, executor: fixture }); workspaces.push(workspace);
    expect(workspace).toBeInstanceOf(DockerWorkspace);
    const call = fixture.calls[0]!;
    expect(call.args).not.toContain("--mount"); expect(call.args).not.toContain("--volume");
    expect(call.args).toContain("--read-only"); expect(call.args).toContain("--pids-limit");
    expect(call.args).toContain("--memory-swap"); expect(call.args).toContain("--cpus");
    expect(call.args[call.args.indexOf("--network") + 1]).toBe("none");
    expect(call.args).toContain("/workspace:rw,nosuid,nodev,size=67108864,uid=65534,gid=65534,mode=0700");
    expect(call.options.environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(call.options.environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(call.options.environment.HOME).not.toBe(process.env.HOME);
    expect(call.options.input).not.toContain('".git/');
    expect(fixture.calls.at(-1)?.args.slice(0, 3)).toEqual(["rm", "--force", "--volumes"]);
  });
  it("fails closed on Docker unavailability and cleanup failure", async () => {
    const fixture = new DockerFixture(); fixture.fail = true;
    await expect(createNativeWorkspace({ root: repository(), allowedPaths: ["src/**"], image: IMAGE, executor: fixture })).rejects.toMatchObject({ code: "WORKSPACE_CONTAINER_FAILED" });
    expect(fixture.calls.at(-1)?.args[0]).toBe("rm");
    fixture.fail = false; fixture.cleanupFail = true;
    await expect(DockerWorkspace.create({ root: repository(), allowedPaths: ["src/**"], image: IMAGE, executor: fixture })).rejects.toMatchObject({ code: "SANDBOX_CLEANUP_FAILED" });
  });
  it("rejects mutable images, credential files, invalid limits and unknown selection before execution", async () => {
    const fixture = new DockerFixture(), root = repository();
    await expect(DockerWorkspace.create({ root, allowedPaths: ["src/**"], image: "node:22", executor: fixture })).rejects.toMatchObject({ code: "SANDBOX_UNTRUSTED_IMAGE" });
    await expect(DockerWorkspace.create({ root, allowedPaths: ["../bad"], image: IMAGE, executor: fixture })).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
    await expect(DockerWorkspace.create({ root, allowedPaths: ["src/**"], image: IMAGE, diskBytes: -1, executor: fixture })).rejects.toMatchObject({ code: "WORKSPACE_MALFORMED" });
    await expect(createNativeWorkspace({ backend: "magic" } as never)).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
    writeFileSync(join(root, ".env"), "TOKEN=secret");
    await expect(DockerWorkspace.create({ root, allowedPaths: ["src/**"], image: IMAGE, executor: fixture })).rejects.toMatchObject({ code: "WORKSPACE_CREDENTIAL_INPUT" });
    expect(fixture.calls).toHaveLength(0);
  });
  it("rejects malicious output paths and out-of-scope modifications after proven cleanup", async () => {
    const fixture = new DockerFixture();
    const workspace = await DockerWorkspace.create({ root: repository(), allowedPaths: ["src/**"], image: IMAGE, executor: fixture }); workspaces.push(workspace);
    fixture.transform = files => ({ ...files, "../escape": "attack" });
    await expect(workspace.execute({ argv: ["fixture"] })).rejects.toMatchObject({ code: "WORKSPACE_PATH" });
    expect(fixture.calls.at(-1)?.args[0]).toBe("rm");
    fixture.transform = files => ({ ...files, "fixed.txt": "attack" });
    await expect(workspace.execute({ argv: ["fixture"] })).rejects.toMatchObject({ code: "WORKSPACE_SCOPE" });
    expect(await workspace.readFile("fixed.txt")).toBe("read only\n");
  });
  it("exports only declared artifacts and patch after disposal; explicit retention expires and is audited", async () => {
    const events: unknown[] = [], fixture = new DockerFixture();
    const workspace = await DockerWorkspace.create({ root: repository(), allowedPaths: ["src/**"], artifacts: ["src/artifact.txt"], image: IMAGE, executor: fixture, onEvent: event => events.push(event) }); workspaces.push(workspace);
    await workspace.writeFile("src/artifact.txt", "artifact");
    await workspace.writeFile("src/other.txt", "only in patch");
    vi.useFakeTimers(); workspace.retain(1000);
    await workspace.dispose();
    expect(workspace.exportOutputs().artifacts).toEqual({ "src/artifact.txt": "artifact" });
    expect(workspace.exportOutputs().patch).toContain("only in patch");
    await vi.advanceTimersByTimeAsync(1001);
    expect(() => workspace.exportOutputs()).toThrow(expect.objectContaining({ code: "WORKSPACE_EXPIRED" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "workspace.lifecycle", data: expect.objectContaining({ phase: "expired" }) }));
  });
});

it("runs the actual container bootstrap offline against a temporary copy", async () => {
  const root = repository();
  const program = CONTAINER_PROGRAM.replaceAll("/workspace", root);
  rmSync(join(root, "src"), { recursive: true }); rmSync(join(root, "fixed.txt")); rmSync(join(root, ".git"), { recursive: true });
  const result = await new NodeCommandExecutor().execute(process.execPath, ["-e", program], {
    cwd: root, timeoutMs: 5000, maxOutputBytes: 1024 * 1024, environment: { PATH: process.env.PATH },
    input: JSON.stringify({ files: { "a.txt": "before" }, command: { argv: [process.execPath, "-e", "require('fs').writeFileSync('a.txt','after'); console.log('done')"], timeoutMs: 1000 }, limits: { files: 100, fileBytes: 1024, totalBytes: 4096, outputBytes: 1024 } }),
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ files: { "a.txt": "after" }, result: { stdout: "done\n", exitCode: 0 } });
});

it("produces applicable patches for empty files, deletion and missing final newlines", () => {
  const root = repository();
  const before = { "src/a.txt": "before\n", "fixed.txt": "read only\n" };
  const after = { "src/empty.txt": "", "src/no-newline.txt": "one\ntwo", "fixed.txt": "new" };
  const patch = treePatch(before, after, 10000);
  execFileSync("git", ["apply", "-"], { cwd: root, input: patch });
  expect(readFileSync(join(root, "src/empty.txt"), "utf8")).toBe("");
  expect(readFileSync(join(root, "src/no-newline.txt"), "utf8")).toBe("one\ntwo");
});

it("does not widen denied or unresolved permissions in the M3 disposable mode", async () => {
  for (const permission of ["deny", "ask"] as const) {
    await expect(createSandboxPlan({
      runId: "disposable-policy", workspaceRoot: repository(), image: IMAGE,
      argv: ["node", "-e", "process.exit(0)"],
      manifest: { allowed_paths: ["src/**"], permissions: { "fs.read": "allow", "fs.write": permission, "process.exec": "allow", network: "deny" } },
      disposableWorkspace: { input: "{}", diskBytes: 1024 * 1024 },
    })).rejects.toMatchObject({ code: "SANDBOX_UNREPRESENTABLE_POLICY" });
  }
});

it("rejects unknown configuration and missing parent writes without creating directories", async () => {
  const root = repository();
  expect(() => new LocalWorkspace({ root, allowedPaths: ["src/**"], developerOnly: true, environment: { SECRET: "bad" } } as never)).toThrow(expect.objectContaining({ code: "WORKSPACE_MALFORMED" }));
  const workspace = new LocalWorkspace({ root, allowedPaths: ["src/**"], developerOnly: true }); workspaces.push(workspace);
  await expect(workspace.writeFile("src/missing/file.txt", "bad")).rejects.toMatchObject({ code: "WORKSPACE_UNSUPPORTED" });
  expect(await workspace.listFiles("src")).toEqual(["src/a.txt"]);
});

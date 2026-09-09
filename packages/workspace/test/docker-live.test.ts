/** Scheduled/manual lane. Default tests never contact Docker or the network. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerWorkspace } from "../src/index";
import { NodeCommandExecutor, restrictedDockerClientEnv } from "@harness/sandbox-runner";

const enabled = process.env.HARNESS_WORKSPACE_LIVE === "1";
const image = process.env.HARNESS_WORKSPACE_IMAGE;
const roots: string[] = [];
const workspaces: DockerWorkspace[] = [];
const containers: string[] = [];
async function open() {
  if (!image) throw Error("HARNESS_WORKSPACE_IMAGE must name a reviewed immutable Node 22+ image");
  const root = mkdtempSync(join(tmpdir(), "workspace-live-")); roots.push(root);
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/a.txt"), "before\n");
  writeFileSync(join(root, "fixed.txt"), "unchanged\n");
  const workspace = await DockerWorkspace.create({
    root, image, allowedPaths: ["src/**"], artifacts: ["src/result.txt"],
    limits: { timeoutMs: 5000 },
    onEvent(event) { if (event.type === "sandbox.started") containers.push(event.data.containerName); },
  });
  workspaces.push(workspace); return { root, workspace };
}
const node = (code: string, timeoutMs?: number) => ({ argv: ["node", "-e", code] as [string, ...string[]], timeoutMs });

describe.skipIf(!enabled)("live Docker Workspace isolation", () => {
  afterEach(async () => {
    for (const workspace of workspaces.splice(0)) await workspace.dispose().catch(() => {});
    const config = mkdtempSync(join(tmpdir(), "workspace-live-client-"));
    try {
      const result = await new NodeCommandExecutor().execute("docker", ["ps", "-a", "--filter", "name=harness-", "--format", "{{.Names}}"], {
        cwd: config, environment: restrictedDockerClientEnv(process.env, { dockerConfigDir: config }), timeoutMs: 10_000, maxOutputBytes: 65536,
      });
      expect(result.exitCode).toBe(0);
      for (const name of containers.splice(0)) expect(result.stdout.split("\n")).not.toContain(name);
    } finally {
      rmSync(config, { recursive: true, force: true });
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    }
  });
  it("copies source, exports an applicable patch and only declared artifacts, then destroys each container", async () => {
    const { root, workspace } = await open();
    const result = await workspace.execute(node("require('fs').writeFileSync('src/a.txt','after\\n');require('fs').writeFileSync('src/result.txt','artifact');console.log('complete')"));
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe("complete\n");
    expect(readFileSync(join(root, "src/a.txt"), "utf8")).toBe("before\n");
    await workspace.dispose();
    expect(workspace.exportOutputs().patch).toContain("+after");
    expect(workspace.exportOutputs().artifacts).toEqual({ "src/result.txt": "artifact" });
  }, 30_000);
  it("cannot read host home, credentials, Docker socket or SSH agent; denies network and root writes", async () => {
    const { workspace } = await open();
    const hostHome = process.env.HOME ?? "/host-home";
    const result = await workspace.execute(node(`
      const fs=require('fs'),net=require('net');
      const probes=${JSON.stringify([`${hostHome}/.ssh`, `${hostHome}/.aws/credentials`, `${hostHome}/.docker/config.json`, "/var/run/docker.sock", "/run/host-services/ssh-auth.sock"])};
      if(probes.some(p=>fs.existsSync(p)))throw Error('host probe visible');
      if(Object.keys(process.env).some(k=>/TOKEN|SECRET|API_KEY|SSH_AUTH_SOCK/.test(k)))throw Error('credential env visible');
      try{fs.writeFileSync('/etc/workspace-escape','bad');throw Error('root writable')}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}
      const socket=net.connect({host:'1.1.1.1',port:443});
      socket.on('connect',()=>{process.exitCode=1;socket.destroy()});
      socket.on('error',()=>console.log('network denied'));
      socket.setTimeout(500,()=>{console.log('network denied');socket.destroy()});
    `));
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain("network denied");
  }, 30_000);
  it.each([
    "require('fs').symlinkSync('/etc/passwd','src/link')",
    "require('fs').linkSync('fixed.txt','src/link')",
    "require('fs').symlinkSync('/tmp','src/directory')",
    "require('fs').writeFileSync('fixed.txt','unauthorized')",
  ])("rejects hostile output: %s", async code => {
    const { workspace, root } = await open();
    await expect(workspace.execute(node(code))).rejects.toThrow();
    expect(readFileSync(join(root, "fixed.txt"), "utf8")).toBe("unchanged\n");
    expect(await workspace.readFile("src/a.txt")).toBe("before\n");
  }, 30_000);
  it("enforces output and wall-time budgets", async () => {
    const { workspace } = await open();
    await expect(workspace.execute(node("process.stdout.write('x'.repeat(2*1024*1024))"))).rejects.toThrow();
    const result = await workspace.execute(node("while(true){}", 100));
    expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0);
  }, 30_000);
  it("enforces tmpfs disk capacity and memory limits", async () => {
    const { workspace } = await open();
    const disk = await workspace.execute(node("try{require('fs').writeFileSync('/tmp/full',Buffer.alloc(80*1024*1024));process.exitCode=1}catch(e){if(e.code!=='ENOSPC')throw e;console.log('disk bounded')}"));
    expect(disk.exitCode).toBe(0); expect(disk.stdout).toContain("disk bounded");
    const memory = await workspace.execute(node("Buffer.alloc(1024*1024*1024,1)"));
    expect(memory.exitCode).not.toBe(0);
  }, 30_000);
  it("enforces process exhaustion and kills detached descendants at the lifecycle boundary", async () => {
    const { workspace } = await open();
    const result = await workspace.execute(node(`
      const cp=require('child_process');let errors=0;const children=[];
      for(let i=0;i<160;i++){const c=cp.spawn('node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.on('error',()=>errors++);children.push(c)}
      setTimeout(()=>{children.forEach(c=>c.kill('SIGKILL'));console.log(errors>0?'pids bounded':'no bound');},1000);
    `));
    expect(result.stdout).toContain("pids bounded");
    await workspace.execute(node("const c=require('child_process').spawn('node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref()"));
  }, 30_000);
  it("cancels a running container and expires retained outputs", async () => {
    const { workspace } = await open();
    const controller = new AbortController();
    const pending = workspace.execute({ ...node("setInterval(()=>{},1000)"), signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow();
    await workspace.writeFile("src/result.txt", "retained");
    workspace.retain(100); await workspace.dispose();
    expect(workspace.exportOutputs().artifacts).toEqual({ "src/result.txt": "retained" });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(() => workspace.exportOutputs()).toThrow(expect.objectContaining({ code: "WORKSPACE_EXPIRED" }));
  }, 30_000);
});

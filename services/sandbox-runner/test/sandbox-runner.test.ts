import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeCommandExecutor,
  SandboxAllowedPathError,
  SandboxCleanupError,
  SandboxDuplicateRunError,
  SandboxPathChangedError,
  SandboxPermissionRequiredError,
  SandboxPermissionResolutionError,
  SandboxPolicyDeniedError,
  SandboxSpecError,
  SandboxUnrepresentablePolicyError,
  SandboxUntrustedImageError,
  argvToPolicySubject,
  createSandboxPlan,
  planWritableMounts,
  restrictedDockerClientEnv,
  runSandbox,
  validateLocalDockerHost,
  type CommandExecutor,
  type ExecuteOptions,
  type ExecuteResult,
  type SandboxRunSpec,
} from "../src";

const temporary: string[] = [];
const CONTAINER_ID = "a".repeat(64);

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-sandbox-"));
  temporary.push(root);
  mkdirSync(join(root, "packages", "events", "src"), { recursive: true });
  mkdirSync(join(root, "packages", "kernel"), { recursive: true });
  writeFileSync(join(root, "packages", "events", "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

function spec(
  root: string,
  overrides: Partial<SandboxRunSpec> = {},
): SandboxRunSpec {
  return {
    runId: "run-1",
    workspaceRoot: root,
    image: "harness-sandbox:test",
    trustedLocalImage: true,
    argv: ["node", "--version"],
    manifest: {
      allowed_paths: ["packages/events/**", "package.json"],
      permissions: {
        "process.exec": { "node --version": "allow", "*": "deny" },
        "fs.read": "allow",
        "fs.write": "allow",
        network: "deny",
      },
    },
    ...overrides,
  };
}

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === option) values.push(args[index + 1]!);
  }
  return values;
}

function success(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...overrides,
  };
}

function noSuchContainer(): ExecuteResult {
  return success({
    exitCode: 1,
    stdout: "",
    stderr: "Error response from daemon: No such container: exact-id\n",
  });
}

interface FakeReply {
  value: ExecuteResult | Error | Promise<ExecuteResult>;
  spawn?: boolean;
  writeCid?: boolean;
  afterSpawn?: () => void;
}

class FakeExecutor implements CommandExecutor {
  readonly calls: Array<{
    executable: string;
    args: string[];
    options: ExecuteOptions;
  }> = [];
  readonly replies: FakeReply[] = [];

  enqueue(
    value: FakeReply["value"],
    options: Omit<FakeReply, "value"> = {},
  ): void {
    this.replies.push({ value, ...options });
  }

  async execute(
    executable: string,
    args: readonly string[],
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    this.calls.push({ executable, args: [...args], options });
    const isRun = args[0] === "run";
    const reply = this.replies.shift() ?? { value: success() };
    if (reply.spawn ?? isRun) options.onSpawn?.();
    if (reply.writeCid ?? isRun) {
      const cidFile = optionValues(args, "--cidfile")[0];
      if (cidFile !== undefined) writeFileSync(cidFile, CONTAINER_ID + "\n");
    }
    reply.afterSpawn?.();
    if (reply.value instanceof Error) throw reply.value;
    return await reply.value;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createSandboxPlan", () => {
  it("produces a hardened argv-only plan with recursive read-only and bounded writable mounts", async () => {
    const root = makeWorkspace();
    const plan = await createSandboxPlan(spec(root));
    const owner = statSync(plan.workspaceRoot);

    expect(plan.commandSubject).toBe("node --version");
    expect(plan.networkMode).toBe("none");
    expect(plan.workspaceMounted).toBe(true);
    expect(plan.writableMounts.map((mount) => mount.relativePath)).toEqual([
      "package.json",
      "packages/events",
    ]);
    expect(plan.dockerArgs.slice(0, 2)).toEqual(["run", "--rm"]);
    for (const required of [
      "--pull",
      "--init",
      "--no-healthcheck",
      "--read-only",
      "--cap-drop",
      "--security-opt",
      "--user",
      "--pids-limit",
      "--memory",
      "--cpus",
      "--tmpfs",
      "--workdir",
    ]) {
      expect(plan.dockerArgs).toContain(required);
    }
    expect(optionValues(plan.dockerArgs, "--network")).toEqual(["none"]);
    expect(optionValues(plan.dockerArgs, "--cap-drop")).toEqual(["ALL"]);
    expect(optionValues(plan.dockerArgs, "--security-opt")).toEqual([
      "no-new-privileges=true",
    ]);
    expect(optionValues(plan.dockerArgs, "--user")).toEqual([
      owner.uid + ":" + owner.gid,
    ]);
    expect(plan.dockerArgs).not.toContain("--privileged");
    expect(optionValues(plan.dockerArgs, "--entrypoint")).toEqual(["node"]);
    expect(optionValues(plan.dockerArgs, "--env")).toEqual([
      "HTTP_PROXY=",
      "HTTPS_PROXY=",
      "FTP_PROXY=",
      "ALL_PROXY=",
      "NO_PROXY=",
      "http_proxy=",
      "https_proxy=",
      "ftp_proxy=",
      "all_proxy=",
      "no_proxy=",
    ]);

    const mounts = optionValues(plan.dockerArgs, "--mount");
    expect(mounts).toEqual([
      [
        "type=bind",
        "source=" + plan.workspaceRoot,
        "target=/workspace",
        "readonly",
        "bind-recursive=readonly",
        "bind-propagation=rprivate",
      ].join(","),
      [
        "type=bind",
        "source=" + join(plan.workspaceRoot, "package.json"),
        "target=/workspace/package.json",
        "bind-recursive=disabled",
        "bind-propagation=rprivate",
      ].join(","),
      [
        "type=bind",
        "source=" + join(plan.workspaceRoot, "packages", "events"),
        "target=/workspace/packages/events",
        "bind-recursive=disabled",
        "bind-propagation=rprivate",
      ].join(","),
    ]);

    const imageAt = plan.dockerArgs.indexOf("harness-sandbox:test");
    expect(plan.dockerArgs.slice(imageAt)).toEqual([
      "harness-sandbox:test",
      "--version",
    ]);
  });

  it("requires a digest unless a tag is explicitly trusted as local", async () => {
    const root = makeWorkspace();
    await expect(
      createSandboxPlan({ ...spec(root), trustedLocalImage: undefined }),
    ).rejects.toBeInstanceOf(SandboxUntrustedImageError);

    const digest = "registry.example/harness@sha256:" + "1".repeat(64);
    const pinned = await createSandboxPlan({
      ...spec(root),
      image: digest,
      trustedLocalImage: undefined,
    });
    expect(pinned.image).toBe(digest);
    expect(optionValues(pinned.dockerArgs, "--pull")).toEqual(["never"]);
  });

  it("derives a deterministic daemon-unique name from runId", async () => {
    const root = makeWorkspace();
    const first = await createSandboxPlan(spec(root));
    const second = await createSandboxPlan(spec(root));
    expect(first.containerName).toBe(second.containerName);
    expect(first.containerName).toMatch(/^harness-run-1-[0-9a-f]{32}$/u);
  });

  it("enforces fs.read and fails closed where Docker cannot represent it", async () => {
    const root = makeWorkspace();
    const denied = spec(root);
    denied.manifest.permissions["fs.read"] = "deny";
    denied.manifest.permissions["fs.write"] = "deny";
    const plan = await createSandboxPlan(denied);
    expect(plan.workspaceMounted).toBe(false);
    expect(optionValues(plan.dockerArgs, "--mount")).toEqual([]);
    expect(optionValues(plan.dockerArgs, "--workdir")).toEqual(["/tmp"]);

    const implicitRead = spec(root);
    implicitRead.manifest.permissions["fs.read"] = "deny";
    await expect(createSandboxPlan(implicitRead)).rejects.toMatchObject({
      code: "SANDBOX_UNREPRESENTABLE_POLICY",
    });

    const patterned = spec(root);
    patterned.manifest.permissions["fs.read"] = {
      "packages/events/**": "allow",
      "*": "deny",
    };
    await expect(createSandboxPlan(patterned)).rejects.toMatchObject({
      code: "SANDBOX_UNREPRESENTABLE_POLICY",
    });
  });

  it("keeps the workspace recursively read-only when fs.write is denied", async () => {
    const root = makeWorkspace();
    const input = spec(root);
    input.manifest.permissions["fs.write"] = "deny";
    const plan = await createSandboxPlan(input);
    expect(plan.writableMounts).toEqual([]);
    expect(optionValues(plan.dockerArgs, "--mount")).toEqual([
      [
        "type=bind",
        "source=" + plan.workspaceRoot,
        "target=/workspace",
        "readonly",
        "bind-recursive=readonly",
        "bind-propagation=rprivate",
      ].join(","),
    ]);
  });

  it("uses bridge networking only after an effective allow", async () => {
    const root = makeWorkspace();
    const allowed = spec(root);
    allowed.manifest.permissions.network = "allow";
    expect((await createSandboxPlan(allowed)).networkMode).toBe("bridge");

    const asked = spec(root);
    asked.manifest.permissions.network = "ask";
    const denied = await createSandboxPlan(asked, {
      permissionResolver: (decision) =>
        decision.action === "network" ? "deny" : "allow",
    });
    expect(denied.networkMode).toBe("none");
  });

  it.each([
    ["process.exec"],
    ["fs.read"],
    ["fs.write"],
    ["network"],
  ])("blocks an unresolved ask for %s", async (action) => {
    const root = makeWorkspace();
    const input = spec(root);
    input.manifest.permissions[action] = "ask";
    await expect(createSandboxPlan(input)).rejects.toMatchObject({
      name: "SandboxPermissionRequiredError",
      code: "SANDBOX_PERMISSION_REQUIRED",
      decision: { action },
    });
  });

  it("reports every initial and effective decision and validates operator responses", async () => {
    const root = makeWorkspace();
    const input = spec(root);
    input.manifest.permissions = {
      "process.exec": "ask",
      "fs.read": "ask",
      "fs.write": "ask",
      network: "ask",
    };
    const seen: string[] = [];
    const plan = await createSandboxPlan(input, {
      permissionResolver: (decision) =>
        decision.action === "network" ? "deny" : "allow",
      onDecision: (outcome) => {
        seen.push(
          [
            outcome.decision.action,
            outcome.decision.effect,
            outcome.effectiveEffect,
            String(outcome.resolvedByOperator),
          ].join(":"),
        );
      },
    });
    expect(seen).toEqual([
      "process.exec:ask:allow:true",
      "fs.read:ask:allow:true",
      "fs.write:ask:allow:true",
      "fs.write:ask:allow:true",
      "network:ask:deny:true",
    ]);
    expect(plan.networkMode).toBe("none");

    await expect(
      createSandboxPlan(input, {
        permissionResolver: () => "ask" as never,
      }),
    ).rejects.toBeInstanceOf(SandboxPermissionResolutionError);
  });

  it("can cancel an outstanding ask without constructing Docker argv", async () => {
    const root = makeWorkspace();
    const controller = new AbortController();
    const waiting = deferred<"allow">();
    const planned = createSandboxPlan(spec(root, {
      manifest: {
        ...spec(root).manifest,
        permissions: {
          ...spec(root).manifest.permissions,
          "process.exec": "ask",
        },
      },
    }), {
      permissionResolver: () => waiting.promise,
      signal: controller.signal,
    });
    controller.abort();
    await expect(planned).rejects.toMatchObject({ code: "SANDBOX_ABORTED" });
    waiting.resolve("allow");
  });

  it("blocks a denied process without constructing an executable plan", async () => {
    const root = makeWorkspace();
    const input = spec(root);
    input.manifest.permissions["process.exec"] = "deny";
    await expect(createSandboxPlan(input)).rejects.toBeInstanceOf(
      SandboxPolicyDeniedError,
    );
  });

  it("supports subject rules for exact files but rejects coarse directory and network policies", async () => {
    const root = makeWorkspace();
    const exact = spec(root, {
      manifest: {
        allowed_paths: ["package.json"],
        permissions: {
          "process.exec": "allow",
          "fs.read": "allow",
          "fs.write": { "package.json": "allow", "*": "deny" },
          network: "deny",
        },
      },
    });
    expect((await createSandboxPlan(exact)).writableMounts).toHaveLength(1);

    const coarse = spec(root);
    coarse.manifest.permissions["fs.write"] = {
      "packages/events": "allow",
      "*": "deny",
    };
    await expect(createSandboxPlan(coarse)).rejects.toBeInstanceOf(
      SandboxUnrepresentablePolicyError,
    );

    const network = spec(root);
    network.manifest.permissions.network = {
      "example.com": "allow",
      "*": "deny",
    };
    await expect(createSandboxPlan(network)).rejects.toMatchObject({
      code: "SANDBOX_UNREPRESENTABLE_POLICY",
    });
  });

  it.each([
    "/etc/**",
    "../escape/**",
    "packages/*/src/**",
    "packages/events/**/secret",
    "packages/events?/**",
    "packages,events/**",
    "**",
  ])("rejects unsafe or unrepresentable allowed path %s", async (pattern) => {
    const root = makeWorkspace();
    const input = spec(root);
    input.manifest.allowed_paths = [pattern];
    await expect(createSandboxPlan(input)).rejects.toBeInstanceOf(
      SandboxAllowedPathError,
    );
  });

  it("rejects missing paths and exact directories rather than widening to a parent", async () => {
    const root = makeWorkspace();
    const missing = spec(root);
    missing.manifest.allowed_paths = ["does-not-exist/**"];
    await expect(createSandboxPlan(missing)).rejects.toMatchObject({
      code: "SANDBOX_ALLOWED_PATH_NOT_FOUND",
    });

    const directory = spec(root);
    directory.manifest.allowed_paths = ["packages/events"];
    await expect(createSandboxPlan(directory)).rejects.toMatchObject({
      code: "SANDBOX_UNREPRESENTABLE_ALLOWED_PATH",
    });
  });

  it("rejects symlink roots, hard links, and nested filesystem mount points", async () => {
    const root = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "harness-sandbox-outside-"));
    temporary.push(outside);
    mkdirSync(join(outside, "data"));
    symlinkSync(join(outside, "data"), join(root, "linked"));
    const linked = spec(root);
    linked.manifest.allowed_paths = ["linked/**"];
    await expect(createSandboxPlan(linked)).rejects.toMatchObject({
      code: "SANDBOX_UNSAFE_ALLOWED_PATH",
    });

    linkSync(
      join(root, "package.json"),
      join(root, "packages", "kernel", "aliased-package.json"),
    );
    const hardLinked = spec(root, {
      manifest: {
        allowed_paths: ["package.json"],
        permissions: {
          "process.exec": "allow",
          "fs.read": "allow",
          "fs.write": "allow",
          network: "deny",
        },
      },
    });
    await expect(createSandboxPlan(hardLinked)).rejects.toMatchObject({
      code: "SANDBOX_UNSAFE_ALLOWED_PATH",
    });

    expect(() => planWritableMounts(
      root,
      ["packages/events/**"],
      {
        mountPoints: new Set([
          join(root, "packages", "events", "src"),
        ]),
      },
    )).toThrow(SandboxAllowedPathError);
  });

  it("derives and quotes the process subject from argv", () => {
    expect(argvToPolicySubject(["pnpm", "test"])).toBe("pnpm test");
    expect(argvToPolicySubject(["sh", "-c", "echo hi; rm -rf /"])).toBe(
      "sh -c 'echo hi; rm -rf /'",
    );
    expect(argvToPolicySubject(["tool", ""])).toBe("tool ''");
  });

  it("rejects malformed runtime input with typed errors", async () => {
    const root = makeWorkspace();
    await expect(
      createSandboxPlan({ ...spec(root), argv: [] }),
    ).rejects.toBeInstanceOf(SandboxSpecError);
    await expect(
      createSandboxPlan({ ...spec(root), image: "--privileged" }),
    ).rejects.toMatchObject({ code: "SANDBOX_INVALID_SPEC" });

    const badManifest = spec(root);
    badManifest.manifest.permissions = {
      "process.exec": null as never,
    };
    await expect(createSandboxPlan(badManifest)).rejects.toBeInstanceOf(
      SandboxSpecError,
    );
  });
});

describe("runSandbox", () => {
  it("runs exactly one container, isolates Docker client state, and proves exact CID cleanup", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    executor.enqueue(success({ stdout: "v22\n" }));
    executor.enqueue(noSuchContainer());
    const phases: string[] = [];
    const events: string[] = [];
    const result = await runSandbox(spec(root), {
      executor,
      onLifecycle: (update) => {
        phases.push(update.phase);
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("v22\n");
    expect(result.cleanup.status).toBe("already_absent");
    expect(executor.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]).toMatchObject({ executable: "docker" });
    expect(executor.calls[0]!.args.filter((arg) => arg === "--rm")).toHaveLength(1);
    expect(optionValues(executor.calls[0]!.args, "--cidfile")).toHaveLength(1);
    expect(optionValues(executor.calls[0]!.args, "--label")).toEqual(
      expect.arrayContaining([
        "harness.run-id=run-1",
        expect.stringMatching(/^harness\.lease-id=/u),
      ]),
    );
    expect(executor.calls[1]!.args).toEqual([
      "rm",
      "--force",
      "--volumes",
      CONTAINER_ID,
    ]);
    expect(phases).toEqual([
      "planned",
      "starting",
      "client_started",
      "exited",
      "cleaning",
      "cleaned",
    ]);
    expect(events).toEqual(["sandbox.started", "sandbox.stopped"]);

    const environment = executor.calls[0]!.options.environment;
    expect(environment.HOME).toBe(environment.DOCKER_CONFIG);
    expect(environment.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(environment.DOCKER_CONTEXT).toBeUndefined();
    expect(environment.HTTP_PROXY).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(executor.calls[1]!.options.environment).toEqual(environment);
    expect(executor.calls[1]!.options.signal).toBeUndefined();
    expect(existsSync(environment.DOCKER_CONFIG!)).toBe(false);
  });

  it("revalidates allowed path contents after observers and immediately before execution", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    await expect(runSandbox(spec(root), {
      executor,
      onLifecycle: (update) => {
        if (update.phase === "starting") {
          writeFileSync(
            join(root, "packages", "events", "src", "index.ts"),
            "export const changed = true;\n",
          );
        }
      },
    })).rejects.toBeInstanceOf(SandboxPathChangedError);
    expect(executor.calls).toEqual([]);
  });

  it("atomically rejects a duplicate active runId before a second Docker invocation", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    const gate = deferred<ExecuteResult>();
    executor.enqueue(gate.promise);
    executor.enqueue(noSuchContainer());
    const first = runSandbox(spec(root), { executor });

    await expect(
      runSandbox(spec(root), { executor }),
    ).rejects.toBeInstanceOf(SandboxDuplicateRunError);
    gate.resolve(success());
    await first;
    expect(executor.calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
  });

  it("cleans its owned container after a client error and then preserves that error", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    executor.enqueue(new Error("transport failed"));
    executor.enqueue(success());
    const phases: string[] = [];
    const events: string[] = [];
    await expect(
      runSandbox(spec(root), {
        executor,
        onLifecycle: (update) => {
          phases.push(update.phase);
        },
        onEvent: (event) => {
          events.push(event.type);
        },
      }),
    ).rejects.toThrow("transport failed");
    expect(executor.calls[1]!.args).toEqual([
      "rm",
      "--force",
      "--volumes",
      CONTAINER_ID,
    ]);
    expect(phases).toEqual([
      "planned",
      "starting",
      "client_started",
      "failed",
      "cleaning",
      "cleaned",
    ]);
    expect(events).toEqual(["error"]);
  });

  it("throws a typed cleanup failure and never claims the sandbox stopped", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    executor.enqueue(success());
    executor.enqueue(success({
      exitCode: 2,
      stderr: "daemon unavailable\n",
    }));
    const phases: string[] = [];
    const events: string[] = [];
    await expect(runSandbox(spec(root), {
      executor,
      onLifecycle: (update) => {
        phases.push(update.phase);
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    })).rejects.toBeInstanceOf(SandboxCleanupError);
    expect(phases).toContain("cleanup_failed");
    expect(phases).not.toContain("cleaned");
    expect(events).toEqual(["sandbox.started", "error"]);
  });

  it("does not delete a same-name container unless the private lease matches", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    executor.enqueue(
      success({ exitCode: 125, stderr: "name is already in use\n" }),
      { writeCid: false },
    );
    executor.enqueue(success({ stdout: CONTAINER_ID + "\tanother-lease\n" }));

    await expect(
      runSandbox(spec(root), { executor }),
    ).rejects.toBeInstanceOf(SandboxCleanupError);
    expect(executor.calls.map((call) => call.args[0])).toEqual([
      "run",
      "inspect",
    ]);
  });

  it("passes cancellation to the run client but never cancels exact cleanup", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    const controller = new AbortController();
    executor.enqueue(
      success({
        exitCode: 130,
        signal: "SIGKILL",
        aborted: true,
      }),
      { afterSpawn: () => controller.abort() },
    );
    executor.enqueue(noSuchContainer());
    const phases: string[] = [];
    const result = await runSandbox(spec(root), {
      executor,
      signal: controller.signal,
      onLifecycle: (update) => {
        phases.push(update.phase);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(executor.calls[0]!.options.signal).toBe(controller.signal);
    expect(executor.calls[1]!.options.signal).toBeUndefined();
    expect(phases).toContain("canceled");
  });

  it("never invokes Docker when policy needs permission or denies execution", async () => {
    const root = makeWorkspace();
    for (const effect of ["ask", "deny"] as const) {
      const executor = new FakeExecutor();
      const input = spec(root);
      input.manifest.permissions["process.exec"] = effect;
      await expect(runSandbox(input, { executor })).rejects.toBeInstanceOf(
        effect === "ask"
          ? SandboxPermissionRequiredError
          : SandboxPolicyDeniedError,
      );
      expect(executor.calls).toEqual([]);
    }
  });

  it("rejects unsafe executor and Docker endpoint configuration before execution", async () => {
    const root = makeWorkspace();
    const executor = new FakeExecutor();
    await expect(
      runSandbox(spec(root), { executor, timeoutMs: 0 }),
    ).rejects.toBeInstanceOf(SandboxSpecError);
    await expect(
      runSandbox(spec(root), { executor, timeoutMs: 2_147_483_648 }),
    ).rejects.toBeInstanceOf(SandboxSpecError);
    await expect(
      runSandbox(spec(root), { executor, dockerBinary: "" }),
    ).rejects.toBeInstanceOf(SandboxSpecError);
    await expect(
      runSandbox(spec(root), { executor, dockerHost: "tcp://daemon:2375" }),
    ).rejects.toMatchObject({ code: "SANDBOX_UNSAFE_DOCKER_HOST" });
    expect(executor.calls).toEqual([]);
  });
});

describe("process boundary", () => {
  it("uses an isolated Docker config and omits host context, proxies, and secrets", () => {
    const config = mkdtempSync(join(tmpdir(), "harness-docker-config-test-"));
    temporary.push(config);
    const env = restrictedDockerClientEnv({
      PATH: "/bin",
      DOCKER_HOST: "tcp://remote:2375",
      DOCKER_CONTEXT: "production",
      HTTP_PROXY: "http://secret-proxy",
      OPENAI_API_KEY: "must-not-cross",
      HARNESS_SECRET: "must-not-cross",
      HOME: "/secret-home",
    }, {
      dockerConfigDir: config,
      dockerHost: "unix:///run/user/501/docker.sock",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe(config);
    expect(env.DOCKER_CONFIG).toBe(config);
    expect(env.DOCKER_HOST).toBe("unix:///run/user/501/docker.sock");
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HARNESS_SECRET).toBeUndefined();
  });

  it("accepts only explicit local Unix daemon sockets", () => {
    expect(validateLocalDockerHost("unix:///var/run/docker.sock")).toBe(
      "unix:///var/run/docker.sock",
    );
    for (const host of [
      "tcp://localhost:2375",
      "ssh://builder",
      "npipe:////./pipe/docker_engine",
      "unix://relative.sock",
    ]) {
      expect(() => validateLocalDockerHost(host)).toThrowError(
        expect.objectContaining({ code: "SANDBOX_UNSAFE_DOCKER_HOST" }),
      );
    }
  });

  it("executes argv directly, bounds output, and uses only its supplied environment", async () => {
    const root = makeWorkspace();
    const executor = new NodeCommandExecutor();
    const result = await executor.execute(
      process.execPath,
      [
        "-e",
        "process.stdout.write('abcdefgh'); process.stderr.write(process.env.OPENAI_API_KEY ?? '')",
      ],
      {
        cwd: root,
        timeoutMs: 2_000,
        maxOutputBytes: 5,
        environment: {},
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abcde");
    expect(result.stderr).toBe("");
    expect(result.outputTruncated).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("kills a spawned Docker client analogue when its AbortSignal fires", async () => {
    const root = makeWorkspace();
    const executor = new NodeCommandExecutor();
    const controller = new AbortController();
    let spawned = false;
    const result = await executor.execute(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        cwd: root,
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        environment: {},
        signal: controller.signal,
        onSpawn: () => {
          spawned = true;
          controller.abort();
        },
      },
    );
    expect(spawned).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGKILL");
  });
});

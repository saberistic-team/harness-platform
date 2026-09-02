import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_CAPABILITIES,
  WorkspaceEscapesRootError,
  WorkspaceOperationMalformedError,
  WorkspaceOperationRequiredError,
  WorkspaceOperationUnknownError,
  WorkspaceOperationUnsupportedError,
  bindWorkspace,
  invokeWorkspaceOperation,
  openWorkspace,
  restrictWorkspace,
  type CommandRequest,
  type Workspace,
} from "../src/index";

function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    readFile: async (path) => `read:${path}`,
    writeFile: async () => undefined,
    listFiles: async (path) => [`${path}/a.ts`, `${path}/b.ts`],
    execute: async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }),
    diff: async () => "diff --git a/a b/a",
    snapshot: async () => ({
      id: "snapshot-1",
      createdAt: "2026-09-02T00:00:00.000Z",
      metadata: { clean: true, files: 2 },
    }),
    dispose: async () => undefined,
    ...overrides,
  };
}

describe("WorkspacePathScope", () => {
  it("preserves the lexical path helper without treating it as a capability", () => {
    const scope = openWorkspace("./fixture-root");

    expect(scope.root).toBe(resolve("./fixture-root"));
    expect(scope.resolvePath("src/index.ts")).toBe(
      resolve("./fixture-root/src/index.ts"),
    );
    expect("readFile" in scope).toBe(false);
  });

  it("rejects lexical escapes with the existing typed error", () => {
    const scope = openWorkspace("./fixture-root");

    expect(() => scope.resolvePath("../outside.txt")).toThrow(
      WorkspaceEscapesRootError,
    );
  });
});

describe("bindWorkspace", () => {
  it("exports exactly the M6 operational capabilities", () => {
    expect(WORKSPACE_CAPABILITIES).toEqual([
      "readFile",
      "writeFile",
      "listFiles",
      "execute",
      "diff",
      "snapshot",
      "dispose",
    ]);
    expect(Object.isFrozen(WORKSPACE_CAPABILITIES)).toBe(true);
    expect(() => (WORKSPACE_CAPABILITIES as unknown as string[]).push("escape"))
      .toThrow(TypeError);
  });

  it("captures caller-owned methods, binds their receiver, and freezes the facade", async () => {
    const owner = {
      prefix: "original",
      ...workspaceFixture(),
      async readFile(this: { prefix: string }, path: string) {
        return `${this.prefix}:${path}`;
      },
    };
    const bound = bindWorkspace(owner);

    owner.prefix = "changed-state";
    owner.readFile = async () => "replaced-method";

    expect(Object.isFrozen(bound)).toBe(true);
    expect(await bound.readFile("file.ts")).toBe("changed-state:file.ts");
  });

  it("rejects missing, malformed, and unsupported capabilities synchronously", () => {
    expect(() => bindWorkspace(undefined)).toThrow(
      WorkspaceOperationRequiredError,
    );
    expect(() => bindWorkspace("workspace")).toThrow(
      WorkspaceOperationMalformedError,
    );
    expect(() => bindWorkspace({})).toThrowError(
      expect.objectContaining({
        code: "WORKSPACE_OPERATION_UNSUPPORTED",
        operation: "readFile",
      }),
    );
    expect(() => bindWorkspace({
      ...workspaceFixture(),
      diff: undefined,
    })).toThrow(WorkspaceOperationUnsupportedError);
  });

  it("turns throwing capability accessors into a typed malformed error", () => {
    const workspace = workspaceFixture() as Workspace & Record<string, unknown>;
    Object.defineProperty(workspace, "readFile", {
      get() {
        throw new Error("caller secret");
      },
    });

    expect(() => bindWorkspace(workspace)).toThrowError(
      expect.objectContaining({
        code: "WORKSPACE_OPERATION_MALFORMED",
        operation: "readFile",
      }),
    );
  });

  it("uses the intrinsic bind operation instead of a method-controlled override", async () => {
    const readFile = async (path: string) => `original:${path}`;
    Object.defineProperty(readFile, "bind", {
      value: () => async () => "redirected",
    });
    const bound = bindWorkspace(workspaceFixture({ readFile }));

    await expect(bound.readFile("safe.txt")).resolves.toBe("original:safe.txt");
  });
});

describe("restrictWorkspace", () => {
  it("delegates only the reviewed operation and rejects every other capability", async () => {
    const readFile = vi.fn(async (path: string) => `content:${path}`);
    const writeFile = vi.fn(async () => undefined);
    const workspace = restrictWorkspace(
      workspaceFixture({ readFile, writeFile }),
      "readFile",
    );

    await expect(workspace.readFile("safe.txt")).resolves.toBe("content:safe.txt");
    await expect(workspace.writeFile("safe.txt", "changed")).rejects.toMatchObject({
      code: "WORKSPACE_OPERATION_UNSUPPORTED",
      operation: "writeFile",
    });
    await expect(workspace.execute({ argv: ["true"] })).rejects.toMatchObject({
      code: "WORKSPACE_OPERATION_UNSUPPORTED",
      operation: "execute",
    });
    expect(readFile).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("invokeWorkspaceOperation", () => {
  it("strictly dispatches every canonical operation", async () => {
    const workspace = workspaceFixture();
    const read: string = await invokeWorkspaceOperation(workspace, {
      operation: "readFile",
      path: "src/index.ts",
    });
    expect(read).toBe("read:src/index.ts");

    await expect(invokeWorkspaceOperation(workspace, {
      operation: "writeFile",
      path: "src/index.ts",
      contents: "next",
    })).resolves.toBeUndefined();
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "listFiles",
      path: "src",
    })).resolves.toEqual(["src/a.ts", "src/b.ts"]);

    const controller = new AbortController();
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "execute",
      command: {
        argv: ["pnpm", "test"],
        cwd: "fixture",
        timeoutMs: 1_000,
        signal: controller.signal,
      },
    })).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "diff",
    })).resolves.toContain("diff --git");
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "snapshot",
    })).resolves.toEqual({
      id: "snapshot-1",
      createdAt: "2026-09-02T00:00:00.000Z",
      metadata: { clean: true, files: 2 },
    });
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "dispose",
    })).resolves.toBeUndefined();
  });

  it("copies caller-owned command input before crossing the capability boundary", async () => {
    let received: CommandRequest | undefined;
    const execute = vi.fn(async (command: CommandRequest) => {
      received = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const workspace = workspaceFixture({ execute });
    const command: CommandRequest = { argv: ["pnpm", "test"] };

    await invokeWorkspaceOperation(workspace, { operation: "execute", command });

    expect(received).not.toBe(command);
    expect(received?.argv).not.toBe(command.argv);
    expect(received?.argv).toEqual(["pnpm", "test"]);
  });

  it("brands and normalizes AbortSignal while preserving cancellation", async () => {
    let received: CommandRequest | undefined;
    const execute = vi.fn(async (command: CommandRequest) => {
      received = command;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const controller = new AbortController();

    await invokeWorkspaceOperation(workspaceFixture({ execute }), {
      operation: "execute",
      command: { argv: ["true"], signal: controller.signal },
    });

    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received?.signal).not.toBe(controller.signal);
    expect(received?.signal?.aborted).toBe(false);
    controller.abort("stop");
    expect(received?.signal?.aborted).toBe(true);
    expect(received?.signal?.reason).toBe("stop");
  });

  it("classifies required, malformed, and unknown operation input", async () => {
    const workspace = workspaceFixture();

    await expect(invokeWorkspaceOperation(workspace, undefined)).rejects.toBeInstanceOf(
      WorkspaceOperationRequiredError,
    );
    await expect(invokeWorkspaceOperation(workspace, [])).rejects.toBeInstanceOf(
      WorkspaceOperationMalformedError,
    );
    await expect(invokeWorkspaceOperation(workspace, {})).rejects.toMatchObject({
      code: "WORKSPACE_OPERATION_REQUIRED",
    });
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "removeEverything",
    })).rejects.toBeInstanceOf(WorkspaceOperationUnknownError);
  });

  it("rejects missing fields, extra fields, accessors, and malformed commands", async () => {
    const workspace = workspaceFixture();
    const accessor = { operation: "readFile" } as Record<string, unknown>;
    Object.defineProperty(accessor, "path", { get: () => "secret" });

    const malformed: unknown[] = [
      { operation: "readFile" },
      { operation: "readFile", path: "a", surprise: true },
      accessor,
      { operation: "writeFile", path: "a" },
      { operation: "execute", command: { argv: [] } },
      { operation: "execute", command: { argv: ["pnpm"], timeoutMs: -1 } },
      { operation: "diff", path: "unexpected" },
    ];

    for (const request of malformed) {
      await expect(invokeWorkspaceOperation(workspace, request)).rejects.toMatchObject({
        code: "WORKSPACE_OPERATION_MALFORMED",
      });
    }
  });

  it("allows empty command arguments after a nonempty program", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    await invokeWorkspaceOperation(workspaceFixture({ execute }), {
      operation: "execute",
      command: { argv: ["printf", ""] },
    });

    expect(execute).toHaveBeenCalledWith({ argv: ["printf", ""] });
  });

  it("turns hostile reflection traps into typed malformed errors", async () => {
    const ownKeysTrap = new Proxy(
      { operation: "readFile", path: "safe.txt" },
      { ownKeys: () => { throw new Error("trap"); } },
    );
    await expect(invokeWorkspaceOperation(workspaceFixture(), ownKeysTrap))
      .rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    const argv = new Proxy(["true"], {
      getOwnPropertyDescriptor(target, property) {
        if (property === "length") throw new Error("trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    await expect(invokeWorkspaceOperation(workspaceFixture(), {
      operation: "execute",
      command: { argv },
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    await expect(invokeWorkspaceOperation(workspaceFixture(), {
      operation: "execute",
      command: { argv: revoked.proxy },
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });
  });

  it("does not invoke an implementation for invalid input or a missing workspace", async () => {
    const readFile = vi.fn(async () => "content");
    const workspace = workspaceFixture({ readFile });

    await expect(invokeWorkspaceOperation(workspace, {
      operation: "readFile",
      path: "",
    })).rejects.toBeInstanceOf(WorkspaceOperationMalformedError);
    expect(readFile).not.toHaveBeenCalled();

    await expect(invokeWorkspaceOperation(undefined, {
      operation: "readFile",
      path: "file.ts",
    })).rejects.toBeInstanceOf(WorkspaceOperationRequiredError);
  });

  it("rejects duck-typed or revoked signals before execute is invoked", async () => {
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const workspace = workspaceFixture({ execute });
    const duckSignal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    };

    await expect(invokeWorkspaceOperation(workspace, {
      operation: "execute",
      command: { argv: ["true"], signal: duckSignal as unknown as AbortSignal },
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    const revoked = Proxy.revocable(new AbortController().signal, {});
    revoked.revoke();
    await expect(invokeWorkspaceOperation(workspace, {
      operation: "execute",
      command: { argv: ["true"], signal: revoked.proxy },
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates implementation results before returning them", async () => {
    await expect(invokeWorkspaceOperation(workspaceFixture({
      readFile: async () => 42 as unknown as string,
    }), {
      operation: "readFile",
      path: "file.ts",
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    const hostilePaths = [123] as unknown as string[] & {
      every: () => boolean;
    };
    Object.defineProperty(hostilePaths, "every", {
      value: () => true,
      enumerable: true,
    });
    await expect(invokeWorkspaceOperation(workspaceFixture({
      listFiles: async () => hostilePaths,
    }), {
      operation: "listFiles",
      path: ".",
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    await expect(invokeWorkspaceOperation(workspaceFixture({
      execute: async () => ({ exitCode: 0, stdout: "ok" }) as never,
    }), {
      operation: "execute",
      command: { argv: ["true"] },
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(invokeWorkspaceOperation(workspaceFixture({
      snapshot: async () => ({
        id: "snapshot-1",
        createdAt: "now",
        metadata: cyclic as never,
      }),
    }), {
      operation: "snapshot",
    })).rejects.toMatchObject({ code: "WORKSPACE_OPERATION_MALFORMED" });
  });

  it("copies prototype-sensitive metadata without mutating global prototypes", async () => {
    const metadata = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      never
    >;
    const result = await invokeWorkspaceOperation(workspaceFixture({
      snapshot: async () => ({
        id: "snapshot-1",
        createdAt: "now",
        metadata,
      }),
    }), { operation: "snapshot" });

    expect(Object.getPrototypeOf(result.metadata)).toBeNull();
    expect(result.metadata?.__proto__).toEqual({ polluted: true });
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("preserves typed errors thrown by an implementation", async () => {
    const error = new WorkspaceOperationUnsupportedError(
      "writeFile",
      "fixture is read-only",
    );
    const workspace = workspaceFixture({
      writeFile: async () => {
        throw error;
      },
    });

    await expect(invokeWorkspaceOperation(workspace, {
      operation: "writeFile",
      path: "file.ts",
      contents: "content",
    })).rejects.toBe(error);
  });
});

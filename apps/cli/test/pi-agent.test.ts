import {
  spawn as nodeSpawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import { describe, expect, it } from "vitest";
import type { TaskManifest } from "@harness/sdk";
import {
  PiAgentError,
  createPiCliAgent,
  type TaskAgentInput,
} from "../src/pi-agent";

const MANIFEST: TaskManifest = {
  id: "bootstrap-0001",
  title: "Bootstrap a repository",
  goal: "Make the requested repository change",
  acceptance: ["The change is complete"],
  allowed_paths: ["packages/**"],
  permissions: {
    "fs.read": "allow",
    "fs.write": "ask",
    network: "deny",
  },
  delivery: { type: "pull_request" },
};

const INPUT: TaskAgentInput = {
  cwd: "/work/harness-platform",
  manifestPath: "tasks/bootstrap-0001.yaml",
  manifest: MANIFEST,
  branch: "tasks/bootstrap-0001",
  prompt: "Complete the manifest and leave the worktree ready for its exit gate.",
  timeoutMs: 12_345,
};

type Spawn = typeof spawnSync;

function processResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  const stdout = overrides.stdout ?? "";
  const stderr = overrides.stderr ?? "";
  return {
    pid: 123,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: 0,
    signal: null,
    ...overrides,
  };
}

function fakeSpawn(
  result:
    | SpawnSyncReturns<string>
    | ((args: unknown[]) => SpawnSyncReturns<string>),
  calls: unknown[][] = [],
): { spawn: Spawn; calls: unknown[][] } {
  const spawn = ((...args: unknown[]) => {
    calls.push(args);
    return typeof result === "function" ? result(args) : result;
  }) as Spawn;
  return { spawn, calls };
}

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function protocolJsonl(...events: unknown[]): string {
  return jsonl(
    { type: "session", version: 3, cwd: INPUT.cwd },
    ...events,
    { type: "agent_settled" },
  );
}

function assistant(
  textBlocks: string[],
  usage: Record<string, number> | undefined,
): Record<string, unknown> {
  return {
    role: "assistant",
    content: textBlocks.flatMap((text, index) =>
      index === 0
        ? [{ type: "text", text }]
        : [
            { type: "thinking", thinking: "not part of final text" },
            { type: "text", text },
          ],
    ),
    ...(usage ? { usage } : {}),
  };
}

function caughtError(run: () => unknown): PiAgentError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PiAgentError);
  return caught as PiAgentError;
}

async function caughtAsyncError(run: () => unknown): Promise<PiAgentError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PiAgentError);
  return caught as PiAgentError;
}

describe("Pi CLI task agent", () => {
  it("uses a fixed offline argv, stdin prompt, and no shell", () => {
    const first = assistant(["first"], { totalTokens: 7 });
    const final = assistant(["all ", "done"], {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
    });
    const stream = jsonl(
      { type: "session", version: 3, cwd: INPUT.cwd },
      { type: "agent_start" },
      { type: "message_end", message: first },
      { type: "tool_execution_start", toolCallId: "one" },
      { type: "turn_end", message: first, toolResults: [] },
      { type: "message_end", message: final },
      { type: "tool_execution_start", toolCallId: "two" },
      { type: "turn_end", message: final, toolResults: [] },
      { type: "agent_end", messages: [first, final], willRetry: false },
      { type: "agent_settled" },
    );
    const fake = fakeSpawn(processResult({ stdout: stream }));

    const result = createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT);

    expect(result).toEqual({
      name: "upstream-pi",
      finalText: "all done",
      modelUsage: {
        totalModelTokens: 21,
        totalToolCalls: 2,
        steps: 2,
      },
    });
    expect(fake.calls).toHaveLength(1);
    const [executable, argv, rawOptions] = fake.calls[0] ?? [];
    const options = rawOptions as Record<string, unknown>;
    expect(executable).toBe("pi");
    expect(argv).toEqual([
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools",
      "read,grep,find,ls,edit,write",
    ]);
    expect(argv).not.toContain(INPUT.prompt);
    expect(options.cwd).toBe(INPUT.cwd);
    expect(options.input).toBe(INPUT.prompt);
    expect(options.encoding).toBe("utf8");
    expect(options.shell).toBe(false);
    expect(options.timeout).toBe(INPUT.timeoutMs);
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
    expect((options.env as NodeJS.ProcessEnv).PI_OFFLINE).toBe("1");
  });

  it("honors an explicitly configured executable", () => {
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl({
          type: "agent_end",
          messages: [],
          willRetry: false,
        }),
      }),
    );

    createPiCliAgent({
      executable: "/opt/bootstrap/bin/pi",
      spawnSync: fake.spawn,
    }).run(INPUT);

    expect(fake.calls[0]?.[0]).toBe("/opt/bootstrap/bin/pi");
  });

  it("falls back to the agent_end messages for final text and usage", () => {
    const final = assistant(["fallback result"], { totalTokens: 13 });
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl({
          type: "agent_end",
          messages: [final],
          willRetry: false,
        }),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "fallback result",
      modelUsage: {
        totalModelTokens: 13,
        totalToolCalls: 0,
        steps: 0,
      },
    });
  });

  it("omits unavailable model usage without rejecting a valid completion", () => {
    const final = assistant(["completed"], undefined);
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl(
          { type: "message_end", message: final },
          { type: "agent_end", messages: [final], willRetry: false },
        ),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "completed",
    });
  });

  it.each([
    [
      "a later assistant message omits usage",
      assistant(["accounted"], { totalTokens: 7 }),
      assistant(["completed"], undefined),
    ],
    [
      "an earlier assistant message omits usage",
      assistant(["unaccounted"], undefined),
      assistant(["completed"], { totalTokens: 7 }),
    ],
    [
      "an assistant message has malformed usage",
      assistant(["accounted"], { totalTokens: 7 }),
      assistant(["completed"], { totalTokens: -1 }),
    ],
    [
      "the aggregate usage overflows",
      assistant(["accounted"], { totalTokens: Number.MAX_SAFE_INTEGER }),
      assistant(["completed"], { totalTokens: 1 }),
    ],
    [
      "usage component fields are partial",
      assistant(["accounted"], { totalTokens: 7 }),
      assistant(["completed"], { input: 1, output: 2 }),
    ],
    [
      "reported total disagrees with its components",
      assistant(["accounted"], { totalTokens: 7 }),
      assistant(["completed"], {
        totalTokens: 99,
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      }),
    ],
    [
      "usage is an all-zero placeholder",
      assistant(["accounted"], { totalTokens: 7 }),
      assistant(["completed"], { totalTokens: 0 }),
    ],
  ])("omits partial model usage when %s", (_label, first, final) => {
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl(
          { type: "message_end", message: first },
          { type: "message_end", message: final },
          { type: "agent_end", messages: [first, final], willRetry: false },
        ),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "completed",
    });
  });

  it("adds compaction usage exactly once to completed model usage", () => {
    const final = assistant(["compacted completion"], { totalTokens: 8 });
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl(
          {
            type: "compaction_end",
            result: {
              usage: {
                totalTokens: 10,
                input: 4,
                output: 3,
                cacheRead: 2,
                cacheWrite: 1,
              },
            },
          },
          { type: "message_end", message: final },
          { type: "agent_end", messages: [final], willRetry: false },
        ),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "compacted completion",
      modelUsage: {
        totalModelTokens: 18,
        totalToolCalls: 0,
        steps: 0,
      },
    });
  });

  it("omits model usage when compaction usage is malformed", () => {
    const final = assistant(["completed"], { totalTokens: 8 });
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl(
          {
            type: "compaction_end",
            result: { usage: { input: 3, output: 2 } },
          },
          { type: "message_end", message: final },
          { type: "agent_end", messages: [final], willRetry: false },
        ),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "completed",
    });
  });

  it.each([
    [
      "missing session",
      jsonl(
        { type: "agent_end", messages: [], willRetry: false },
        { type: "agent_settled" },
      ),
    ],
    [
      "unsupported session version",
      jsonl(
        { type: "session", version: 4, cwd: INPUT.cwd },
        { type: "agent_end", messages: [], willRetry: false },
        { type: "agent_settled" },
      ),
    ],
    [
      "retrying agent_end without a terminal completion",
      jsonl(
        { type: "session", version: 3, cwd: INPUT.cwd },
        { type: "agent_end", messages: [], willRetry: true },
        { type: "agent_settled" },
      ),
    ],
    [
      "terminal agent_end without agent_settled",
      jsonl(
        { type: "session", version: 3, cwd: INPUT.cwd },
        { type: "agent_end", messages: [], willRetry: false },
      ),
    ],
  ])("rejects %s", (_label, stdout) => {
    const fake = fakeSpawn(processResult({ stdout }));

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
    );
    expect(error.code).toBe("PI_PROTOCOL_ERROR");
  });

  it("accepts a retrying agent_end only when a later terminal end settles", () => {
    const final = assistant(["recovered after retry"], { totalTokens: 4 });
    const fake = fakeSpawn(processResult({
      stdout: protocolJsonl(
        { type: "agent_end", messages: [], willRetry: true },
        { type: "message_end", message: final },
        { type: "agent_end", messages: [final], willRetry: false },
      ),
    }));

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "recovered after retry",
      modelUsage: {
        totalModelTokens: 4,
        totalToolCalls: 0,
        steps: 0,
      },
    });
  });

  it("requires the successful stream to contain agent_end", () => {
    const fake = fakeSpawn(
      processResult({
        stdout: jsonl(
          { type: "session", version: 3, cwd: INPUT.cwd },
          {
            type: "message_end",
            message: assistant(["not complete"], { totalTokens: 1 }),
          },
        ),
      }),
    );

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
    );
    expect(error.code).toBe("PI_PROTOCOL_ERROR");
  });

  it.each([
    ["message_end", "error"],
    ["turn_end", "aborted"],
  ] as const)(
    "rejects terminal %s evidence with stopReason %s despite exit zero",
    (source, stopReason) => {
      const failed = {
        ...assistant(["request failed"], { totalTokens: 2 }),
        stopReason,
        errorMessage: "provider terminal failure",
      };
      const terminalEvent = source === "message_end"
        ? { type: "message_end", message: failed }
        : { type: "turn_end", message: failed, toolResults: [] };
      const fake = fakeSpawn(
        processResult({
          stdout: protocolJsonl(
            terminalEvent,
            { type: "agent_end", messages: [], willRetry: false },
          ),
        }),
      );

      const error = caughtError(() =>
        createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
      );
      expect(error.code).toBe("PI_PROTOCOL_ERROR");
      expect(error.message).toContain(stopReason);
      expect(error.message).toContain("provider terminal failure");
    },
  );

  it.each(["documented terminal error", ""])(
    "rejects a terminal agent_end assistant errorMessage field %j",
    (errorMessage) => {
      const failed = {
        ...assistant(["apparently complete"], { totalTokens: 3 }),
        stopReason: "stop",
        errorMessage,
      };
      const fake = fakeSpawn(
        processResult({
          stdout: protocolJsonl({
            type: "agent_end",
            messages: [failed],
            willRetry: false,
          }),
        }),
      );

      const error = caughtError(() =>
        createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
      );
      expect(error.code).toBe("PI_PROTOCOL_ERROR");
      if (errorMessage) expect(error.message).toContain(errorMessage);
    },
  );

  it("allows a later successful retry to supersede earlier error evidence", () => {
    const failed = {
      ...assistant(["first attempt"], { totalTokens: 2 }),
      stopReason: "error",
      errorMessage: "transient provider error",
    };
    const recovered = {
      ...assistant(["recovered"], { totalTokens: 5 }),
      stopReason: "future-success-reason",
    };
    const fake = fakeSpawn(
      processResult({
        stdout: protocolJsonl(
          { type: "message_end", message: failed },
          { type: "turn_end", message: failed, toolResults: [] },
          { type: "message_end", message: recovered },
          { type: "turn_end", message: recovered, toolResults: [] },
          {
            type: "agent_end",
            messages: [failed, recovered],
            willRetry: false,
          },
        ),
      }),
    );

    expect(createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT)).toEqual({
      name: "upstream-pi",
      finalText: "recovered",
      modelUsage: {
        totalModelTokens: 7,
        totalToolCalls: 0,
        steps: 2,
      },
    });
  });

  it.each([
    ["not JSON", "PI_INVALID_JSONL"],
    [JSON.stringify(["not", "an", "event"]), "PI_INVALID_JSONL"],
    [JSON.stringify({ value: "missing type" }), "PI_INVALID_JSONL"],
  ] as const)("rejects malformed JSONL event %j", (badLine, code) => {
    const fake = fakeSpawn(
      processResult({
        stdout: `${badLine}\n${protocolJsonl({
          type: "agent_end",
          messages: [],
          willRetry: false,
        })}`,
      }),
    );

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
    );
    expect(error.code).toBe(code);
  });

  it("reports a non-zero exit before attempting to parse its stdout", () => {
    const fake = fakeSpawn(
      processResult({
        status: 9,
        stdout: "not JSON",
        stderr: "model unavailable",
      }),
    );

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
    );
    expect(error.code).toBe("PI_PROCESS_FAILED");
    expect(error.message).toContain("exit 9");
    expect(error.message).toContain("model unavailable");
  });

  it.each([
    ["ETIMEDOUT", "PI_TIMED_OUT"],
    ["ENOBUFS", "PI_OUTPUT_TOO_LARGE"],
    ["ENOENT", "PI_SPAWN_FAILED"],
  ] as const)("maps process error %s to %s", (processCode, agentCode) => {
    const processError = Object.assign(new Error(processCode), {
      code: processCode,
    });
    const fake = fakeSpawn(
      processResult({
        error: processError,
        status: null,
      }),
    );

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: fake.spawn }).run(INPUT),
    );
    expect(error.code).toBe(agentCode);
  });

  it("maps a synchronous process-launch exception to a typed spawn error", () => {
    const spawn = (() => {
      throw new Error("cannot launch");
    }) as Spawn;

    const error = caughtError(() =>
      createPiCliAgent({ spawnSync: spawn }).run(INPUT),
    );
    expect(error.code).toBe("PI_SPAWN_FAILED");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("terminates the real streaming path as soon as token usage exceeds budget", async () => {
    const overBudget = jsonl({
      type: "message_end",
      message: assistant(["too expensive"], { totalTokens: 6 }),
    });
    const script = [
      `process.stdout.write(${JSON.stringify(overBudget)})`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const spawn = ((_executable: string, _args: readonly string[], options: object) =>
      nodeSpawn(process.execPath, ["-e", script], options)) as typeof nodeSpawn;
    const error = await caughtAsyncError(() => createPiCliAgent({ spawn }).run({
      ...INPUT,
      cwd: process.cwd(),
      timeoutMs: 5_000,
      budget: { max_model_tokens: 5 },
    }));

    expect(error.code).toBe("PI_BUDGET_EXCEEDED");
    expect(error.budget).toEqual({ metric: "tokens", used: 6, limit: 5 });
  });

  it("terminates streaming when compaction usage crosses the token budget", async () => {
    const stream = jsonl(
      {
        type: "message_end",
        message: assistant(["first"], { totalTokens: 4 }),
      },
      {
        type: "compaction_end",
        result: { usage: { totalTokens: 3 } },
      },
    );
    const script = [
      `process.stdout.write(${JSON.stringify(stream)})`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const spawn = ((_executable: string, _args: readonly string[], options: object) =>
      nodeSpawn(process.execPath, ["-e", script], options)) as typeof nodeSpawn;
    const error = await caughtAsyncError(() => createPiCliAgent({ spawn }).run({
      ...INPUT,
      cwd: process.cwd(),
      timeoutMs: 5_000,
      budget: { max_model_tokens: 6 },
    }));

    expect(error.code).toBe("PI_BUDGET_EXCEEDED");
    expect(error.budget).toEqual({ metric: "tokens", used: 7, limit: 6 });
  });
});

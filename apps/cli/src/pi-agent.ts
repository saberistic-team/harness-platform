import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns,
} from "node:child_process";
import type { RunReport, TaskManifest } from "@harness/sdk";

/** Input shared by bootstrap-agent implementations. */
export interface TaskAgentInput {
  cwd: string;
  manifestPath: string;
  manifest: TaskManifest;
  branch: string;
  prompt: string;
  timeoutMs: number;
  budget?: TaskManifest["budget"];
}

export interface TaskAgentResult {
  name: string;
  finalText?: string;
  modelUsage?: NonNullable<RunReport["modelUsage"]>;
}

/**
 * Narrow execution seam used by the bootstrap flow. Implementations may run
 * synchronously; callers can still safely `await` the result.
 */
export interface TaskAgent {
  run(input: TaskAgentInput): TaskAgentResult | Promise<TaskAgentResult>;
}

export type PiAgentErrorCode =
  | "PI_SPAWN_FAILED"
  | "PI_TIMED_OUT"
  | "PI_OUTPUT_TOO_LARGE"
  | "PI_PROCESS_FAILED"
  | "PI_INVALID_JSONL"
  | "PI_PROTOCOL_ERROR"
  | "PI_BUDGET_EXCEEDED"
  | "PI_BUDGET_USAGE_UNAVAILABLE";

export interface PiBudgetFailure {
  metric: "tokens" | "tool_calls";
  used: number;
  limit: number;
}

interface PiAgentErrorOptions extends ErrorOptions {
  budget?: PiBudgetFailure;
}

/** A stable, machine-readable failure from the Pi process adapter. */
export class PiAgentError extends Error {
  constructor(
    readonly code: PiAgentErrorCode,
    message: string,
    options?: PiAgentErrorOptions,
  ) {
    super(message, options);
    this.name = "PiAgentError";
    this.budget = options?.budget;
  }

  readonly budget?: PiBudgetFailure;
}

export interface PiCliAgentOptions {
  executable?: string;
  spawn?: typeof nodeSpawn;
  /** Synchronous compatibility seam used by deterministic protocol tests. */
  spawnSync?: typeof nodeSpawnSync;
}

const PI_AGENT_NAME = "upstream-pi";
const SUPPORTED_PI_PROTOCOL_VERSION = 3;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;

const PI_ARGV = [
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
] as const;

interface MessageSummary {
  sawAssistant: boolean;
  lastText?: string;
  terminalFailure?: TerminalAssistantFailure;
  sawUsage: boolean;
  usageComplete: boolean;
  totalTokens: number;
}

interface TerminalAssistantFailure {
  stopReason?: "error" | "aborted";
  errorMessage?: string;
}

interface ParsedPiOutput {
  finalText?: string;
  modelUsage?: NonNullable<RunReport["modelUsage"]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function messageText(message: Record<string, unknown>): string | undefined {
  if (!Array.isArray(message.content)) return undefined;

  const textBlocks: string[] = [];
  let sawTextBlock = false;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    sawTextBlock = true;
    textBlocks.push(block.text);
  }
  return sawTextBlock ? textBlocks.join("") : undefined;
}

function usageTokensFromUsage(usage: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;

  const hasReportedTotal = Object.hasOwn(usage, "totalTokens");
  const reportedTotal = safeNonnegativeInteger(usage.totalTokens);
  if (hasReportedTotal && reportedTotal === undefined) return undefined;

  // Pi's four component fields are non-overlapping. A component-form usage
  // record is only evidence when it is complete; treating a missing field as
  // zero would silently undercount a budgeted run.
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const presentComponents = fields.filter((field) =>
    Object.hasOwn(usage, field)
  );
  if (presentComponents.length !== 0 && presentComponents.length !== fields.length) {
    return undefined;
  }

  let total = 0;
  if (presentComponents.length === fields.length) {
    for (const field of fields) {
      const value = safeNonnegativeInteger(usage[field]);
      if (value === undefined || value > Number.MAX_SAFE_INTEGER - total) {
        return undefined;
      }
      total += value;
    }
    if (reportedTotal !== undefined && reportedTotal !== total) return undefined;
  }

  const result = reportedTotal ??
    (presentComponents.length === fields.length ? total : undefined);
  // A completed assistant/compaction operation cannot consume zero tokens.
  // Rejecting an all-zero record keeps forged placeholders out of evidence.
  return result === undefined || result === 0 ? undefined : result;
}

function usageTokens(message: Record<string, unknown>): number | undefined {
  return usageTokensFromUsage(message.usage);
}

function terminalAssistantFailure(
  message: Record<string, unknown>,
): TerminalAssistantFailure | undefined {
  const stopReason = message.stopReason === "error" || message.stopReason === "aborted"
    ? message.stopReason
    : undefined;
  const errorMessage = typeof message.errorMessage === "string"
    ? message.errorMessage
    : undefined;
  if (stopReason === undefined && errorMessage === undefined) return undefined;
  return {
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function addAssistantMessage(summary: MessageSummary, value: unknown): void {
  if (!isRecord(value) || value.role !== "assistant") return;

  summary.sawAssistant = true;
  summary.lastText = messageText(value);
  // Each source summary retains only its final assistant message. This allows
  // a later successful retry to supersede an earlier provider failure while
  // still rejecting terminal error/abort evidence.
  summary.terminalFailure = terminalAssistantFailure(value);

  const tokens = usageTokens(value);
  if (tokens === undefined) {
    summary.usageComplete = false;
    return;
  }
  if (!summary.usageComplete) return;
  if (tokens > Number.MAX_SAFE_INTEGER - summary.totalTokens) {
    summary.usageComplete = false;
    return;
  }
  summary.sawUsage = true;
  summary.totalTokens += tokens;
}

function emptyMessageSummary(): MessageSummary {
  return {
    sawAssistant: false,
    sawUsage: false,
    usageComplete: true,
    totalTokens: 0,
  };
}

function addUsageRecord(summary: MessageSummary, usage: unknown): void {
  const tokens = usageTokensFromUsage(usage);
  if (tokens === undefined) {
    summary.usageComplete = false;
    return;
  }
  if (!summary.usageComplete) return;
  if (tokens > Number.MAX_SAFE_INTEGER - summary.totalTokens) {
    summary.usageComplete = false;
    return;
  }
  summary.sawUsage = true;
  summary.totalTokens += tokens;
}

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  return value ? value.toString("utf8") : "";
}

function diagnosticTail(value: string): string {
  const cleaned = value.replaceAll("\0", "").trim();
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return cleaned;
  return `…${bytes.subarray(bytes.byteLength - MAX_DIAGNOSTIC_BYTES).toString("utf8")}`;
}

function parsePiJsonl(stdout: string): ParsedPiOutput {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    throw new PiAgentError(
      "PI_OUTPUT_TOO_LARGE",
      `Pi JSON output exceeded ${MAX_OUTPUT_BYTES} bytes`,
    );
  }

  const messageEnds = emptyMessageSummary();
  const turnEnds = emptyMessageSummary();
  const agentEndMessages = emptyMessageSummary();
  const compactions = emptyMessageSummary();
  let sawSession = false;
  let sawTerminalAgentEnd = false;
  let sawAgentSettled = false;
  let steps = 0;
  let totalToolCalls = 0;
  let eventCount = 0;

  const lines = stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      throw new PiAgentError(
        "PI_OUTPUT_TOO_LARGE",
        `Pi JSON event on line ${index + 1} exceeded ${MAX_JSONL_LINE_BYTES} bytes`,
      );
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      throw new PiAgentError(
        "PI_INVALID_JSONL",
        `Pi emitted invalid JSON on line ${index + 1}`,
        { cause },
      );
    }

    if (!isRecord(event) || typeof event.type !== "string") {
      throw new PiAgentError(
        "PI_INVALID_JSONL",
        `Pi emitted a non-event JSON value on line ${index + 1}`,
      );
    }

    eventCount += 1;
    if (!sawSession && event.type !== "session") {
      throw new PiAgentError(
        "PI_PROTOCOL_ERROR",
        "Pi protocol v3 stream did not begin with a session event",
      );
    }

    switch (event.type) {
      case "session":
        if (sawSession || eventCount !== 1) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted a duplicate or out-of-order session event",
          );
        }
        if (event.version !== SUPPORTED_PI_PROTOCOL_VERSION) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            `Unsupported Pi JSON protocol version ${JSON.stringify(event.version)}; expected ${SUPPORTED_PI_PROTOCOL_VERSION}`,
          );
        }
        sawSession = true;
        break;
      case "message_end":
        if (sawTerminalAgentEnd) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted message_end after its terminal agent_end",
          );
        }
        addAssistantMessage(messageEnds, event.message);
        break;
      case "turn_end":
        if (sawTerminalAgentEnd) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted turn_end after its terminal agent_end",
          );
        }
        if (steps < Number.MAX_SAFE_INTEGER) steps += 1;
        addAssistantMessage(turnEnds, event.message);
        break;
      case "tool_execution_start":
        if (sawTerminalAgentEnd) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted tool execution after its terminal agent_end",
          );
        }
        if (totalToolCalls < Number.MAX_SAFE_INTEGER) totalToolCalls += 1;
        break;
      case "compaction_end":
        if (sawTerminalAgentEnd) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted compaction_end after its terminal agent_end",
          );
        }
        if (!isRecord(event.result)) {
          compactions.usageComplete = false;
          break;
        }
        addUsageRecord(compactions, event.result.usage);
        break;
      case "agent_end":
        if (!Array.isArray(event.messages) || typeof event.willRetry !== "boolean") {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi agent_end must include messages and a boolean willRetry field",
          );
        }
        if (sawTerminalAgentEnd) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted more than one terminal agent_end event",
          );
        }
        if (event.willRetry) break;
        sawTerminalAgentEnd = true;
        for (const message of event.messages) {
          addAssistantMessage(agentEndMessages, message);
        }
        break;
      case "agent_settled":
        if (!sawTerminalAgentEnd || sawAgentSettled) {
          throw new PiAgentError(
            "PI_PROTOCOL_ERROR",
            "Pi emitted an out-of-order or duplicate agent_settled event",
          );
        }
        sawAgentSettled = true;
        break;
      default:
        // Pi adds event variants over time. Unknown well-formed events do not
        // invalidate the completion protocol.
        break;
    }
  }

  if (!sawTerminalAgentEnd) {
    throw new PiAgentError(
      "PI_PROTOCOL_ERROR",
      "Pi exited successfully without a terminal agent_end event",
    );
  }
  if (!sawAgentSettled) {
    throw new PiAgentError(
      "PI_PROTOCOL_ERROR",
      "Pi exited successfully without agent_settled after agent_end",
    );
  }

  const terminalFailure = [messageEnds, turnEnds, agentEndMessages].find(
    (summary) => summary.sawAssistant && summary.terminalFailure !== undefined,
  )?.terminalFailure;
  if (terminalFailure) {
    const reason = terminalFailure.stopReason
      ? ` with stopReason ${JSON.stringify(terminalFailure.stopReason)}`
      : "";
    const detail = terminalFailure.errorMessage
      ? `: ${diagnosticTail(terminalFailure.errorMessage)}`
      : "";
    throw new PiAgentError(
      "PI_PROTOCOL_ERROR",
      `Pi ended with a failed assistant message${reason}${detail}`,
    );
  }

  const textSummary = messageEnds.sawAssistant
    ? messageEnds
    : turnEnds.sawAssistant
      ? turnEnds
      : agentEndMessages;
  const usageSummary = [messageEnds, turnEnds, agentEndMessages].find(
    (summary) =>
      summary.sawAssistant && summary.sawUsage && summary.usageComplete,
  );
  const allObservedUsageComplete = [messageEnds, turnEnds, agentEndMessages]
    .every((summary) => !summary.sawAssistant || summary.usageComplete);

  const parsed: ParsedPiOutput = {};
  if (textSummary.lastText !== undefined) {
    parsed.finalText = textSummary.lastText;
  }
  if (usageSummary && allObservedUsageComplete && compactions.usageComplete) {
    const totalModelTokens = usageSummary.totalTokens + compactions.totalTokens;
    if (!Number.isSafeInteger(totalModelTokens)) return parsed;
    parsed.modelUsage = {
      totalModelTokens,
      totalToolCalls,
      steps,
    };
  }
  return parsed;
}

function processErrorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function checkedOutput(
  proc: SpawnSyncReturns<string>,
): { stdout: string; stderr: string } {
  const stdout = outputText(proc.stdout);
  const stderr = outputText(proc.stderr);
  if (
    Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES ||
    Buffer.byteLength(stderr, "utf8") > MAX_OUTPUT_BYTES
  ) {
    throw new PiAgentError(
      "PI_OUTPUT_TOO_LARGE",
      `Pi process output exceeded ${MAX_OUTPUT_BYTES} bytes`,
    );
  }
  return { stdout, stderr };
}

interface StreamingBudgetState {
  tokens: number;
  toolCalls: number;
}

function inspectStreamingBudgetLine(
  line: string,
  state: StreamingBudgetState,
  budget: TaskManifest["budget"],
): PiAgentError | undefined {
  if (!budget || line.trim().length === 0) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch (cause) {
    return new PiAgentError(
      "PI_INVALID_JSONL",
      "Pi emitted invalid JSON while budget enforcement was active",
      { cause },
    );
  }
  if (!isRecord(event) || typeof event.type !== "string") {
    return new PiAgentError(
      "PI_INVALID_JSONL",
      "Pi emitted a non-event value while budget enforcement was active",
    );
  }

  if (event.type === "tool_execution_start" && budget.max_tool_calls !== undefined) {
    state.toolCalls += 1;
    if (state.toolCalls > budget.max_tool_calls) {
      return new PiAgentError(
        "PI_BUDGET_EXCEEDED",
        `Pi exceeded the tool-call budget (${state.toolCalls}/${budget.max_tool_calls})`,
        {
          budget: {
            metric: "tool_calls",
            used: state.toolCalls,
            limit: budget.max_tool_calls,
          },
        },
      );
    }
  }

  if (
    (event.type === "message_end" || event.type === "compaction_end") &&
    budget.max_model_tokens !== undefined
  ) {
    const tokens = event.type === "message_end"
      ? isRecord(event.message) && event.message.role === "assistant"
        ? usageTokens(event.message)
        : undefined
      : isRecord(event.result)
        ? usageTokensFromUsage(event.result.usage)
        : undefined;
    if (event.type === "message_end" && isRecord(event.message) && event.message.role !== "assistant") {
      return undefined;
    }
    if (
      tokens === undefined ||
      tokens > Number.MAX_SAFE_INTEGER - state.tokens
    ) {
      return new PiAgentError(
        "PI_BUDGET_USAGE_UNAVAILABLE",
        "Pi omitted or malformed usage while a model-token budget was active",
      );
    }
    state.tokens += tokens;
    if (state.tokens > budget.max_model_tokens) {
      return new PiAgentError(
        "PI_BUDGET_EXCEEDED",
        `Pi exceeded the model-token budget (${state.tokens}/${budget.max_model_tokens})`,
        {
          budget: {
            metric: "tokens",
            used: state.tokens,
            limit: budget.max_model_tokens,
          },
        },
      );
    }
  }
  return undefined;
}

function runPiSync(
  executable: string,
  spawn: typeof nodeSpawnSync,
  input: TaskAgentInput,
): TaskAgentResult {
  let proc: SpawnSyncReturns<string>;
  try {
    proc = spawn(executable, [...PI_ARGV], {
      cwd: input.cwd,
      input: input.prompt,
      encoding: "utf8",
      env: { ...process.env, PI_OFFLINE: "1" },
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      timeout: input.timeoutMs,
    });
  } catch (cause) {
    throw new PiAgentError(
      "PI_SPAWN_FAILED",
      `Unable to start Pi executable ${JSON.stringify(executable)}`,
      { cause },
    );
  }

  if (proc.error) {
    const code = processErrorCode(proc.error);
    if (code === "ETIMEDOUT") {
      throw new PiAgentError(
        "PI_TIMED_OUT",
        `Pi exceeded its ${input.timeoutMs} ms timeout`,
        { cause: proc.error },
      );
    }
    if (code === "ENOBUFS") {
      throw new PiAgentError(
        "PI_OUTPUT_TOO_LARGE",
        `Pi process output exceeded ${MAX_OUTPUT_BYTES} bytes`,
        { cause: proc.error },
      );
    }
    throw new PiAgentError(
      "PI_SPAWN_FAILED",
      `Unable to run Pi executable ${JSON.stringify(executable)}`,
      { cause: proc.error },
    );
  }

  const { stdout, stderr } = checkedOutput(proc);
  if (proc.status !== 0) {
    const status = proc.status === null ? "no exit status" : `exit ${proc.status}`;
    const signal = proc.signal ? `, signal ${proc.signal}` : "";
    const detail = diagnosticTail(stderr);
    throw new PiAgentError(
      "PI_PROCESS_FAILED",
      `Pi failed (${status}${signal})${detail ? `: ${detail}` : ""}`,
    );
  }

  const parsed = parsePiJsonl(stdout);
  const result: TaskAgentResult = { name: PI_AGENT_NAME };
  if (parsed.finalText !== undefined) result.finalText = parsed.finalText;
  if (parsed.modelUsage !== undefined) result.modelUsage = parsed.modelUsage;
  return result;
}

function runPiStreaming(
  executable: string,
  spawn: typeof nodeSpawn,
  input: TaskAgentInput,
): Promise<TaskAgentResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...PI_ARGV], {
        cwd: input.cwd,
        env: { ...process.env, PI_OFFLINE: "1" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (cause) {
      reject(new PiAgentError(
        "PI_SPAWN_FAILED",
        `Unable to start Pi executable ${JSON.stringify(executable)}`,
        { cause },
      ));
      return;
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const budgetState: StreamingBudgetState = { tokens: 0, toolCalls: 0 };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingLine = "";
    let fatal: PiAgentError | undefined;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const stop = (error: PiAgentError) => {
      if (fatal || settled) return;
      fatal = error;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref?.();
    };
    const finishReject = (error: PiAgentError) => {
      if (settled) return;
      settled = true;
      if (forceKill) clearTimeout(forceKill);
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      stop(new PiAgentError(
        "PI_TIMED_OUT",
        `Pi exceeded its ${input.timeoutMs} ms timeout`,
      ));
    }, input.timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (fatal) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stop(new PiAgentError(
          "PI_OUTPUT_TOO_LARGE",
          `Pi process output exceeded ${MAX_OUTPUT_BYTES} bytes`,
        ));
        return;
      }
      stdout.push(chunk);
      pendingLine += chunk;
      let newline = pendingLine.indexOf("\n");
      while (newline >= 0) {
        const line = pendingLine.slice(0, newline);
        pendingLine = pendingLine.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
          stop(new PiAgentError(
            "PI_OUTPUT_TOO_LARGE",
            `Pi JSON event exceeded ${MAX_JSONL_LINE_BYTES} bytes`,
          ));
          return;
        }
        const budgetError = inspectStreamingBudgetLine(
          line,
          budgetState,
          input.budget,
        );
        if (budgetError) {
          stop(budgetError);
          return;
        }
        newline = pendingLine.indexOf("\n");
      }
      if (Buffer.byteLength(pendingLine, "utf8") > MAX_JSONL_LINE_BYTES) {
        stop(new PiAgentError(
          "PI_OUTPUT_TOO_LARGE",
          `Pi JSON event exceeded ${MAX_JSONL_LINE_BYTES} bytes`,
        ));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (fatal) return;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        stop(new PiAgentError(
          "PI_OUTPUT_TOO_LARGE",
          `Pi process output exceeded ${MAX_OUTPUT_BYTES} bytes`,
        ));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      finishReject(new PiAgentError(
        "PI_SPAWN_FAILED",
        `Unable to run Pi executable ${JSON.stringify(executable)}`,
        { cause },
      ));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (fatal) {
        finishReject(fatal);
        return;
      }
      if (pendingLine.trim().length > 0) {
        const budgetError = inspectStreamingBudgetLine(
          pendingLine,
          budgetState,
          input.budget,
        );
        if (budgetError) {
          finishReject(budgetError);
          return;
        }
      }
      if (code !== 0) {
        const status = code === null ? "no exit status" : `exit ${code}`;
        const signalText = signal ? `, signal ${signal}` : "";
        const detail = diagnosticTail(stderr.join(""));
        finishReject(new PiAgentError(
          "PI_PROCESS_FAILED",
          `Pi failed (${status}${signalText})${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      try {
        const parsed = parsePiJsonl(stdout.join(""));
        const result: TaskAgentResult = { name: PI_AGENT_NAME };
        if (parsed.finalText !== undefined) result.finalText = parsed.finalText;
        if (parsed.modelUsage !== undefined) result.modelUsage = parsed.modelUsage;
        settled = true;
        if (forceKill) clearTimeout(forceKill);
        clearTimeout(timeout);
        resolve(result);
      } catch (error) {
        finishReject(error instanceof PiAgentError
          ? error
          : new PiAgentError("PI_PROTOCOL_ERROR", String(error)));
      }
    });

    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE") {
        stop(new PiAgentError(
          "PI_PROCESS_FAILED",
          `Unable to send the task prompt to Pi: ${cause.message}`,
          { cause },
        ));
      }
    });
    child.stdin.end(input.prompt);
  });
}

/**
 * Create an offline, non-interactive adapter for the upstream Pi CLI.
 *
 * The bootstrap prompt is supplied through stdin, never interpolated into a
 * shell command. Resource loading and approval surfaces are disabled so the
 * checked-in agent guidance and the validated manifest remain the task
 * contract for this lane.
 */
export function createPiCliAgent(
  options: PiCliAgentOptions = {},
): TaskAgent {
  const executable = options.executable ?? "pi";
  return {
    run(input): TaskAgentResult | Promise<TaskAgentResult> {
      if (options.spawnSync) {
        return runPiSync(executable, options.spawnSync, input);
      }
      return runPiStreaming(executable, options.spawn ?? nodeSpawn, input);
    },
  };
}

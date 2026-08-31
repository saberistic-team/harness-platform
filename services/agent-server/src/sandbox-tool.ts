import type { AnyHarnessEvent } from "@harness/events";
import type { Decision } from "@harness/policy";
import {
  argvToPolicySubject,
  runSandbox,
  type CommandExecutor,
  type EnforcedDecision,
} from "@harness/sandbox-runner";
import type { TaskManifest } from "@harness/sdk";
import { createBoundedTool, type Tool } from "@harness/tools";
import { z } from "zod";

export const SANDBOX_EXEC_TOOL = "sandbox_exec";

export interface AgentSandboxOptions {
  image: string;
  trustedLocalImage?: true;
  dockerHost?: string;
  dockerBinary?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Injectable process boundary for deterministic offline integration tests. */
  executor?: CommandExecutor;
}

export interface AgentSandboxToolContext {
  sessionId: string;
  workspace: string;
  manifest: TaskManifest;
  options: AgentSandboxOptions;
  nextRunId(): string;
  resolvePermission(decision: Decision, callId: string): Promise<"allow" | "deny">;
  onDecision(outcome: EnforcedDecision): void;
  onEvent(event: AnyHarnessEvent): void;
}

const sandboxExecParameters = z.object({
  argv: z.array(
    z.string().max(8_192).refine((value) => !value.includes("\0"), {
      message: "arguments cannot contain NUL bytes",
    }),
  ).min(1).max(128),
}).strict();

/** A model-facing process tool whose implementation always crosses Docker. */
export function createAgentSandboxTool(
  context: AgentSandboxToolContext,
): Tool<typeof sandboxExecParameters> {
  return createBoundedTool({
    name: SANDBOX_EXEC_TOOL,
    description: "Run an argv command in the task's policy-enforced Docker sandbox.",
    parameters: sandboxExecParameters,
    inputSchema: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          items: { type: "string", maxLength: 8192 },
        },
      },
      required: ["argv"],
      additionalProperties: false,
    },
    authorization: (params) => ({
      action: "process.exec",
      subject: argvToPolicySubject((params as { argv: string[] }).argv),
      // The runner rechecks this same decision plus fs.read/fs.write/network.
      // A run grant prevents a duplicate prompt at the inner boundary.
      scope: "run",
    }),
    execute: async ({ argv }, execution) => {
      if (!execution?.callId) {
        throw new Error("sandbox execution requires a kernel tool-call context");
      }
      const result = await runSandbox({
        runId: context.nextRunId(),
        workspaceRoot: context.workspace,
        manifest: context.manifest,
        image: context.options.image,
        trustedLocalImage: context.options.trustedLocalImage,
        argv,
      }, {
        executor: context.options.executor,
        dockerHost: context.options.dockerHost,
        dockerBinary: context.options.dockerBinary,
        timeoutMs: context.options.timeoutMs,
        cleanupTimeoutMs: context.options.cleanupTimeoutMs,
        // Keep the JSON tool result comfortably below ACP's frame limit.
        maxOutputBytes: 64 * 1024,
        signal: execution?.signal,
        permissionResolver: (decision) => context.resolvePermission(
          decision,
          execution.callId!,
        ),
        onDecision: context.onDecision,
        onEvent: context.onEvent,
      });
      return {
        runId: result.plan.runId,
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        aborted: result.aborted,
        outputTruncated: result.outputTruncated,
        cleanup: result.cleanup.status,
      };
    },
  }, { kind: "sandbox", root: context.workspace });
}

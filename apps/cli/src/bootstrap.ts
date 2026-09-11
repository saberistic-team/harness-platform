import { createNativeTaskAgent, type NativeAgentOptions } from "./native-agent";
import { createPiCliAgent, type TaskAgent } from "./pi-agent";
import { runTask, type RunArgs, type RunOutcome } from "./run";

export interface BootstrapArgs extends Omit<RunArgs, "builder"> {
  /** Injected by deterministic tests; defaults to the offline native runtime. */
  agent?: TaskAgent;
  native?: NativeAgentOptions;
  piExecutable?: string;
  approveWrite?: boolean;
  agentTimeoutMs?: number;
}

/**
 * Manifest -> exact task branch -> builder -> exit gate -> structured report.
 * The native selector requires an immutable Docker image. Upstream Pi is
 * available only through explicit legacy selection.
 */
export function runBootstrapTask(args: BootstrapArgs): Promise<RunOutcome> {
  const {
    agent,
    native,
    piExecutable,
    approveWrite,
    agentTimeoutMs,
    ...runArgs
  } = args;
  return runTask({
    ...runArgs,
    builder: {
      agent: agent ?? (piExecutable ? createPiCliAgent({ executable: piExecutable }) : createNativeTaskAgent(native ?? {image:process.env.HARNESS_NATIVE_IMAGE ?? ""})),
      name: agent ? "task-agent" : piExecutable ? "upstream-pi" : "minimal-agent-runtime",
      approveWrite,
      timeoutMs: agentTimeoutMs,
    },
  });
}

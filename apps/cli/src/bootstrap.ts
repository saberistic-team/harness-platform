import { createPiCliAgent, type TaskAgent } from "./pi-agent";
import { runTask, type RunArgs, type RunOutcome } from "./run";

export interface BootstrapArgs extends Omit<RunArgs, "builder"> {
  /** Injected by deterministic tests; defaults to the upstream Pi CLI. */
  agent?: TaskAgent;
  piExecutable?: string;
  approveWrite?: boolean;
  agentTimeoutMs?: number;
}

/**
 * Manifest -> exact task branch -> builder -> exit gate -> structured report.
 * The builder seam keeps the default test lane offline while the production
 * command uses upstream Pi without a shell.
 */
export function runBootstrapTask(args: BootstrapArgs): Promise<RunOutcome> {
  const {
    agent,
    piExecutable,
    approveWrite,
    agentTimeoutMs,
    ...runArgs
  } = args;
  return runTask({
    ...runArgs,
    builder: {
      agent: agent ?? createPiCliAgent({ executable: piExecutable }),
      name: agent ? "task-agent" : "upstream-pi",
      approveWrite,
      timeoutMs: agentTimeoutMs,
    },
  });
}

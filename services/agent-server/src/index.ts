/**
 * @harness/agent-server — hosts kernel runs and serves them over ACP.
 *
 * M0: placeholder service. Responsibilities (M3):
 *   - implements packages/acp over JSON-RPC (HTTP + WebSocket)
 *   - each ACP session = one kernel.runAgent loop
 *   - model adapters (packages/models) behind a provider config
 *   - OpenTelemetry traces per session; events are the spans' payload
 */

export interface AgentServerStatus {
  service: "agent-server";
  version: "0.0.0";
  ready: false as const;
}

export function status(): AgentServerStatus {
  return { service: "agent-server", version: "0.0.0", ready: false };
}

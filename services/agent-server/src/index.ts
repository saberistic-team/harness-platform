export * from "./config";
export * from "./connection";
export * from "./server";
export * from "./sandbox-tool";
export * from "./websocket";

export interface AgentServerStatus {
  service: "agent-server";
  version: "0.3.0";
  ready: true;
}

export function status(): AgentServerStatus {
  return { service: "agent-server", version: "0.3.0", ready: true };
}

/**
 * MCP is an adapter boundary, not the harness's internal tool model.
 *
 * M2 provides the shared wire shapes and a live stdio client. Remote
 * transports, tool adaptation, policy mapping, and reconnection belong to
 * later milestones.
 */

export * from "./protocol.js";
export * from "./stdio-client.js";

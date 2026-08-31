# @harness/mcp

The M2 MCP boundary provides:

- validated JSON-RPC request, response, and notification shapes;
- a live subprocess client for MCP's newline-delimited stdio transport;
- the `initialize` / `notifications/initialized` lifecycle;
- `ping`, `tools/list`, and `tools/call` helpers;
- client-side replies to server `ping` requests and typed rejection of
  unsupported server requests;
- typed errors for transport, lifecycle, timeout, protocol, and JSON-RPC
  failures.

It is deliberately an adapter. Harness-native tools, policy decisions, and
audit events remain the internal domain model.

This M2 client targets the initialize-era protocol through revision
`2025-11-25` (with the two preceding initialize-era revisions accepted during
negotiation). It does not claim the stateless discovery lifecycle introduced
by MCP `2026-07-28`; that belongs in a later compatibility adapter.

## Usage

```ts
import { McpStdioClient } from "@harness/mcp";

const client = new McpStdioClient({
  command: "node",
  args: ["path/to/server.mjs"],
});

try {
  const initialized = await client.initialize();
  const { tools } = await client.listTools();
  const result = await client.callTool("echo", { message: "hello" });
} finally {
  await client.close();
}
```

`initialize()` starts the subprocess when needed. `start()` is also exposed
for callers that need to separate process startup from protocol negotiation.
Closing is idempotent.

The child does not inherit arbitrary parent environment variables. Without an
explicit `env`, the client passes only a small launch-safe set such as `PATH`,
temporary-directory variables, locale, and terminal settings. Pass a complete
explicit environment only when a server needs more. Tool descriptions,
annotations, inputs, and outputs are untrusted protocol data; execution still
belongs behind the harness policy boundary.

## Verification lanes

The normal test suite launches only the local fixture server and stays fully
offline:

```sh
pnpm --filter @harness/mcp test
```

The live check installs the committed, integrity-locked dependency graph for
`@modelcontextprotocol/server-everything@2026.8.18`, launches it in a temporary
directory with a deliberately restricted environment, lists its tools, and
calls its read-only `echo` tool:

```sh
pnpm --dir packages/mcp/live install \
  --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --filter @harness/mcp test:live
```

That command needs registry network access. CI runs it only from the separate
scheduled/manual `mcp-live` workflow, never from the default pull-request or
push lane.

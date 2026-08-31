import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  agentServerConfigFromEnvironment,
  modelRegistryFromEnvironment,
} from "./config";
import { startAgentServer } from "./server";

const HELP = `harness-agent-server — ACP WebSocket service

Usage:
  harness-agent-server [--root dir] [--host host] [--port n]

Defaults:
  root  $PWD
  host  127.0.0.1
  port  $HARNESS_AGENT_PORT or 8765

Provider configuration is read only from HARNESS_MODEL_ID,
HARNESS_MODEL_BASE_URL, and server-side OPENAI_API_KEY.

Remote transport:
  HARNESS_AGENT_TOKEN is required for a non-loopback --host.
  HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE=true is also required because this
  service exposes ws:// only. Use a trusted hop behind a TLS reverse proxy.

Sandbox configuration:
  HARNESS_SANDBOX_IMAGE enables sandbox_exec. Optional settings are
  HARNESS_SANDBOX_TRUST_LOCAL_IMAGE=true|false, HARNESS_DOCKER_HOST, and
  HARNESS_DOCKER_BINARY. Any sandbox setting requires HARNESS_SANDBOX_IMAGE.`;

export async function main(argv: string[]): Promise<number> {
  let root = process.cwd();
  let host = "127.0.0.1";
  let port = process.env.HARNESS_AGENT_PORT ? Number(process.env.HARNESS_AGENT_PORT) : 8765;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      return 0;
    }
    if (arg === "--root") root = argv[++i] ?? "";
    else if (arg === "--host") host = argv[++i] ?? "";
    else if (arg === "--port") port = Number(argv[++i]);
    else {
      console.error(`harness-agent-server: unknown option ${arg ?? ""}`);
      return 2;
    }
  }
  if (!root || !host || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("harness-agent-server: invalid root, host, or port");
    return 2;
  }
  const registry = modelRegistryFromEnvironment();
  const environment = agentServerConfigFromEnvironment();
  const server = await startAgentServer({
    ...registry,
    ...environment,
    workspaceRoot: resolve(root),
    host,
    port,
  });
  console.log(`harness-agent-server: ${server.url}`);
  let stopping = false;
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolveStop) => {
    requestStop = resolveStop;
  });
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await stopRequested;
    await server.close();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

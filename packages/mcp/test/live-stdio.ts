import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpClientError, McpStdioClient } from "../src/index.js";

const referenceServer =
  "@modelcontextprotocol/server-everything@2026.8.18";
const serverEntry = fileURLToPath(
  new URL(
    "../live/node_modules/@modelcontextprotocol/server-everything/dist/index.js",
    import.meta.url,
  ),
);
const serverManifest = fileURLToPath(
  new URL(
    "../live/node_modules/@modelcontextprotocol/server-everything/package.json",
    import.meta.url,
  ),
);

function textFromResult(content: Array<{ type: string; [key: string]: unknown }>) {
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

async function main(): Promise<void> {
  await access(serverEntry);
  const installed = JSON.parse(await readFile(serverManifest, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  assert.equal(installed.name, "@modelcontextprotocol/server-everything");
  assert.equal(installed.version, "2026.8.18");

  const scratch = await mkdtemp(join(tmpdir(), "harness-mcp-live-"));
  const client = new McpStdioClient(
    {
      command: process.execPath,
      args: [serverEntry, "stdio"],
      cwd: scratch,
      // The reference server exposes an environment-inspection tool. Give it
      // no host environment, package-manager configuration, or CI secrets.
      env: {
        CI: "true",
        NODE_ENV: "test",
        NO_COLOR: "1",
        HOME: scratch,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        ...(process.platform === "win32" && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
    },
    { requestTimeoutMs: 60_000, closeTimeoutMs: 2_000 },
  );

  try {
    const initialized = await client.initialize();
    const listed = await client.listTools();
    const echo = listed.tools.find((tool) => tool.name === "echo");
    assert.ok(echo, "reference server did not advertise the echo tool");

    const marker = "harness-m2-live";
    const result = await client.callTool(echo.name, { message: marker });
    assert.equal(result.isError, undefined);
    assert.match(textFromResult(result.content), new RegExp(marker));
    await client.ping();

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        package: referenceServer,
        protocolVersion: initialized.protocolVersion,
        server: initialized.serverInfo,
        toolCount: listed.tools.length,
        calledTool: echo.name,
      })}\n`,
    );
  } finally {
    try {
      await client.close();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  const summary =
    error instanceof McpClientError
      ? { name: error.name, code: error.code, message: error.message }
      : {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(`MCP live stdio check failed: ${JSON.stringify(summary)}\n`);
  process.exitCode = 1;
});

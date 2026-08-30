#!/usr/bin/env node
// Thin launcher: run the TS entrypoint with the tsx loader (same
// pattern as apps/cli) so the workspace stays build-free.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const child = spawn(
  process.execPath,
  ["--import", "tsx", app, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);

child.on("error", (err) => {
  console.error(`harness-view: failed to start: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});

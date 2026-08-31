#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", app, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
let stopping = false;
const forwardSignal = (signal) => {
  stopping = true;
  child.kill(signal);
};
const onInterrupt = () => forwardSignal("SIGINT");
const onTerminate = () => forwardSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
child.on("error", (error) => {
  console.error(`harness-control-plane: failed to start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
  process.exit(signal && !stopping ? 1 : (code ?? 0));
});

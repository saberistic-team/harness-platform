import { cwd as processCwd } from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadTaskManifestFile } from "@harness/sdk";
import { runTask } from "./run";

export interface CliOptions {
  cwd?: string;
  out?: (line: string) => void;
}

const HELP = `harness — the exit-gate CLI for the harness platform

Usage:
  harness validate <manifest.yaml>        validate a task manifest
  harness run <manifest.yaml> [options]   run the exit gate
  harness help                            show this help

Run options:
  --branch <name>      branch to record on the report (default: tasks/<id>)
  --test-cmd <cmd>     test command override (default: "pnpm test")
  --timeout-ms <n>     test command timeout (default: 300000)
  --pr-url <url>       pull-request URL to record as the delivery link
                       (default: $HARNESS_PULL_REQUEST_URL when set)
`;

function fail(message: string): never {
  console.error(`harness: ${message}`);
  throw new Error(message);
}

export async function runCli(
  argv: string[],
  opts: CliOptions = {},
): Promise<number> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const cwd = opts.cwd ?? processCwd();
  const [cmd, ...rest] = argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) {
    out(HELP);
    return cmd === undefined ? 1 : 0;
  }

  if (cmd === "validate" && rest[0]) {
    try {
      const manifest = await loadTaskManifestFile(resolve(cwd, rest[0]));
      out(`valid task manifest: ${manifest.id} "${manifest.title}"`);
      out(JSON.stringify(manifest, null, 2));
      return 0;
    } catch (err) {
      if (err instanceof Error && err.name === "ManifestParseError") {
        out(`invalid task manifest: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  if (cmd === "run" && rest[0]) {
    const manifestPath = rest[0];
    let branch: string | undefined;
    let testCommand: string | undefined;
    let timeoutMs: number | undefined;
    let prUrl: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--branch") branch = rest[++i];
      else if (flag === "--test-cmd") testCommand = rest[++i];
      else if (flag === "--timeout-ms") timeoutMs = Number(rest[++i]);
      else if (flag === "--pr-url") prUrl = rest[++i];
      else return fail(`unknown option for run: ${flag}`);
    }
    let outcome;
    try {
      outcome = await runTask({
        cwd,
        manifestPath,
        branch,
        testCommand,
        testTimeoutMs: timeoutMs,
        prUrl,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    out(JSON.stringify(outcome.report, null, 2));
    out(`\nreport: ${outcome.reportPath}`);
    return outcome.exitCode;
  }

  return fail(`unknown command: ${cmd ?? "<none>"} (try "harness help")`);
}

// Auto-run when launched as an executable entrypoint.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

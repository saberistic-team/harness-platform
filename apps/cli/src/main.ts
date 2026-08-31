import { cwd as processCwd } from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadTaskManifestFile } from "@harness/sdk";
import { runBootstrapTask } from "./bootstrap";
import { runTask } from "./run";
import type { GitPreflightContext } from "./git";

export interface CliOptions {
  cwd?: string;
  out?: (line: string) => void;
}

const HELP = `harness — the exit-gate CLI for the harness platform

Usage:
  harness validate <manifest.yaml>        validate a task manifest
  harness run <manifest.yaml> [options]   run the exit gate
  harness bootstrap <manifest.yaml> [options]
                                        run upstream Pi, then the exit gate
  harness help                            show this help

Run options:
  --test-cmd <cmd>     test command override (default: "pnpm test")
  --timeout-ms <n>     test command timeout (default: 300000)
  --base-ref <ref>     local comparison base; required CI base commit
  --ci-head-ref <ref>  CI task branch (must equal tasks/<manifest-id>)
  --head-sha <sha>     CI head commit (must equal checked-out HEAD)
  --pr-url <url>       pull-request URL to record as the delivery link
                       (default: $HARNESS_PULL_REQUEST_URL when set)

Bootstrap-only options:
  --approve-write      resolve a manifest fs.write: ask for this run
  --pi-bin <path>      upstream Pi executable (default: pi)
  --agent-timeout-ms <n>
                       Pi timeout (default: 900000)
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

  if ((cmd === "run" || cmd === "bootstrap") && rest[0]) {
    const manifestPath = rest[0];
    let testCommand: string | undefined;
    let timeoutMs: number | undefined;
    let prUrl: string | undefined;
    let baseRef: string | undefined;
    let ciHeadRef: string | undefined;
    let headSha: string | undefined;
    let approveWrite = false;
    let piExecutable: string | undefined;
    let agentTimeoutMs: number | undefined;
    const value = (index: number, flag: string): string => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return fail(`${flag} requires a value`);
      }
      return next;
    };
    // Preserve even invalid numeric text as NaN/Infinity so the task attempt
    // reaches runTask's typed timeout failure and structured report path.
    const numericValue = (raw: string): number => Number(raw);
    for (let i = 1; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--test-cmd") testCommand = value(i++, flag);
      else if (flag === "--timeout-ms") {
        timeoutMs = numericValue(value(i++, flag));
      } else if (flag === "--pr-url") prUrl = value(i++, flag);
      else if (flag === "--base-ref") baseRef = value(i++, flag);
      else if (flag === "--ci-head-ref") ciHeadRef = value(i++, flag);
      else if (flag === "--head-sha") headSha = value(i++, flag);
      else if (cmd === "bootstrap" && flag === "--approve-write") {
        approveWrite = true;
      } else if (cmd === "bootstrap" && flag === "--pi-bin") {
        piExecutable = value(i++, flag);
      } else if (cmd === "bootstrap" && flag === "--agent-timeout-ms") {
        agentTimeoutMs = numericValue(value(i++, flag));
      } else if (flag === "--branch") {
        return fail(
          "--branch is not trusted metadata; use --ci-head-ref, --head-sha, and --base-ref",
        );
      } else return fail(`unknown option for ${cmd}: ${flag}`);
    }

    const ciRequested = ciHeadRef !== undefined || headSha !== undefined;
    let gitContext: GitPreflightContext;
    if (ciRequested) {
      gitContext = {
        mode: "ci",
        // Keep an incomplete tuple inside Git preflight so the attempt still
        // produces run-preflight-report/v1 instead of throwing in argv parsing.
        headRef: ciHeadRef ?? "",
        headSha: headSha ?? "",
        baseRef: baseRef ?? "",
      };
    } else {
      gitContext = { mode: "local", ...(baseRef ? { baseRef } : {}) };
    }
    let outcome;
    try {
      const common = {
        cwd,
        manifestPath,
        gitContext,
        testCommand,
        testTimeoutMs: timeoutMs,
        prUrl,
      };
      outcome = cmd === "bootstrap"
        ? await runBootstrapTask({
            ...common,
            approveWrite,
            piExecutable,
            agentTimeoutMs,
          })
        : await runTask(common);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    out(JSON.stringify(outcome.report, null, 2));
    out(outcome.reportWritten
      ? `\nreport: ${outcome.reportPath}`
      : `\nreport was not written; intended path: ${outcome.reportPath}`);
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

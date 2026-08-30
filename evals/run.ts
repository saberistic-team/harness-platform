import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  decodeScenario,
  executeScenario,
  ScenarioParseError,
  ScenarioRuntimeError,
  InvariantCheckError,
  type RunContext,
  type ScenarioOutcome,
} from "./runner/index";
import {
  createHarnessTelemetry,
  telemetryFromEnv,
  type HarnessTelemetry,
} from "@harness/otel";

/**
 * Scenario runner CLI (M1).
 *
 *   pnpm exec tsx evals/run.ts                 # run every *.yaml scenario
 *   pnpm exec tsx evals/run.ts <scenario>...   # run specific scenario(s)
 *   ... --report tasks/runs/<run>.json         # also check expect.report
 *
 * Exit code 0 iff every scenario passes. A scenario that fails its
 * invariants is a REAL failure (flaky evals fail CI by design).
 */

interface CliOpts {
  repoRoot: string;
  reportPath?: string;
}

function parseArgs(argv: string[]): { scenarios: string[]; opts: CliOpts } {
  const scenarios: string[] = [];
  const opts: CliOpts = {
    // evals/ is a sibling of tasks/ inside the repo root.
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--report") {
      opts.reportPath = argv[++i];
      if (!opts.reportPath) throw new ScenarioRuntimeError("--report needs a path");
    } else if (a === "--root") {
      opts.repoRoot = argv[++i] ?? process.cwd();
      if (!opts.repoRoot) throw new ScenarioRuntimeError("--root needs a path");
    } else if (a === "-h" || a === "--help") {
      scenarios.push("__help__");
    } else {
      scenarios.push(a);
    }
  }
  return { scenarios, opts };
}

function discoverScenarios(repoRoot: string): string[] {
  const dir = join(repoRoot, "evals", "scenarios");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f).toLowerCase() === ".yaml" || extname(f).toLowerCase() === ".yml")
    .map((f) => join(dir, f))
    .sort();
}

function loadScenario(path: string): import("./runner/scenario").Scenario {
  const text = readFileSync(path, "utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ScenarioParseError([
      { path: "<yaml>", message: `invalid YAML: ${(err as Error).message}` },
    ]);
  }
  return decodeScenario(doc);
}

function taskPathFor(repoRoot: string, id: string): string {
  for (const ext of [".yaml", ".yml"]) {
    const p = join(repoRoot, "tasks", `${id}${ext}`);
    if (existsSync(p)) return p;
  }
  throw new ScenarioRuntimeError(
    `unknown task "${id}" (looked for tasks/${id}.yaml)` +
      " — add the manifest (rule 1: no task without a manifest)",
  );
}

export async function runScenarios(argv: string[]): Promise<number> {
  const { scenarios: requested, opts } = parseArgs(argv);
  if (requested.includes("__help__")) {
    console.log("usage: tsx evals/run.ts [scenario ...] [--report path] [--root dir]");
    return 0;
  }

  const repoRoot = resolve(opts.repoRoot);
  const paths =
    requested.length > 0
      ? requested.map((r) => (r.endsWith(".yaml") || r.endsWith(".yml") ? resolve(r) : join(repoRoot, "evals", "scenarios", `${r}.yaml`)))
      : discoverScenarios(repoRoot);

  if (paths.length === 0) {
    console.error("no scenarios found under evals/scenarios/");
    return 2;
  }

  let failures = 0;
  const outcomes: ScenarioOutcome[] = [];

  // M2 OTel wiring: the golden runs emit the SAME harness events the
  // kernel/CLI do; the bridge turns them into spans so `pnpm evals`
  // lights up the local collector (HARNESS_OTEL=1 / OTEL_* env).
  let telemetry: HarnessTelemetry | undefined;
  const otelOpts = telemetryFromEnv();
  if (otelOpts !== null) {
    try {
      telemetry = await createHarnessTelemetry(otelOpts);
    } catch (err) {
      console.error(
        `otel: telemetry disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const p of paths) {
    const rel = resolve(repoRoot, p);
    const scenario = loadScenario(p);
    const taskPaths = scenario.uses_tasks.map((t) => taskPathFor(repoRoot, t));
    let outcome: ScenarioOutcome;
    try {
      const ctx: RunContext = {
        repoRoot,
        reportPath: opts.reportPath,
        onEvent: telemetry ? (e) => telemetry?.bridge.onEvent(e) : undefined,
      };
      outcome = await executeScenario(ctx, scenario, taskPaths);
    } catch (err) {
      if (err instanceof InvariantCheckError) {
        failures++;
        console.log(`\n\u274c ${scenario.id}  \u2014  invalid invariants`);
        for (const f of err.failures) console.log(`    ${f}`);
        continue;
      }
      if (err instanceof ScenarioRuntimeError || err instanceof ScenarioParseError) {
        failures++;
        console.log(`\n\u274c ${scenario.id}  \u2014  ${err.message}`);
        continue;
      }
      throw err;
    }
    outcomes.push(outcome);
    if (outcome.ok) {
      console.log(
        `\u2705 ${outcome.id}  \u2014  task=${outcome.tasks[0]} ` +
          `status=${outcome.goldenRun.status} steps=${outcome.goldenRun.steps} ` +
          `events=${outcome.goldenRun.eventCount} ` +
          `tokens=${outcome.goldenRun.totalTokens} (${outcome.durationMs}ms)`,
      );
    } else {
      failures++;
      console.log(`\u274c ${outcome.id}  \u2014  task=${outcome.tasks[0]}`);
      for (const f of outcome.failures) console.log(`    ${f}`);
    }
  }

  const passed = outcomes.filter((o) => o.ok).length;
  console.log(`\n${passed}/${outcomes.length} scenarios passed`);

  if (telemetry) {
    try {
      await telemetry.forceFlush();
      await telemetry.shutdown();
      console.log(`otel: exported ${outcomes.length} golden run(s) via ${telemetry.kind} sink`);
    } catch (err) {
      console.error(`otel: shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return failures === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url.endsWith(resolve(entry)) || import.meta.url.endsWith("evals/run.ts")) {
  runScenarios(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

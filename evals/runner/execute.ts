import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnyHarnessEvent } from "@harness/events";
import { runAgent, type RunResult } from "@harness/kernel";
import { FakeModel, type ScriptedTurn } from "@harness/models";
import {
  loadTaskManifestFile,
  validateRunReport,
  type RunReport,
  type TaskManifest,
} from "@harness/sdk";
import { assertKnownEventTypes, InvariantCheckError, streamSatisfies } from "./expect";
import type { RunStatus, Scenario } from "./scenario";

/**
 * The eval executor: runs the GOLDEN KERNEL (packages/kernel +
 * FakeModel) for a scenario and checks the observable invariants.
 *
 * Determinism guarantees (offline, M1):
 *   - scripted model turns (no provider, no clock, no randomness);
 *   - fixed event timestamps and ids;
 *   - budgets come straight from the task manifest, so a run that
 *     leaks budget trips `budget.warning` AND `budget_exceeded` —
 *     the eval then fails on the invariant, loudly.
 */

export interface RunContext {
  /** Repo root: where tasks/ and evals/ live. */
  repoRoot: string;
  /** Optional: the exit-gate run report to check `expect.report` against. */
  reportPath?: string;
  /** M2: observe the golden kernel's live event stream (OTel bridge). */
  onEvent?: (event: import("@harness/events").AnyHarnessEvent) => void;
}

export interface ScenarioOutcome {
  id: string;
  ok: boolean;
  failures: string[];
  /** The task(s) the scenario exercised. */
  tasks: string[];
  durationMs: number;
  /** Summary of the golden run, for the eval record. */
  goldenRun: {
    taskId: string;
    status?: RunStatus;
    steps: number;
    toolCalls: number;
    totalTokens: number;
    eventCount: number;
  };
}

class GoldenRunFailure extends Error {
  constructor(
    readonly failures: readonly string[],
  ) {
    super(`golden run invariants failed: ${failures.join("; ")}`);
    this.name = "GoldenRunFailure";
  }
}

export class ScenarioRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioRuntimeError";
  }
}

function toScriptedTurns(scenario: Scenario): ScriptedTurn[] {
  return scenario.script.map((t) => ({
    content: t.content,
    finishReason: t.finishReason,
    toolCalls: t.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
  }));
}

/** Run the golden kernel for one task named by the scenario. */
async function runGoldenTask(
  ctx: RunContext,
  scenario: Scenario,
  taskPath: string,
): Promise<{ manifest: TaskManifest; result: RunResult; events: AnyHarnessEvent[] }> {
  const manifest: TaskManifest = await loadTaskManifestFile(taskPath);
  const model = new FakeModel(toScriptedTurns(scenario));

  // Deterministic identity: fixed clock, counting ids.
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  let tick = 0;
  let idCount = 0;
  const now = () => new Date(base + tick++).toISOString();
  const newId = (prefix: string) => `${prefix}-golden-${++idCount}`;

  const result = await runAgent({
    goal: manifest.goal,
    model,
    budget: {
      maxModelTokens: manifest.budget?.max_model_tokens,
      maxToolCalls: manifest.budget?.max_tool_calls,
    },
    taskId: manifest.id,
    sessionId: `sess-scenario-${manifest.id}`,
    now,
    newId,
    onEvent: ctx.onEvent,
  });

  return { manifest, result, events: result.events };
}

function lastAgentStopped(events: readonly AnyHarnessEvent[]): AnyHarnessEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "agent.stopped") return e;
  }
  return undefined;
}

function checkRunInvariants(
  scenario: Scenario,
  events: readonly AnyHarnessEvent[],
  result: RunResult,
): string[] {
  const failures: string[] = [];
  const run = scenario.expect.run;
  if (!run) return failures;

  if (run.status) {
    const stopped = lastAgentStopped(events);
    const actual = stopped?.type === "agent.stopped" ? stopped.data.status : "<none>";
    if (actual !== run.status) {
      failures.push(`run.status: wanted "${run.status}", saw "${actual}"`);
    }
  }
  if (run.steps !== undefined && result.steps !== run.steps) {
    failures.push(`run.steps: wanted ${run.steps}, saw ${result.steps}`);
  }
  if (run.toolCalls !== undefined && result.toolCalls !== run.toolCalls) {
    failures.push(`run.toolCalls: wanted ${run.toolCalls}, saw ${result.toolCalls}`);
  }
  if (run.textContains !== undefined && !result.text.includes(run.textContains)) {
    failures.push(
      `run.textContains: final text ${JSON.stringify(result.text)} lacks ${JSON.stringify(run.textContains)}`,
    );
  }
  if (run.emittedBudgetWarning !== undefined) {
    const saw = events.some((e) => e.type === "budget.warning");
    if (saw !== run.emittedBudgetWarning) {
      failures.push(`run.emittedBudgetWarning: wanted ${run.emittedBudgetWarning}, saw ${saw}`);
    }
  }
  return failures;
}

function checkReportInvariants(
  ctx: RunContext,
  scenario: Scenario,
): string[] {
  const want = scenario.expect.report?.status;
  if (!want || !ctx.reportPath) return [];
  const reportPath = resolve(ctx.repoRoot, ctx.reportPath);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (err) {
    throw new ScenarioRuntimeError(
      `scenario expects a run report at ${ctx.reportPath}: ${(err as Error).message}`,
    );
  }
  let report: RunReport;
  try {
    report = validateRunReport(doc);
  } catch (err) {
    throw new ScenarioRuntimeError(
      `run report at ${ctx.reportPath} is invalid: ${(err as Error).message}`,
    );
  }
  return report.status === want
    ? []
    : [`report.status: wanted "${want}", saw "${report.status}"`];
}

/** Execute a scenario against the golden kernel. Throws on hard errors. */
export async function executeScenario(
  ctx: RunContext,
  scenario: Scenario,
  taskPaths: readonly string[],
): Promise<ScenarioOutcome> {
  const t0 = Date.now();
  const invariants = scenario.expect.events ?? [];
  const unknown = assertKnownEventTypes(invariants);
  if (unknown.length > 0) throw new InvariantCheckError(unknown);

  if (taskPaths.length !== 1) {
    throw new ScenarioRuntimeError(
      `M1 scenarios exercise exactly one task, saw ${taskPaths.length}`,
    );
  }
  const { result, events } = await runGoldenTask(ctx, scenario, taskPaths[0]!);

  const failures: string[] = [
    ...checkRunInvariants(scenario, events, result),
    ...streamSatisfies(events, scenario.expect.events ?? []),
    ...checkReportInvariants(ctx, scenario),
  ];

  const stopped = lastAgentStopped(events);
  return {
    id: scenario.id,
    ok: failures.length === 0,
    failures,
    tasks: [scenario.uses_tasks[0]!],
    durationMs: Date.now() - t0,
    goldenRun: {
      taskId: scenario.uses_tasks[0]!,
      status: stopped?.type === "agent.stopped" ? stopped.data.status : undefined,
      steps: result.steps,
      toolCalls: result.toolCalls,
      totalTokens: result.usage.totalTokens,
      eventCount: events.length,
    },
  };
}

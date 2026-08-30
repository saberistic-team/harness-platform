import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadTaskManifestFile,
  validateRunReport,
  type RunReport,
  type TaskManifest,
} from "@harness/sdk";

/**
 * The task board data layer (ROADMAP M2, apps/web v0.1).
 *
 * Read-only view over the two artifacts that already exist on disk:
 *  - task manifests:  <root>/tasks/*.yaml    (validated via @harness/sdk)
 *  - run reports:     <root>/tasks/runs/*.json
 *
 * No real-time, no server state: every call re-reads the filesystem,
 * which is exactly the "pull to refresh" the UI offers. Unknown input
 * is a typed item in the board, never a silent skip (rule 4).
 */

export interface BoardReport {
  reportPath: string;
  task: { id: string; title: string };
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt: string;
  branch: string;
  changedPaths: number;
  violations: number;
  events: number;
  pullRequest?: string;
}

/** A run report that failed schema validation: typed, with the issue. */
export interface InvalidReport {
  reportPath: string;
  issue: string;
}

/** A manifest file that failed schema validation: typed, with issues. */
export interface InvalidManifest {
  manifestPath: string;
  issues: string[];
}

export interface BoardTask {
  manifest: TaskManifest;
  manifestPath: string;
  /** All run reports for this task, newest first. */
  reports: BoardReport[];
}

export interface BoardData {
  root: string;
  generatedAt: string;
  tasks: BoardTask[];
  invalidManifests: InvalidManifest[];
  invalidReports: InvalidReport[];
}

function toBoardReport(report: RunReport): BoardReport {
  return {
    reportPath: report.deliverables.reportPath,
    task: { id: report.task.id, title: report.task.title },
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    branch: report.branch,
    changedPaths: report.policy.changedPaths.length,
    violations: report.policy.violations.length,
    events: report.events.length,
    pullRequest: report.deliverables.pullRequest,
  };
}

/** Read the board state for one repo root (pure, offline, read-only). */
export async function readBoard(
  root: string,
  now: () => string = () => new Date().toISOString(),
): Promise<BoardData> {
  const absRoot = resolve(root);
  const tasksDir = join(absRoot, "tasks");
  const runsDir = join(tasksDir, "runs");

  const manifestFiles = existsSync(tasksDir)
    ? readdirSync(tasksDir, { withFileTypes: true })
        .filter(
          (e) =>
            e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")),
        )
        .map((e) => join(tasksDir, e.name))
        .sort()
    : [];

  const runFiles = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(runsDir, f))
        .sort()
    : [];

  // Validate every report first; invalid ones are typed items, never
  // skipped. Valid ones are grouped by the task id they carry.
  const invalidReports: InvalidReport[] = [];
  const reportsByTask = new Map<string, BoardReport[]>();
  for (const path of runFiles) {
    try {
      const report = validateRunReport(
        JSON.parse(readFileSync(path, "utf8")),
      );
      const list = reportsByTask.get(report.task.id) ?? [];
      list.push(toBoardReport(report));
      reportsByTask.set(report.task.id, list);
    } catch (err) {
      invalidReports.push({
        reportPath: path,
        issue: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Newest first inside each task (finishedAt is ISO-8601 => sortable).
  for (const list of reportsByTask.values()) {
    list.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  }

  const tasks: BoardTask[] = [];
  const invalidManifests: InvalidManifest[] = [];
  for (const path of manifestFiles) {
    let manifest: TaskManifest;
    try {
      manifest = await loadTaskManifestFile(path);
      tasks.push({
        manifest,
        manifestPath: path,
        reports: reportsByTask.get(manifest.id) ?? [],
      });
    } catch (err) {
      if (
        err instanceof Error &&
        "issues" in err &&
        Array.isArray((err as { issues: unknown }).issues)
      ) {
        invalidManifests.push({
          manifestPath: path,
          issues: (err as { issues: { message: string }[] }).issues.map(
            (i) => i.message,
          ),
        });
      } else {
        invalidManifests.push({
          manifestPath: path,
          issues: [err instanceof Error ? err.message : String(err)],
        });
      }
    }
  }
  tasks.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));

  return {
    root: absRoot,
    generatedAt: now(),
    tasks,
    invalidManifests,
    invalidReports,
  };
}

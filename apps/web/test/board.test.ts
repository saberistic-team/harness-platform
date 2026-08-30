import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoard } from "../src/index";
import type { RunReport } from "@harness/sdk";

const TMP: string[] = [];

function fixtureRoot(withInvalids: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "harness-web-"));
  TMP.push(root);
  mkdirSync(join(root, "tasks", "runs"), { recursive: true });

  writeFileSync(
    join(root, "tasks", "alpha.yaml"),
    [
      "id: alpha",
      'title: "Alpha task"',
      'goal: "Do alpha"',
      "acceptance:",
      "  - works",
      "allowed_paths:",
      "  - packages/**",
      "permissions:",
      "  fs.read: allow",
      "delivery:",
      "  type: pull_request",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "tasks", "beta.yaml"),
    [
      "id: beta",
      'title: "Beta task"',
      'goal: "Do beta"',
      "acceptance:",
      "  - works",
      "allowed_paths:",
      "  - apps/**",
      "permissions:",
      "  fs.read: allow",
      "delivery:",
      "  type: pull_request",
    ].join("\n"),
  );
  if (withInvalids) {
    writeFileSync(join(root, "tasks", "broken.yaml"), "id: [unclosed\n");
    writeFileSync(
      join(root, "tasks", "runs", "alpha-broken.json"),
      JSON.stringify({ schema: "nope" }),
    );
  }

  const report = (
    id: string,
    status: RunReport["status"],
    finishedAt: string,
    file: string,
  ): RunReport =>
    ({
      schema: "run-report/v1",
      task: { id, title: id, path: `tasks/${id}.yaml` },
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt,
      branch: `tasks/${id}`,
      policy: { changedPathsOk: true, changedPaths: ["a.ts"], violations: [] },
      events: ["{}", "{}"],
      deliverables: {
        artifacts: [],
        reportPath: `tasks/runs/${file}`,
        pullRequest: `https://example.invalid/pull/${id}`,
      },
    }) as unknown as RunReport;

  writeFileSync(
    join(root, "tasks", "runs", "alpha-old.json"),
    JSON.stringify(report("alpha", "failed", "2026-01-01T01:00:00.000Z", "alpha-old.json")),
  );
  writeFileSync(
    join(root, "tasks", "runs", "alpha-new.json"),
    JSON.stringify(report("alpha", "passed", "2026-01-02T01:00:00.000Z", "alpha-new.json")),
  );
  // beta has no reports at all.
  return root;
}

afterAll(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

describe("board data layer (reads tasks/ + tasks/runs/, offline)", () => {
  it("lists manifests with their reports, newest first", async () => {
    const root = fixtureRoot(false);
    const board = await readBoard(root, () => "2026-02-01T00:00:00.000Z");
    expect(board.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(board.tasks.map((t) => t.manifest.id)).toEqual(["alpha", "beta"]);
    const alpha = board.tasks.find((t) => t.manifest.id === "alpha")!;
    expect(alpha.reports).toHaveLength(2);
    expect(alpha.reports[0]!.status).toBe("passed");
    expect(alpha.reports[0]!.finishedAt).toBe("2026-01-02T01:00:00.000Z");
    expect(alpha.reports[1]!.status).toBe("failed");
    expect(board.tasks.find((t) => t.manifest.id === "beta")!.reports).toEqual([]);
    expect(board.invalidManifests).toEqual([]);
    expect(board.invalidReports).toEqual([]);
  });

  it("surfaces invalid manifests and reports as typed items, never skips", async () => {
    const root = fixtureRoot(true);
    const board = await readBoard(root);
    expect(board.tasks.map((t) => t.manifest.id)).toEqual(["alpha", "beta"]);
    expect(board.invalidManifests).toHaveLength(1);
    expect(board.invalidManifests[0]!.manifestPath.endsWith("broken.yaml")).toBe(true);
    expect(board.invalidManifests[0]!.issues.length).toBeGreaterThan(0);
    expect(board.invalidReports).toHaveLength(1);
    expect(board.invalidReports[0]!.reportPath.endsWith("alpha-broken.json")).toBe(true);
    expect(board.invalidReports[0]!.issue).toMatch(/invalid run report/);
  });

  it("handles a missing tasks/ directory without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-web-empty-"));
    TMP.push(root);
    expect((await readBoard(root)).tasks).toEqual([]);
  });
});

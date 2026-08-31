import { describe, expect, it } from "vitest";
import {
  CURRENT_RUN_REPORT_SCHEMA,
  RUN_PREFLIGHT_REPORT_SCHEMA,
  RUN_REPORT_SCHEMA,
  RunReportError,
  runReportGitSnapshotSchema,
  validateReportArtifact,
  validateRunPreflightReport,
  validateRunReport,
} from "../src";

function legacyRunReport(): Record<string, unknown> {
  return {
    schema: RUN_REPORT_SCHEMA,
    task: {
      id: "kernel-0001",
      title: "Add agent event serialization",
      path: "tasks/kernel-0001.yaml",
    },
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    branch: "tasks/kernel-0001",
    policy: {
      changedPathsOk: true,
      changedPaths: ["packages/events/src/schemas.ts"],
      violations: [],
    },
    events: [],
    deliverables: {
      artifacts: [],
      reportPath: "tasks/runs/kernel-0001.json",
    },
  };
}

function preflight(stage: "manifest" | "git"): Record<string, unknown> {
  return {
    schema: RUN_PREFLIGHT_REPORT_SCHEMA,
    manifestPath: "tasks/kernel-0001.yaml",
    runId: "run-1",
    sessionId: "sess-1",
    status: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    events: [],
    deliverables: {
      artifacts: [],
      reportPath: "tasks/runs/run-1.json",
      sessionId: "sess-1",
    },
    error: {
      stage,
      code: stage === "manifest" ? "MANIFEST_INVALID" : "GIT_STATUS_FAILED",
      message: stage === "manifest" ? "manifest is invalid" : "git status failed",
      issues: stage === "manifest"
        ? [{ path: "allowed_paths", message: "Required" }]
        : undefined,
    },
  };
}

describe("run-report compatibility and v2 attestation", () => {
  it("continues to validate historical reports without additive fields", () => {
    expect(validateRunReport(legacyRunReport())).toMatchObject({
      schema: RUN_REPORT_SCHEMA,
      status: "passed",
    });
  });

  it("accepts attempt, builder, and structured failure evidence", () => {
    const failure = {
      stage: "builder" as const,
      code: "BUILDER_FAILED",
      message: "builder exited unsuccessfully",
      issues: [{ path: "builder", message: "exit code 1" }],
    };
    const report = {
      ...legacyRunReport(),
      schema: CURRENT_RUN_REPORT_SCHEMA,
      runId: "run-kernel-0001",
      status: "failed",
      builder: {
        name: "upstream-pi",
        ok: false,
        durationMs: 12,
        exitCode: 1,
      },
      failure,
      failures: [failure],
      deliverables: {
        artifacts: [],
        reportPath: "tasks/runs/kernel-0001.json",
        reportWritten: false,
      },
    };

    expect(validateRunReport(report)).toMatchObject({
      runId: "run-kernel-0001",
      builder: { name: "upstream-pi", outputTail: "" },
      failure: { stage: "builder", code: "BUILDER_FAILED" },
    });
  });

  it("accepts immutable Git attestation with pre/post change evidence", () => {
    const report = validateRunReport({
      ...legacyRunReport(),
      git: {
        repositoryRoot: "/workspace",
        mode: "ci",
        expectedBranch: "tasks/kernel-0001",
        detached: true,
        headSha: "a".repeat(40),
        baseRef: "b".repeat(40),
        baseSha: "b".repeat(40),
        mergeBaseSha: "b".repeat(40),
        preTest: {
          changes: [{
            origin: "committed",
            status: "R100",
            oldPath: "packages/events/old.ts",
            path: "packages/events/new.ts",
          }],
          policyPaths: ["packages/events/new.ts", "packages/events/old.ts"],
        },
        postTest: { changes: [], policyPaths: [] },
      },
    });
    expect(report.git?.preTest.changes[0]).toMatchObject({
      status: "R100",
      oldPath: "packages/events/old.ts",
    });
  });

  it("rejects contradictory or unknown fields in hardened reports", () => {
    expect(() => validateRunReport({
      ...legacyRunReport(),
      schema: CURRENT_RUN_REPORT_SCHEMA,
      runId: "run-forged",
      branch: "feature/not-the-task",
      policy: {
        changedPathsOk: false,
        changedPaths: [],
        violations: ["infra/rogue.txt"],
      },
      tests: {
        command: "pnpm test",
        exitCode: 1,
        ok: false,
        durationMs: 1,
        outputTail: "failed",
      },
      deliverables: {
        artifacts: [],
        reportPath: "tasks/runs/forged.json",
        reportWritten: false,
      },
      unexpected: true,
    })).toThrow(RunReportError);
  });

  it("requires v2 attestation fields even when both are omitted", () => {
    expect(() => validateRunReport({
      ...legacyRunReport(),
      schema: CURRENT_RUN_REPORT_SCHEMA,
    })).toThrow(/runId|reportWritten/);
  });

  it("rejects contradictory command, builder, Git, and receipt evidence", () => {
    const failed = {
      stage: "tests" as const,
      code: "TEST_COMMAND_FAILED",
      message: "failed",
    };
    const base = {
      ...legacyRunReport(),
      schema: CURRENT_RUN_REPORT_SCHEMA,
      runId: "run-forged",
      status: "failed",
      tests: {
        command: "pnpm test",
        exitCode: 7,
        ok: true,
        durationMs: 1,
        outputTail: "",
      },
      builder: {
        name: "upstream-pi",
        ok: true,
        exitCode: 1,
        durationMs: 1,
        outputTail: "",
      },
      git: {
        repositoryRoot: "/workspace",
        mode: "local",
        expectedBranch: "tasks/kernel-0001",
        detached: true,
        headSha: "a".repeat(40),
        baseRef: "refs/heads/main",
        baseSha: "b".repeat(40),
        mergeBaseSha: "b".repeat(40),
        preTest: { changes: [], policyPaths: ["infra/rogue"] },
        postTest: { changes: [], policyPaths: [] },
      },
      failure: failed,
      failures: [failed],
      events: [
        JSON.stringify({
          type: "run.recorded",
          data: {
            runId: "run-forged",
            taskId: "kernel-0001",
            status: "failed",
            reportPath: "tasks/runs/forged.json",
          },
        }),
        JSON.stringify({
          type: "run.recorded",
          data: {
            runId: "someone-else",
            taskId: "kernel-0001",
            status: "failed",
            reportPath: "tasks/runs/forged.json",
          },
        }),
      ],
      deliverables: {
        artifacts: [],
        reportPath: "tasks/runs/forged.json",
        reportWritten: true,
        sessionId: "sess-forged",
      },
    };
    expect(() => validateRunReport(base)).toThrow(
      /exitCode|nonzero|detached|changedPaths|exactly one/,
    );
  });

  it("rejects Git changes omitted from snapshot policy paths", () => {
    expect(() => runReportGitSnapshotSchema.parse({
      changes: [{
        origin: "committed",
        status: "A",
        path: "infra/rogue",
      }],
      policyPaths: [],
    })).toThrow(/write-relevant/);
  });

  it("rejects an untrusted local base ref in v2 Git evidence", () => {
    const failure = {
      stage: "tests" as const,
      code: "TEST_COMMAND_FAILED",
      message: "failed",
    };
    const report = {
      ...legacyRunReport(),
      schema: CURRENT_RUN_REPORT_SCHEMA,
      runId: "run-local-base",
      status: "failed",
      policy: { changedPathsOk: true, changedPaths: [], violations: [] },
      git: {
        repositoryRoot: "/workspace",
        mode: "local",
        expectedBranch: "tasks/kernel-0001",
        actualBranch: "tasks/kernel-0001",
        detached: false,
        headSha: "a".repeat(40),
        baseRef: "refs/heads/main",
        baseSha: "b".repeat(40),
        mergeBaseSha: "b".repeat(40),
        preTest: { changes: [], policyPaths: [] },
        postTest: { changes: [], policyPaths: [] },
      },
      failure,
      failures: [failure],
      deliverables: {
        artifacts: [],
        reportPath: "tasks/runs/local-base.json",
        reportWritten: false,
      },
    };
    expect(validateRunReport(report).git?.baseRef).toBe("refs/heads/main");
    report.git.baseRef = "refs/heads/evil";
    expect(() => validateRunReport(report)).toThrow(/mainish/);
  });
});

describe("run-preflight-report/v1", () => {
  it("accepts a manifest failure without a trusted task identity", () => {
    const report = validateRunPreflightReport(preflight("manifest"));
    expect(report.status).toBe("failed");
    expect(report.error.stage).toBe("manifest");
    expect(report.task).toBeUndefined();
  });

  it("allows Git branch selection to fail before task identity is trusted", () => {
    const unidentified = validateRunPreflightReport(preflight("git"));
    expect(unidentified.task).toBeUndefined();

    const report = validateRunPreflightReport({
      ...preflight("git"),
      task: { id: "kernel-0001", title: "Kernel task" },
      branch: "tasks/kernel-0001",
    });
    expect(report.task).toEqual({
      id: "kernel-0001",
      title: "Kernel task",
    });
  });

  it("is strict and rejects unrelated fields", () => {
    expect(() =>
      validateRunPreflightReport({
        ...preflight("manifest"),
        unexpected: true,
      })
    ).toThrow(/unexpected/);

    const nested = preflight("manifest");
    nested.error = {
      ...(nested.error as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => validateRunPreflightReport(nested)).toThrow(/unexpected/);
  });

  it("requires a complete failure trail from current preflight producers", () => {
    const current = preflight("git");
    (current.deliverables as Record<string, unknown>).reportWritten = false;
    expect(() => validateRunPreflightReport(current)).toThrow(/failure trail/);

    current.failures = [current.error];
    expect(validateRunPreflightReport(current).failures).toHaveLength(1);
  });

  it("is accepted by the union artifact validator alongside v1 reports", () => {
    expect(validateReportArtifact(legacyRunReport()).schema).toBe(
      RUN_REPORT_SCHEMA,
    );
    expect(validateReportArtifact(preflight("manifest")).schema).toBe(
      RUN_PREFLIGHT_REPORT_SCHEMA,
    );
    expect(() => validateReportArtifact({ schema: "unknown/v1" })).toThrow(
      RunReportError,
    );
  });
});

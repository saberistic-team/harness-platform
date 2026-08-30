import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startBoard } from "../src/index";

const TMP: string[] = [];
let base: string;
let server: Awaited<ReturnType<typeof startBoard>>;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-web-server-"));
  TMP.push(root);
  mkdirSync(join(root, "tasks", "runs"), { recursive: true });
  writeFileSync(
    join(root, "tasks", "alpha.yaml"),
    [
      "id: alpha",
      'title: "Alpha"',
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
    join(root, "tasks", "runs", "alpha-ok.json"),
    JSON.stringify({
      schema: "run-report/v1",
      task: { id: "alpha", title: "Alpha", path: "tasks/alpha.yaml" },
      status: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      branch: "tasks/alpha",
      policy: { changedPathsOk: true, changedPaths: [], violations: [] },
      events: [],
      deliverables: { artifacts: [], reportPath: "tasks/runs/alpha-ok.json" },
    }),
  );
  writeFileSync(
    join(root, "tasks", "runs", "alpha-bad.json"),
    JSON.stringify({ schema: "broken" }),
  );

  server = await startBoard({ root });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("web board HTTP (node:http, read-only, no real-time)", () => {
  it("serves the board page at /", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("task board");
  });

  it("GET /api/board returns manifests + reports", async () => {
    const { status, body } = await getJson("/api/board");
    expect(status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].manifest.id).toBe("alpha");
    expect(body.tasks[0].reports[0].status).toBe("passed");
    expect(body.invalidReports).toHaveLength(1);
  });

  it("GET /api/tasks/:id returns one task", async () => {
    const { status, body } = await getJson("/api/tasks/alpha");
    expect(status).toBe(200);
    expect(body.manifest.id).toBe("alpha");
    expect(body.reports).toHaveLength(1);
  });

  it("GET /api/tasks/:id is a typed 404 for unknown tasks", async () => {
    const { status, body } = await getJson("/api/tasks/nope");
    expect(status).toBe(404);
    expect(body.error).toContain('unknown task "nope"');
  });

  it("GET /api/reports/:file returns a validated report", async () => {
    const { status, body } = await getJson("/api/reports/alpha-ok.json");
    expect(status).toBe(200);
    expect(body.status).toBe("passed");
  });

  it("invalid report file is a typed 422, not a silent skip", async () => {
    const { status, body } = await getJson("/api/reports/alpha-bad.json");
    expect(status).toBe(422);
    expect(body.error).toMatch(/invalid run report/);
  });

  it("report paths cannot escape the API (no slash in the name)", async () => {
    const { status } = await getJson("/api/reports/..%2F..%2Fevil.json");
    expect(status).toBe(404); // decoded path contains "/" -> no route
  });

  it("unknown /api route is a typed 404", async () => {
    const { status, body } = await getJson("/api/nope");
    expect(status).toBe(404);
    expect(body.error).toMatch(/no route/);
  });

  it("non-GET is 405 (the board is read-only)", async () => {
    const res = await fetch(base + "/api/board", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

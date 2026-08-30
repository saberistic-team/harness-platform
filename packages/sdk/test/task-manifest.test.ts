import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  ManifestParseError,
  decodeTaskManifest,
  loadTaskManifest,
  loadTaskManifestFile,
} from "../src";

const root = fileURLToPath(
  new URL("../../..", import.meta.url),
);

describe("task manifest decoding", () => {
  it("accepts the real kernel-0001 manifest from the repo", async () => {
    const manifest = await loadTaskManifestFile(
      `${root}/tasks/kernel-0001.yaml`,
    );
    expect(manifest.id).toBe("kernel-0001");
    expect(manifest.title).toBe("Add agent event serialization");
    expect(manifest.permissions["pnpm test*"] === undefined).toBe(true);
    expect(manifest.permissions["fs.read"]).toBe("allow");
    expect(manifest.permissions["fs.write"]).toBe("ask");
    expect(manifest.budget).toEqual({
      max_model_tokens: 100000,
      max_tool_calls: 100,
    });
    expect(manifest.delivery).toEqual({ type: "pull_request" });
  });

  it("accepts a minimal manifest inline", () => {
    const text = [
      "id: demo-0001",
      "title: Demo",
      "goal: >\n  Do it.",
      "acceptance:\n  - it works",
      "allowed_paths:\n  - packages/**",
      "permissions:\n  network: deny",
      "delivery:\n  type: none",
    ].join("\n");
    const m = loadTaskManifest(text);
    expect(m.id).toBe("demo-0001");
    expect(m.goal).toBe("Do it.\n");
    expect(m.permissions["network"]).toBe("deny");
  });

  it("rejects a manifest missing required fields with precise issues", () => {
    expect(() => decodeTaskManifest({ id: "x-1", title: "T" })).toThrow(
      ManifestParseError,
    );
    try {
      decodeTaskManifest({ id: "x-1", title: "T" });
    } catch (err) {
      const e = err as ManifestParseError;
      expect(e.issues.map((i) => i.path)).toEqual(
        expect.arrayContaining(["acceptance", "allowed_paths", "permissions", "delivery"]),
      );
    }
  });

  it("rejects unknown top-level fields (strict contract)", () => {
    const bad = {
      id: "x-1",
      title: "T",
      goal: "g",
      acceptance: ["a"],
      allowed_paths: ["**"],
      permissions: {},
      delivery: { type: "none" },
      sneaky: true,
    };
    expect(() => decodeTaskManifest(bad)).toThrow(/sneaky/);
  });

  it("rejects bad budgets", () => {
    const make = (budget: unknown) => ({
      id: "x-1",
      title: "T",
      goal: "g",
      acceptance: ["a"],
      allowed_paths: ["**"],
      permissions: {},
      delivery: { type: "none" },
      budget,
    });
    expect(() => decodeTaskManifest(make({ max_model_tokens: -1 }))).toThrow();
    expect(() => decodeTaskManifest(make({ bogus: 1 }))).toThrow();
  });
});

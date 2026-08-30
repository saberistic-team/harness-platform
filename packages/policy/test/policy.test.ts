import { describe, expect, it } from "vitest";
import {
  checkChangedPaths,
  decide,
  matchGlob,
  pathAllowed,
  type PermissionMap,
} from "../src";

const manifestPermissions: PermissionMap = {
  "fs.read": "allow",
  "fs.write": "ask",
  "process.exec": {
    "pnpm test*": "allow",
    "pnpm lint*": "allow",
    "*": "deny",
  },
  network: "deny",
  "git.push": "deny",
};

describe("glob matching", () => {
  it("matches * within a path segment only", () => {
    expect(matchGlob("pnpm test*", "pnpm test")).toBe(true);
    expect(matchGlob("pnpm test*", "pnpm test:watch")).toBe(true);
    expect(matchGlob("pnpm test*", "pnpm test extra")).toBe(true);
    expect(matchGlob("pnpm test*", "pnpm test/../etc/passwd")).toBe(false);
    expect(matchGlob("pnpm test*", "pnpm build")).toBe(false);
  });

  it("matches ** across segments", () => {
    expect(matchGlob("packages/events/**", "packages/events/src/index.ts")).toBe(true);
    expect(matchGlob("packages/events/**", "packages/events/x/y/z.ts")).toBe(true);
    expect(matchGlob("packages/**", "packages/events/src/index.ts")).toBe(true);
    expect(matchGlob("**/test.ts", "packages/events/test/x.test.ts")).toBe(true);
    expect(matchGlob("packages/**", "apps/cli/src/main.ts")).toBe(false);
  });
});

describe("decide()", () => {
  it("applies flat rules directly", () => {
    expect(decide(manifestPermissions, "fs.read").effect).toBe("allow");
    expect(decide(manifestPermissions, "fs.write").effect).toBe("ask");
    expect(decide(manifestPermissions, "network").effect).toBe("deny");
    expect(decide(manifestPermissions, "git.push").effect).toBe("deny");
  });

  it("matches exec commands against patterns, most specific wins", () => {
    expect(decide(manifestPermissions, "process.exec", "pnpm test").effect).toBe("allow");
    expect(decide(manifestPermissions, "process.exec", "pnpm lint").effect).toBe("allow");
    expect(decide(manifestPermissions, "process.exec", "pnpm build").effect).toBe("deny");
    expect(decide(manifestPermissions, "process.exec", "curl evil.example").effect).toBe("deny");
  });

  it("prefers the more specific pattern over * regardless of order (single-segment subjects)", () => {
    const map: PermissionMap = {
      "process.exec": { "*": "allow", "rm *": "deny" },
    };
    // "*" does not cross path segments, so both patterns match only
    // when the subject has no "/".
    expect(decide(map, "process.exec", "rm -rf build").effect).toBe("deny");
    expect(decide(map, "process.exec", "ls").effect).toBe("allow");
  });

  it("deny outranks the wildcard when a better pattern also matches", () => {
    const a: PermissionMap = { exec: { "a*": "allow", "a*lock": "deny" } };
    expect(decide(a, "exec", "aloadlock".slice(0, 5)).effect).toBe("allow");
    expect(decide(a, "exec", "aloadlock").effect).toBe("deny");
  });

  it("safe default when no rule exists at all is ask", () => {
    expect(decide(manifestPermissions, "fs.delete").effect).toBe("ask");
    expect(decide(undefined, "anything").effect).toBe("ask");
  });

  it("closed default when a subject is given but no pattern matches and no *", () => {
    const map: PermissionMap = {
      "process.exec": { "pnpm test*": "allow" },
    };
    expect(decide(map, "process.exec", "curl x").effect).toBe("deny");
  });
});

describe("allowed_paths", () => {
  it("checks changed paths against allowed globs", () => {
    const allowed = ["packages/events/**", "packages/kernel/**", "evals/**"];
    expect(pathAllowed(allowed, "packages/events/src/x.ts")).toBe(true);
    expect(pathAllowed(allowed, "packages/kernel/src/run.ts")).toBe(true);
    expect(pathAllowed(allowed, "evals/golden-repositories/README.md")).toBe(true);
    expect(pathAllowed(allowed, "apps/cli/src/main.ts")).toBe(false);
  });

  it("supports bare directory patterns", () => {
    expect(pathAllowed(["packages/events/"], "packages/events/x.ts")).toBe(true);
    expect(pathAllowed(["packages/events/"], "packages/events-2/x.ts")).toBe(false);
  });

  it("reports violations precisely", () => {
    const result = checkChangedPaths(
      ["packages/**"],
      ["packages/events/src/a.ts", "docs/leak.md"],
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(["docs/leak.md"]);
  });
});

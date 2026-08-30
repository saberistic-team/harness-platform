import { describe, expect, it } from "vitest";
import {
  compileGlob,
  compileRules,
  decide,
  matchGlob,
  type PermissionMap,
} from "../src/index";

const MANIFEST: PermissionMap = {
  "fs.read": "allow",
  "fs.write": "ask",
  network: "deny",
  "process.exec": {
    "pnpm test*": "allow",
    "pnpm install --frozen-lockfile": "allow",
    "pnpm install*": "ask",
    "git diff*": "allow",
    "git *": "allow",
    "*": "deny",
  },
};

const SUBJECTS = [
  "pnpm test",
  "pnpm test:watch",
  "pnpm install --frozen-lockfile --offline",
  "pnpm install some-package",
  "git diff --name-only",
  "git push origin tasks/kernel-0001",
  "curl https://example.com",
  "rm -rf /",
  "node -e process.exit(1)",
  "pnpm (te)st",
  "",
];

const ACTIONS = [
  "fs.read",
  "fs.write",
  "network",
  "process.exec",
  "git.push",
  "telemetry.send",
];

describe("compileRules semantics", () => {
  it("decides identically to decide() across the full corpus", () => {
    const rules = compileRules(MANIFEST);
    for (const action of ACTIONS) {
      for (const subject of SUBJECTS) {
        const a = rules.decide(action, subject);
        const b = decide(MANIFEST, action, subject);
        expect({ effect: a.effect, reason: a.reason, rule: a.rule }).toEqual({
          effect: b.effect,
          reason: b.reason,
          rule: b.rule,
        });
      }
    }
  });

  it("compiles once and stays stable across repeated decisions", () => {
    const a = compileRules(MANIFEST);
    const b = compileRules(MANIFEST);
    expect(a.actions()).toEqual(b.actions());
    expect(
      a.decide("process.exec", "pnpm test").effect,
    ).toBe(b.decide("process.exec", "pnpm test").effect);
  });

  it("closes by default: no rule is ask, unmatched exec subject is deny", () => {
    const rules = compileRules(MANIFEST);
    expect(rules.decide("unknown.action").effect).toBe("ask");
    expect(rules.decide("process.exec", "wget http://x").effect).toBe("deny");
    const closed = compileRules({ "process.exec": { "pnpm test*": "allow" } });
    expect(closed.decide("process.exec", "curl http://x").effect).toBe("deny");
  });

  it("longest pattern wins; ties break deny > ask > allow", () => {
    const rules = compileRules({
      "process.exec": {
        "pnpm i*": "deny",
        "pnpm install*": "allow",
        "pnpm install *": "ask",
        "pnpm install pkg": "allow",
      },
    });
    expect(rules.decide("process.exec", "pnpm install pkg").effect).toBe("allow");
    expect(rules.decide("process.exec", "pnpm install other").effect).toBe("ask");
    expect(rules.decide("process.exec", "pnpm i").effect).toBe("deny");
  });
});

describe("compileGlob", () => {
  it("is semantically identical to matchGlob across tricky subjects", () => {
    const patterns = [
      "pnpm test*",
      "pnpm install --frozen-lockfile",
      "tasks/*.yaml",
      "packages/**/src/**/*.ts",
      "a?c",
      "npm run build:fast", // regex special chars must be literal
      "git diff*",
    ];
    for (const pattern of patterns) {
      const m = compileGlob(pattern);
      expect(m.pattern).toBe(pattern);
      for (const s of [
        "pnpm test:watch",
        "pnpm install --frozen-lockfile",
        "pnpm i",
        "tasks/kernel-0001.yaml",
        "tasks/runs/x.json",
        "packages/events/src/schemas.ts",
        "packages/events/test/x.ts",
        "abc",
        "aXc",
        "npm run build:fast",
        "npm run buildXfast",
        "git diff --name-only",
      ]) {
        expect(m.test(s)).toBe(matchGlob(pattern, s));
      }
    }
  });

  it("* does not cross segments; ** does", () => {
    expect(compileGlob("packages/*/test/**").test("packages/events/test/a/b.test.ts")).toBe(true);
    expect(compileGlob("packages/*/test/**").test("packages/events/deep/test.ts")).toBe(false);
    expect(compileGlob("packages/*").test("packages/events/src/x.ts")).toBe(false);
  });
});

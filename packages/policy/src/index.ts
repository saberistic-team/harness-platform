/**
 * Policy engine — pure functions over task-manifest permission rules.
 *
 * No I/O in this package: it decides, it does not act. Callers
 * (kernel, sandbox-runner, CLI) enforce the decisions. That split keeps
 * policy testable without touching the machine.
 *
 * Semantics:
 *  - Effects: allow | ask | deny. `ask` is the safe default: an action
 *    with no rule at all is never silently allowed.
 *  - Rules are action-scoped; some actions (e.g. process.exec) take a
 *    `subject` (the command) matched against glob patterns.
 *  - Most specific (longest) pattern wins; on a tie, deny > ask > allow.
 */

export type Effect = "allow" | "ask" | "deny";

export type SubjectRule = Record<string, Effect>;

export type Rule = Effect | SubjectRule;

export type PermissionMap = Record<string, Rule>;

export interface Decision {
  action: string;
  subject?: string;
  effect: Effect;
  reason: string;
  /** The concrete rule that produced the decision, when there was one. */
  rule?: string | SubjectRule;
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const RANK: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function decide(
  permissions: PermissionMap | undefined,
  action: string,
  subject?: string,
): Decision {
  const rule = permissions?.[action];

  if (rule === undefined) {
    return {
      action,
      subject,
      effect: "ask",
      reason: `no rule for action "${action}"; safe default is ask`,
    };
  }

  if (typeof rule === "string") {
    return {
      action,
      subject,
      effect: rule,
      reason: `flat rule for "${action}"`,
      rule,
    };
  }

  if (subject !== undefined) {
    let best: { pattern: string; effect: Effect; score: number } | undefined;
    for (const [pattern, effect] of Object.entries(rule)) {
      if (matchGlob(pattern, subject)) {
        const candidate = { pattern, effect, score: pattern.length };
        if (
          !best ||
          candidate.score > best.score ||
          (candidate.score === best.score && RANK[candidate.effect] > RANK[best.effect])
        ) {
          best = candidate;
        }
      }
    }
    if (best) {
      return {
        action,
        subject,
        effect: best.effect,
        reason: `subject matched pattern "${best.pattern}"`,
        rule,
      };
    }
  }

  const fallback = rule["*"];
  if (fallback) {
    return {
      action,
      subject,
      effect: fallback,
      reason: subject === undefined ? 'fallback "*" (no subject to match)' : 'no pattern matched; fallback "*"',
      rule,
    };
  }

  return {
    action,
    subject,
    effect: subject === undefined ? "ask" : "deny",
    reason: subject === undefined
      ? 'no flat rule and no subject to match patterns against; safe default is ask'
      : "no pattern matched and no fallback rule; closed by default",
    rule,
  };
}

/**
 * Check a list of changed/created file paths against the manifest's
 * `allowed_paths` globs. Returns the violations (paths outside the
 * allowed set).
 */
export function pathAllowed(allowedPaths: readonly string[], file: string): boolean {
  return allowedPaths.some(
    (pattern) =>
      matchGlob(pattern, file) ||
      (pattern.endsWith("/") && file.startsWith(pattern)),
  );
}

export function checkChangedPaths(
  allowedPaths: readonly string[],
  changedPaths: readonly string[],
): { ok: boolean; violations: string[] } {
  const violations = changedPaths.filter((p) => !pathAllowed(allowedPaths, p));
  return { ok: violations.length === 0, violations };
}

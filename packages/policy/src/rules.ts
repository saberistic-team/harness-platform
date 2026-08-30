import {
  RANK_EXPORT as RANK,
  translate,
  type Decision,
  type Effect,
  type PermissionMap,
} from "./index";

/**
 * The rule compiler (M1): compiles a task manifest's `permissions`
 * block into a closed, fast decision table.
 *
 * This resolves the "exec egress pattern" open question in
 * SECURITY.md at the layer owned by pure policy: the pattern→decision
 * mapping is compiled ONCE per manifest (one RegExp per pattern) and
 * reused for every check, so the CLI (M1) and the sandbox-runner (M3)
 * enforce the same compiled decision — no per-check rescanning, no
 * drift between enforcement points.
 *
 * The compiler does NOT change what is decided. Semantics remain
 * exactly those of `decide()`:
 *   - effects are allow | ask | deny;
 *   - the most specific (longest) matching pattern wins;
 *   - ties break deny > ask > allow;
 *   - a subject action with neither a match nor a "*" fallback is
 *     closed (deny) — never a silent allow.
 */

export interface GlobMatcher {
  readonly pattern: string;
  /** The anchored regular-expression source behind this matcher. */
  readonly source: string;
  test(value: string): boolean;
}

/**
 * Compile one glob pattern into a matcher. Exported so the
 * sandbox-runner and evals can assert on individual patterns; the
 * translation itself is single-sourced with `translate()` in index.ts.
 */
export function compileGlob(pattern: string): GlobMatcher {
  const source = `^${translate(pattern)}$`;
  let cached: RegExp | undefined;
  return {
    pattern,
    source,
    test(value: string) {
      return (cached ??= new RegExp(source)).test(value);
    },
  };
}

interface CompiledSubjectRule {
  matcher: GlobMatcher;
  effect: Effect;
  score: number;
}

interface CompiledAction {
  flat?: Effect;
  subjects: CompiledSubjectRule[];
  fallback?: Effect;
}

export interface CompiledRules {
  /** Same decision shape as `decide()` — this is the enforcement API. */
  decide(action: string, subject?: string): Decision;
  /** The actions this rule set covers (inspection/audit). */
  actions(): string[];
}

function compileAction(
  permissions: PermissionMap,
  action: string,
): CompiledAction {
  const rule = permissions[action];
  if (rule === undefined) return { subjects: [] };
  if (typeof rule === "string") {
    return { flat: rule, subjects: [] };
  }
  const subjects: CompiledSubjectRule[] = [];
  for (const [pattern, effect] of Object.entries(rule)) {
    if (pattern === "*") continue; // the fallback, handled separately
    subjects.push({
      matcher: compileGlob(pattern),
      effect,
      score: pattern.length,
    });
  }
  return { subjects, fallback: rule["*"] };
}

function bestMatch(
  subjects: readonly CompiledSubjectRule[],
  subject: string,
): CompiledSubjectRule | undefined {
  let best: CompiledSubjectRule | undefined;
  for (const s of subjects) {
    if (!s.matcher.test(subject)) continue;
    if (
      best === undefined ||
      s.score > best.score ||
      (s.score === best.score && RANK[s.effect] > RANK[best.effect])
    ) {
      best = s;
    }
  }
  return best;
}

export function compileRules(
  permissions: PermissionMap | undefined,
): CompiledRules {
  const actions = permissions ? Object.keys(permissions) : [];
  const byAction = new Map<string, CompiledAction>();
  for (const action of actions) {
    byAction.set(action, compileAction(permissions ?? {}, action));
  }

  return {
    actions: () => actions,
    decide(action: string, subject?: string): Decision {
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
      const compiled = byAction.get(action)!;
      if (subject !== undefined) {
        const best = bestMatch(compiled.subjects, subject);
        if (best) {
          return {
            action,
            subject,
            effect: best.effect,
            reason: `subject matched pattern "${best.matcher.pattern}"`,
            rule,
          };
        }
      }
      if (compiled.fallback) {
        return {
          action,
          subject,
          effect: compiled.fallback,
          reason:
            subject === undefined
              ? 'fallback "*" (no subject to match)'
              : 'no pattern matched; fallback "*"',
          rule,
        };
      }
      return {
        action,
        subject,
        effect: subject === undefined ? "ask" : "deny",
        reason:
          subject === undefined
            ? 'no flat rule and no subject to match patterns against; safe default is ask'
            : "no pattern matched and no fallback rule; closed by default",
          rule,
        };
    },
  };
}

/** Shorthand for the enforcement shape callers (sandbox, CLI) want. */
export type DecideFn = (action: string, subject?: string) => Decision;

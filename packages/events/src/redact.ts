import { deserializeEvent, serializeEvent } from "./serialize";
import type { AnyHarnessEvent } from "./schemas";

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd");
}

const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /\b((?:OPENAI|AZURE_OPENAI|ANTHROPIC|GOOGLE|AWS)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*)[^\s"']+/gi,
  /\b(sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{12,}/g,
  /\b((?:Proxy-)?Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]+/gi,
  /\b((?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi,
  /((?:x[-_]?api[-_]?key|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|password|passwd|token|secret)["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
];

export const REDACTED = "[REDACTED]";
export const REDACTION_MAX_DEPTH = 64;

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }
  return redacted;
}

/**
 * Deep-copy untrusted event data while replacing common credential fields and
 * inline provider tokens. This is deliberately deterministic and conservative:
 * it is a process-boundary guard, not a general data-loss-prevention engine.
 */
export function redactValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= REDACTION_MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(item, seen, depth + 1);
  }
  return out;
}

/** Return a schema-valid, non-mutating redacted copy of a harness event. */
export function redactEvent<T extends AnyHarnessEvent>(event: T): T {
  const candidate = {
    ...event,
    data: redactValue(event.data),
  };
  return deserializeEvent(serializeEvent(candidate)) as T;
}

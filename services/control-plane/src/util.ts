import { createHash, randomUUID } from "node:crypto";
import { ControlPlaneError } from "./errors";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      `${name} must be a non-empty safe identifier of at most 256 characters`,
    );
  }
  return value;
}

export function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requireId(value, name);
}

export function requireInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

const ISO_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export function requireIso(value: string, name: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneError("CP_INVALID_INPUT", `${name} must be an ISO-8601 timestamp`);
  }
  return value;
}

function canonicalValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("canonical JSON cannot contain cycles");
    seen.add(value);
    const result = `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) throw new TypeError("canonical JSON cannot contain cycles");
    seen.add(value as object);
    const record = value as Record<string, unknown>;
    const result = `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`
    )).join(",")}}`;
    seen.delete(value as object);
    return result;
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

/** Stable JSON for hashes and idempotency comparisons. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new WeakSet());
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function addMilliseconds(iso: string, milliseconds: number): string {
  requireIso(iso, "now");
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

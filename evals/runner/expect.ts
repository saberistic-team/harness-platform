import { isEventType, type AnyHarnessEvent } from "@harness/events";
import { toEventInvariant, type EventInvariant } from "./scenario";

/**
 * Invariant matchers over the event stream. The eval harness asserts
 * on the OBSERVABLE stream only (README rule) — these helpers never
 * touch kernel internals.
 */

export class InvariantCheckError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`invariants failed: ${failures.join("; ")}`);
    this.name = "InvariantCheckError";
  }
}

type RawInvariant = Record<string, unknown> & { type: string };

function getByDotted(obj: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) {
      return { found: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return { found: true, value: cur };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Does one event satisfy a single invariant (type + data paths)? */
export function eventSatisfies(
  event: AnyHarnessEvent,
  rawInv: RawInvariant,
): boolean {
  const inv: EventInvariant = toEventInvariant(rawInv);
  if (event.type !== inv.type) return false;
  for (const [path, expected] of Object.entries(inv.data)) {
    const { found, value } = getByDotted(event.data, path);
    if (!found || !same(value, expected)) return false;
  }
  return true;
}

/**
 * Ordered subsequence check: every invariant must be matched by a
 * distinct event, in order. Matching continues after the last hit,
 * so interleaved events are fine.
 */
export function streamSatisfies(
  events: readonly AnyHarnessEvent[],
  invariants: readonly RawInvariant[],
): string[] {
  const failures: string[] = [];
  let cursor = 0;
  for (const rawInv of invariants) {
    const inv = toEventInvariant(rawInv);
    const idx = events.findIndex((e, i) => i >= cursor && eventSatisfies(e, rawInv));
    if (idx === -1) {
      const data = inv.data;
      failures.push(
        `event "${inv.type}"${
          Object.keys(data).length
            ? ` (data ${JSON.stringify(data)})`
            : ""
        } not found after position ${cursor - 1}`,
      );
    } else {
      cursor = idx + 1;
    }
  }
  return failures;
}

/** Validate that every invariant names a known wire type (rule 4). */
export function assertKnownEventTypes(
  invariants: readonly RawInvariant[],
): string[] {
  return invariants
    .filter((i) => !isEventType(i.type))
    .map((i) => `unknown event type in invariant: "${i.type}"`);
}

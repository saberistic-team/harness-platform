import { randomUUID } from "node:crypto";
import {
  SUPPORTED_EVENT_VERSIONS,
  CURRENT_EVENT_VERSION,
  eventSchemas,
  isEventType,
  type AnyHarnessEvent,
  type EventData,
  type EventType,
  type TypedEvent,
} from "./schemas";
import {
  EventParseError,
  EventSchemaError,
  EventVersionError,
  UnknownEventTypeError,
  HarnessError,
} from "./errors";

export interface CreateEventOptions {
  eventId?: string;
  at?: string;
  actor?: string;
}

/**
 * Build a canonical event object. Field order is fixed
 * (v, type, eventId, at, actor?, data) so that serialization is stable
 * and golden-file diffs are meaningful.
 */
export function createEvent<T extends EventType>(
  type: T,
  data: EventData<T>,
  opts: CreateEventOptions = {},
): TypedEvent<T> {
  const out: Record<string, unknown> = {
    v: CURRENT_EVENT_VERSION,
    type,
    eventId: opts.eventId ?? randomUUID(),
    at: opts.at ?? new Date().toISOString(),
  };
  if (opts.actor !== undefined) out.actor = opts.actor;
  out.data = data;
  // Enforce our own schema at construction time: fail fast, in memory,
  // with a precise message instead of surprising the network layer.
  const res = eventSchemas[type].safeParse({ ...out, type });
  if (!res.success) {
    throw new EventSchemaError(type, res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return out as unknown as TypedEvent<T>;
}

/** Known envelope versions this build can decode. */
export function supportedEventVersions(): number[] {
  return [...SUPPORTED_EVENT_VERSIONS];
}

/**
 * Serialize an event to a JSON wire string.
 */
export function serializeEvent(event: object): string {
  return JSON.stringify(event);
}

interface EnvelopeShape {
  v?: unknown;
  type?: unknown;
}

function asEnvelope(obj: unknown): asserts obj is EnvelopeShape & Record<string, unknown> {
  if (typeof obj !== "object" || obj === null) {
    throw new EventParseError("event payload must be a JSON object");
  }
}

/**
 * Deserialize + validate an event wire string.
 *
 * Gates, in order:
 *   1. JSON parse                 -> EventParseError
 *   2. envelope version supported -> EventVersionError
 *   3. event type known           -> UnknownEventTypeError
 *   4. payload schema             -> EventSchemaError
 *
 * All four are distinct subclasses of HarnessError so callers can react
 * precisely (skip, quarantine, migrate, fatal).
 */
export function deserializeEvent(raw: string | unknown): AnyHarnessEvent {
  let obj: unknown;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new EventParseError(`invalid JSON: ${(err as Error).message}`);
    }
  } else {
    obj = raw;
  }
  asEnvelope(obj);

  if (
    typeof obj.v !== "number" ||
    !SUPPORTED_EVENT_VERSIONS.includes(obj.v)
  ) {
    throw new EventVersionError(obj.v, obj);
  }

  if (typeof obj.type !== "string" || !isEventType(obj.type)) {
    throw new UnknownEventTypeError(String((obj as EnvelopeShape).type), obj);
  }

  const type = obj.type as EventType;
  const result = eventSchemas[type].safeParse(obj);
  if (!result.success) {
    throw new EventSchemaError(
      type,
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}

export function isHarnessError(err: unknown): err is HarnessError {
  return err instanceof HarnessError;
}

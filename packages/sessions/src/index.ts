import { randomUUID } from "node:crypto";
import type { AnyHarnessEvent } from "@harness/events";
import {
  eventPageBounds,
  type EventLog,
  type EventPageOptions,
  type SessionEventPage,
  type SessionHandle,
  type SessionRecord,
  type SequencedEvent,
} from "./store";

/**
 * Sessions — the durable record of one agent activity stream.
 *
 * The in-memory implementation remains the offline baseline. SQLite and
 * Postgres implement the common durable SessionStore contract.
 *
 * Rules:
 *  - A session is append-only; corrections are new events.
 *  - Events carry their own identity (eventId, at); the log only
 *    appends and never rewrites.
 */

export class InMemoryEventLog implements EventLog {
  private readonly events: AnyHarnessEvent[] = [];

  constructor(private readonly sessionId = "in-memory") {}

  async append(event: AnyHarnessEvent): Promise<number> {
    this.events.push(event);
    return this.events.length - 1;
  }

  async appendSequenced(event: AnyHarnessEvent): Promise<SequencedEvent> {
    const seq = await this.append(event);
    return { sessionId: this.sessionId, seq, globalSeq: seq, event };
  }

  async read(options: EventPageOptions = {}): Promise<SessionEventPage> {
    const { cursor, limit } = eventPageBounds(
      options.afterSeq,
      options.limit,
      "afterSeq",
    );
    const candidates = this.events.slice(cursor + 1, cursor + 1 + limit + 1);
    const hasMore = candidates.length > limit;
    const pageEvents = candidates.slice(0, limit).map((event, index) => {
      const seq = cursor + 1 + index;
      return { sessionId: this.sessionId, seq, globalSeq: seq, event };
    });
    return {
      events: pageEvents,
      nextAfterSeq: pageEvents.at(-1)?.seq ?? cursor,
      hasMore,
    };
  }

  async slice(from: number, to = this.events.length): Promise<AnyHarnessEvent[]> {
    return this.events.slice(Math.max(0, from), Math.min(to, this.events.length));
  }

  async size(): Promise<number> {
    return this.events.length;
  }
}

export * from "./store";
export * from "./sqlite";
export * from "./postgres";

export function openSession(
  opts: { taskId?: string; createdAt?: string } = {},
): SessionHandle {
  const sessionId = `sess-${randomUUID()}`;
  const record: SessionRecord = {
    sessionId,
    taskId: opts.taskId,
    status: "active",
    createdAt: opts.createdAt ?? new Date().toISOString(),
    metadata: {},
  };
  return {
    record,
    log: new InMemoryEventLog(sessionId),
  };
}

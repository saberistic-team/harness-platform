import { randomUUID } from "node:crypto";
import type { AnyHarnessEvent } from "@harness/events";

/**
 * Sessions — the durable record of one agent activity stream.
 *
 * M0 scope: in-memory append-only log over the harness event stream,
 * plus the shapes the persistent layer (SQLite/Postgres) will store.
 *
 * Rules:
 *  - A session is append-only; corrections are new events.
 *  - Events carry their own identity (eventId, at); the log only
 *    appends and never rewrites.
 */

export type SessionStatus = "active" | "closed" | "archived";

export interface SessionRecord {
  sessionId: string;
  taskId?: string;
  status: SessionStatus;
  createdAt: string;
  closedAt?: string;
}

export interface EventLog {
  /** Append an event; returns its sequence number (0-based). */
  append(event: AnyHarnessEvent): Promise<number>;
  /** Read a range [from, to) of stored events. */
  slice(from: number, to?: number): Promise<AnyHarnessEvent[]>;
  size(): Promise<number>;
}

export class InMemoryEventLog implements EventLog {
  private readonly events: AnyHarnessEvent[] = [];

  async append(event: AnyHarnessEvent): Promise<number> {
    this.events.push(event);
    return this.events.length - 1;
  }

  async slice(from: number, to = this.events.length): Promise<AnyHarnessEvent[]> {
    return this.events.slice(Math.max(0, from), Math.min(to, this.events.length));
  }

  async size(): Promise<number> {
    return this.events.length;
  }
}

export interface SessionHandle {
  record: SessionRecord;
  log: EventLog;
}

export * from "./sqlite";

export function openSession(
  opts: { taskId?: string; createdAt?: string } = {},
): SessionHandle {
  return {
    record: {
      sessionId: `sess-${randomUUID()}`,
      taskId: opts.taskId,
      status: "active",
      createdAt: opts.createdAt ?? new Date().toISOString(),
    },
    log: new InMemoryEventLog(),
  };
}

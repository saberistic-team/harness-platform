# EVENTS.md

The harness event stream is the **single wire format** for anything
observable in the system: kernel loops, services, UIs, the audit log,
and the eval harness all consume these events. UIs render state; they
do not parse service-specific payloads.

## Envelope

```json
{
  "v": 1,
  "type": "agent.started",
  "eventId": "3f2a…",            // unique id for the event
  "at": "2026-01-02T03:04:05Z",  // ISO-8601, producer's clock
  "actor": "kernel",             // optional; who emitted
  "data": { }                    // payload — typed per `type`
}
```

Rules:
- **`v` is the envelope version**, not the payload version. A payload
  change is a `type` change (or an additive optional field on an
  existing `type`), and requires a new payload schema entry — never a
  bump of `v` on the same wire shape.
- **Field order is fixed** (`v, type, eventId, at, actor?, data`).
  Tests assert stable serialization for golden files.
- **Unknown input is a typed error**, never a silent fallback:
  | gate  | error class               |
  | ----- | ------------------------- |
  | JSON  | `EventParseError`         |
  | `v`   | `EventVersionError`       |
  | `type`| `UnknownEventTypeError`   |
  | data  | `EventSchemaError`        |
  All four carry the raw payload for later migration.

## Catalog (v1)

| type             | fired when                              | key payload fields                |
| ---------------- | --------------------------------------- | --------------------------------- |
| `session.created`| a session opens                         | `sessionId`, `workspace?`         |
| `agent.started`  | the kernel loop starts                  | `agentId`, `sessionId`, `model`   |
| `agent.stopped`  | the loop ends for any reason            | `status`, `steps`, `toolCalls`    |
| `model.request`  | a model turn is dispatched              | `requestId`, `model`              |
| `model.response` | a model turn returns                    | `requestId`, `finishReason`, `usage` |
| `tool.call`      | a tool is invoked                       | `callId`, `tool`, `input`         |
| `tool.result`    | a tool returns (ok or error)            | `callId`, `ok`, `output|error`    |
| `task.updated`   | a manifest's phase changes              | `taskId`, `phase`                 |
| `budget.warning` | a budget threshold is crossed           | `metric`, `used`, `limit`, `pct`  |
| `policy.decision`| policy engine rules on an action        | `action`, `effect`, `reason`      |
| `run.recorded`   | a run report is written                 | `runId`, `taskId`, `status`, `reportPath` |
| `error`          | a fatal error with a code               | `code`, `message`, `retryable?`   |

## Versioning

- `CURRENT_EVENT_VERSION = 1` (see `packages/events/src/schemas.ts`).
- `SUPPORTED_EVENT_VERSIONS = [1]` for this build; deserialization
  throws `EventVersionError` for anything else.
- **Adding** an event type: append to the catalog + schema registry +
  a round-trip test in `packages/events/test/`.
- **Removing** a type: bump `CURRENT_EVENT_VERSION`, keep the old type
  in `SUPPORTED_EVENT_VERSIONS` for one release, and provide a
  migration note in `EVENTS.md`.
- **Never** change an existing `type`'s payload in a breaking way.

## Consumer contract

Consumers must:
1. Gate on `v`, then `type`, then payload (exactly the order the
   deserializer does).
2. Treat `data` as untrusted (it may have been produced by a model or a
   third-party MCP server) — schema-validate before using.
3. Log unknown-but-valid events to the audit trail, not discard them
   (they are evidence).

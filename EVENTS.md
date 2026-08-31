# EVENTS.md

The harness event stream is the **canonical durable and streaming format** for
observable state changes: kernel loops, services, event-driven UIs, the audit
log, and the eval harness consume these events. Protocol control messages such
as HTTP requests/responses and ACP JSON-RPC envelopes keep their own typed JSON
shapes; committed state changes still produce harness events.

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
  Version and type errors retain the decoded frame. Parse and schema errors
  carry bounded diagnostics instead; a caller that needs quarantine must retain
  the inbound frame before decoding it.

## Catalog (v1)

| type             | fired when                              | key payload fields                |
| ---------------- | --------------------------------------- | --------------------------------- |
| `session.created`| a session opens                         | `sessionId`, `workspace?`         |
| `session.restored` | an interrupted durable session is reconciled for replay | `sessionId`, `afterSeq`, `outcome` |
| `agent.started`  | the kernel loop starts                  | `agentId`, `sessionId`, `model`   |
| `agent.stopped`  | the loop ends for any reason            | `status`, `steps`, `toolCalls`    |
| `model.request`  | a model turn is dispatched              | `requestId`, `model`              |
| `model.response` | a model turn returns                    | `requestId`, `finishReason`, `usage` |
| `tool.call`      | a tool is invoked                       | `callId`, `tool`, `input`         |
| `tool.result`    | a tool returns (ok or error)            | `callId`, `ok`, `output|error`    |
| `task.updated`   | a manifest's phase changes              | `taskId`, `phase`                 |
| `budget.warning` | a budget threshold is crossed           | `metric`, `used`, `limit`, `pct`  |
| `policy.decision`| policy engine rules on an action        | `action`, `effect`, `reason`      |
| `permission.requested` | an `ask` pauses before a side effect | `permissionId`, `sessionId`, `action`, `scope` |
| `permission.resolved` | an operator resolves one pending ask | `permissionId`, `decision`, `scope` |
| `sandbox.started` | a completed Docker run proves an owned container existed | `runId`, `containerName`, `image`, `network`, `mounts` |
| `sandbox.stopped` | execution ends and owned-container cleanup is verified | `runId`, `containerName`, `status`, `exitCode?`, `durationMs` |
| `run.recorded`   | a run report is written                 | `runId`, `taskId`, `status`, `reportPath` |
| `run.scheduled`  | the control plane admits a queued run   | `runId`, `taskId`, `attempt`, `manifestDigest` |
| `run.leased`     | a worker receives a fenced run lease    | `runId`, `workerId`, `fencingToken`, `expiresAt` |
| `run.updated`    | a durable run mutation commits after leasing | `runId`, `change`, `status`, `previousStatus`, `version` |
| `artifact.registered` | immutable object metadata is committed after upload | `artifactId`, `kind`, `bucket`, `key`, `sha256`, `bytes` |
| `audit.exported` | an audit JSONL segment and checkpoint are committed | `exportId`, `artifactId`, `fromSeq`, `toSeq`, `eventCount` |
| `error`          | a fatal error with a code               | `code`, `message`, `retryable?`   |

## Versioning

- `CURRENT_EVENT_VERSION = 1` (see `packages/events/src/schemas.ts`).
- `SUPPORTED_EVENT_VERSIONS = [1]` for this build; deserialization
  throws `EventVersionError` for anything else.
- **Adding** an event type: append to the catalog + schema registry +
  a round-trip test in `packages/events/test/`.
- **Removing** a type or changing the envelope: first add a parallel,
  version-keyed schema/decoder and its compatibility tests. Only then add that
  version to `SUPPORTED_EVENT_VERSIONS`; never advertise a version through the
  current single-version registry before it can actually decode it.
- **Never** change an existing `type`'s payload in a breaking way.

## Consumer contract

Consumers must:
1. Gate on `v`, then `type`, then payload (exactly the order the
   deserializer does).
2. Treat `data` as untrusted (it may have been produced by a model or a
   third-party MCP server) — schema-validate before using.
3. Preserve rejected inbound frames in a caller-controlled quarantine when
   policy permits. Never append unvalidated input to the canonical audit stream.

## Permission ordering

An interactive `ask` has one canonical event order:

```text
tool.call
policy.decision (effect=ask)
permission.requested
... kernel is paused; the tool has not executed ...
permission.resolved (decision=allow|deny)
tool.result
```

`permissionId` is single-use and scoped to its `sessionId`. A hard policy
`deny` cannot be overridden and therefore emits no permission request.
Missing resolvers, EOF, disconnects, cancellation, and timeouts resolve as
denial. The agent-server redacts sensitive tool and permission payloads before
events are persisted or sent over ACP.

## Scheduling and replay ordering

A scheduled run has one active lease at a time. `run.scheduled` precedes its
first `run.leased`; every later lease uses a strictly larger fencing token.
Workers must include the current lease identity and fencing token when they
heartbeat or commit a transition. A stale worker may finish local cleanup, but
its state or artifact commit is rejected and therefore produces no canonical
completion event.

Lease IDs and completion idempotency keys are capabilities, not evidence. They
are deliberately absent from `run.leased`, `run.updated`, and audit exports;
only the scheduler's claim response returns the lease ID to its worker.

Control-plane events use deterministic `eventId` values and are inserted into a
durable outbox in the same transaction as their task, run, artifact, or audit
checkpoint mutation. `run.updated` records starts, heartbeats, terminal
completion or cancellation, lease-expiry requeue/quarantine, and explicit
reconciliation. Publishers preserve outbox order and may redeliver the same
`eventId` if delivery succeeded but its acknowledgement was lost; durable event
sinks must therefore deduplicate by `eventId`.

ACP restore uses an explicit **last-seen** sequence cursor. A client asking for
`afterSeq = n` receives only committed events with `seq > n`, in ascending
order. `session.restored.availableThroughSeq` and `availableEvents` describe the
durable stream that existed before recovery; they are not the ACP response's
paged `replayedThroughSeq` and `replayedEvents` counts. If an expired active row
already ends in a terminal `agent.stopped`, recovery closes it as completed
without manufacturing a restore marker. Only a nonterminal tail atomically
appends one `session.restored` event with `outcome=interrupted` and closes the
session. Reconnecting is replay, not authorization to retry an uncertain side
effect.

Artifact events contain immutable metadata, never credentials or signed URLs.
`audit.exported` is emitted only after the deterministic JSONL object and its
artifact registry entry are durable; its sequence range is inclusive. Signed
URLs are short-lived API responses and are not part of the event stream.

`sandbox.started` is deliberately conservative: it is emitted after `docker
run` returns only when the runner has an owned container ID and Docker did not
report its reserved infrastructure-failure status. It does not claim a health
check passed, and its event timestamp is therefore an audit-confirmation time,
not the container's exact start time. `sandbox.stopped` follows only after
cleanup removes that owned container or verifies it is already absent. Cleanup
failure emits a typed `error` event and deliberately omits `sandbox.stopped`.

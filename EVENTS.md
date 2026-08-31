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
| `turn.started`   | a caller-identified runtime turn is admitted | `runId`, `sessionId`, `turnId`, `inputMessageId` |
| `message.delta`  | an ordered assistant-text chunk is durable | `runId`, `turnId`, `requestId`, `messageId`, `sequence`, `delta` |
| `message.completed` | a complete user or assistant message is durable | `runId`, `turnId`, `messageId`, `role`, `content`, `requestId?` |
| `steering.queued` | an active run accepts a steering message | `runId`, `sessionId`, `turnId`, `messageId`, `content` |
| `context.compacted` | a smaller replayable context replaces prior context | `runId`, `turnId`, `summaryMessageId`, `beforeMessages`, `afterMessages` |
| `turn.completed` | one admitted turn reaches a terminal outcome | `runId`, `sessionId`, `turnId`, `status`, `modelRequests`, `toolCalls` |
| `model.request`  | a model turn is dispatched              | `requestId`, `model`              |
| `model.response` | a model turn returns                    | `requestId`, `finishReason`, `usage` |
| `tool.call`      | a tool is invoked                       | `callId`, `tool`, `input`         |
| `tool.result`    | a tool returns (ok or error)            | `callId`, `ok`, `output|error`    |
| `task.updated`   | a manifest's phase changes              | `taskId`, `phase`                 |
| `budget.warning` | a budget threshold is crossed           | `metric`, `used`, `limit`, `pct`  |
| `policy.decision`| policy engine rules on an action        | `taskId?`, `sessionId?`, `runId?`, `action`, `effect`, `reason` |
| `permission.requested` | an `ask` pauses before a side effect | `permissionId`, `sessionId`, `action`, `scope` |
| `permission.resolved` | an operator resolves one pending ask | `permissionId`, `decision`, `scope` |
| `sandbox.started` | a completed Docker run proves an owned container existed | `runId`, `containerName`, `image`, `network`, `mounts` |
| `sandbox.stopped` | execution ends and owned-container cleanup is verified | `runId`, `containerName`, `status`, `exitCode?`, `durationMs` |
| `run.recorded`   | a run report is atomically committed    | `runId`, `taskId`, `status`, `reportPath` |
| `run.scheduled`  | the control plane admits a queued run   | `runId`, `taskId`, `attempt`, `manifestDigest` |
| `run.leased`     | a worker receives a fenced run lease    | `runId`, `workerId`, `fencingToken`, `expiresAt` |
| `run.updated`    | a durable run mutation commits after leasing | `runId`, `change`, `status`, `previousStatus`, `version` |
| `artifact.registered` | immutable object metadata is committed after upload | `artifactId`, `kind`, `bucket`, `key`, `sha256`, `bytes` |
| `audit.exported` | an audit JSONL segment and checkpoint are committed | `exportId`, `artifactId`, `fromSeq`, `toSeq`, `eventCount` |
| `error`          | a fatal error with a code               | `taskId?`, `sessionId?`, `runId?`, `stage?`, `code`, `message`, `retryable?` |

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

## Minimal runtime turn ordering

The minimal runtime persists every event before making it visible through its
async iterator. An append failure fails closed: the failed event is not yielded,
and the runtime does not cross the next model or tool boundary. To support
steering or cancellation before the caller consumes its first event, `run()` may
eagerly persist the `turn.started` and input `message.completed` admission pair
before iterator demand. After that admission pair, consumer advancement is the
producer and model backpressure boundary: the runtime does not cross the model
request boundary until the durable `model.request` event is consumed, and it
does not pull another model chunk until the consumer advances after the current
yielded event. Externally invoked controls may independently append their own
events while the producer is backpressured.

A deterministic text-only turn has this exact order:

```text
turn.started
message.completed (role=user)
model.request
message.delta (role=assistant, sequence=0..n-1; zero or more)
model.response
message.completed (role=assistant)
turn.completed (status=completed)
```

`turn.started.inputMessageId` identifies the immediately following durable user
message. Each assistant delta carries the request and message identities; its
per-message `sequence` starts at zero and is contiguous. When one or more deltas
were emitted, concatenating them equals the assistant
`message.completed.content`. A model may emit no deltas and return nonempty
completed content, so the completed message is always the replayable source of
truth. Assistant messages carry `requestId` and `finishReason`; user messages
reject those model-only fields.

`steering.queued` is appended before `steer()` resolves and its `messageId`
becomes the durable identity used when the queued content enters context at the
next model boundary. M6 has one such boundary: a steering call that linearizes
after the sole `model.request` is rejected with a typed error instead of
persisting content that cannot be consumed. Steering an unknown or terminal run
is also a typed error. Canceling an active run is idempotent; abandoning its
iterator has the same cancellation semantics and still durably terminates the
turn, even though the abandoning consumer cannot receive that final event. A
failed terminal append rejects cancellation or abandonment with the typed store
error. Repeating cancellation of an already canceled run is a no-op, while
other unknown or terminal identities remain typed errors.

`context.compacted` contains the durable summary text and its message identity,
not only telemetry. It must reduce the message count; token counts are optional
but, when present, appear as a before/after pair and must also decrease. Its
`requestId` is optional because deterministic compaction does not need a model
request.

Tool-loop producers continue to use `tool.call`, `policy.decision`, and
`tool.result` for requested intent, the persisted policy outcome, and completed
work. The policy decision is durable before any permitted side effect begins.

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

## Exit-gate decisions and failure evidence

The CLI emits a `policy.decision` for every gate it actually evaluates,
including successful `allow` decisions. An `ask` or `deny` is evidence before
the headless run stops; it is never represented only by the final report. The
CLI action vocabulary is:

| action | decision represented |
| ------ | -------------------- |
| `git.branch` | the checkout and requested task branch identify the same task |
| `workspace.path_scope` | all observed changed paths are inside the manifest's `allowed_paths` boundary |
| `fs.read` | the manifest permits the builder to read its scoped workspace |
| `fs.write` | the manifest permits, denies, or requires approval for builder writes |
| `process.exec` | the manifest permits, denies, or requires approval for the concrete test process |

New CLI-produced policy decisions carry `taskId`, `sessionId`, and `runId` so
the standalone event remains attributable after global audit export. The
payload accepts either that complete tuple or no attribution tuple at all;
partial attribution is invalid. The unattributed alternative exists only for
historical and non-task producers. A CLI attempt must not omit identities.

CLI failures emit `error` with the same available attribution. Its optional
`stage` has this closed vocabulary:

| stage | boundary that failed |
| ----- | -------------------- |
| `manifest` | manifest read, YAML parsing, or task-schema validation |
| `git` | repository, branch, base, head, or changed-path discovery preflight |
| `policy` | an evaluated policy gate blocked the run |
| `builder` | the TaskAgent builder did not complete successfully |
| `tests` | the configured verification process failed |
| `evidence` | durable session or event evidence could not be persisted |
| `report` | report construction, validation, or writing failed |

A malformed manifest cannot provide a trusted task identity, and an early Git
failure cannot provide all fields required by the normal report contract. Those
attempts use the strict `run-preflight-report/v1` artifact. Manifest-stage
failures may omit `task`; Git-stage failures normally include it, but may omit
it when selecting an existing task branch fails before that branch's manifest
can be read and validated. Normal policy, builder, test, evidence, and report
outcomes use `run-report/v2`; legacy `run-report/v1` is read-only and not a
current gate attestation. `failure` carries the primary compatibility
failure and `failures` carries the ordered complete failure trail. New reports
provide those fields together and enforce coherence among branch/Git identity,
scope, tests, status, and the report receipt without invalidating historical v1
reports. Builder evidence remains an additive field.

For CLI attempts, SQLite contains the causal gate events. `run.recorded` is a
report-local commit receipt included in the exact bytes that are atomically
renamed into place, then forwarded to telemetry only after that rename
succeeds. It is deliberately not inserted into SQLite first: the database and
filesystem cannot share one transaction, and a pre-written receipt could claim
a report that never existed. If every report destination fails,
`deliverables.reportWritten` is false and no `run.recorded` event is emitted.

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

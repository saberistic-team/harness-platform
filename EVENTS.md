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
| `agent.started`  | the kernel loop starts                  | `agentId`, `sessionId`, `model`, `runId?`, `turnId?` |
| `agent.stopped`  | the kernel loop ends for any reason     | `status`, `steps`, `toolCalls`, `runId?`, `sessionId?`, `turnId?` |
| `turn.started`   | a caller-identified runtime turn is admitted | `runId`, `sessionId`, `turnId`, `inputMessageId` |
| `message.delta`  | an ordered assistant-text chunk is durable | `runId`, `turnId`, `requestId`, `messageId`, `sequence`, `delta` |
| `message.completed` | a complete user, assistant, or tool message is durable | `runId`, `turnId`, `messageId`, `role`, `content`, `stateVersion?`, `messageRevision?` |
| `steering.applied` | FIFO messages incorporated at the next safe model boundary | `runId`, `sessionId`, `turnId`, `messageIds`, `messageRevision` |
| `steering.queued` | an active run accepts a steering message | `runId`, `sessionId`, `turnId`, `messageId`, `content` |
| `context.compacted` | a smaller replayable context replaces prior context | `runId`, `turnId`, `summaryMessageId`, `beforeMessages`, `afterMessages` |
| `turn.completed` | one admitted turn reaches a terminal outcome | `runId`, `sessionId`, `turnId`, `status`, `modelRequests`, `toolCalls`, `usage?`, `stateVersion?`, `messageRevision?` |
| `model.request`  | a model step is durably dispatched      | `requestId`, `model`, `runId?`, `sessionId?`, `turnId?`, `step?`, `contextVersion?`, `messageRevision?` |
| `model.response` | a model step returns                    | `requestId`, `finishReason`, `usage`, `runId?`, `sessionId?`, `turnId?` |
| `tool.call`      | a model's requested tool intent is durable | `callId`, `tool`, `input`, `requestId?`, `modelCallId?` |
| `tool.result`    | a tool attempt or typed pre-execution failure completes | `callId`, `ok`, `output|error`, `runId?`, `sessionId?`, `turnId?` |
| `task.updated`   | a manifest's phase changes              | `taskId`, `phase`                 |
| `budget.warning` | a step, token, or tool-call threshold is crossed | `metric`, `used`, `limit`, `pct`, `runId?`, `sessionId?`, `turnId?` |
| `policy.decision`| policy engine rules on an action        | `taskId?`, `sessionId?`, `runId?`, `turnId?`, `callId?`, `action`, `effect`, `reason` |
| `permission.requested` | an `ask` pauses before a side effect | `permissionId`, `sessionId`, `runId?`, `turnId?`, `action`, `scope` |
| `permission.resolved` | a pending ask receives an allow/deny resolution | `permissionId`, `sessionId`, `runId?`, `turnId?`, `decision`, `scope` |
| `workspace.lifecycle` | native workspace opens, snapshots, disposes, retains or expires | `workspaceId`, `backend`, `phase`, `snapshotId?`, `expiresAt?` |
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

A deterministic M7 multi-round tool turn has this exact order. The model may
repeat the bracketed model/tool segment as many times as its hard budgets
permit:

```text
agent.started
turn.started
message.completed (role=user)
model.request
message.delta (role=assistant, sequence=0..n-1; zero or more)
model.response (finishReason=tool_calls)
message.completed (role=assistant)
tool.call (requested intent; the tool has not executed)
policy.decision (effect=allow|ask|deny)
permission.requested (ask only)
permission.resolved (ask only)
... only an allowed and durably decided tool executes ...
tool.result
message.completed (role=tool; observation enters context)
model.request
... more text/tool rounds as needed ...
model.response (finishReason=stop)
message.completed (role=assistant)
turn.completed (status=completed)
agent.stopped (status=completed)
```

`agent.started` and `agent.stopped` bookend the run for every outcome. Exactly
one `turn.completed` precedes the stop event when its terminal append succeeds;
cancellation, timeout, failure, and hard-budget exhaustion use the matching
terminal status. A text-only turn is the same sequence with the tool segment
omitted.

`turn.started.inputMessageId` identifies the immediately following durable user
message. Each assistant delta carries the request and message identities; its
per-message `sequence` starts at zero and is contiguous. When one or more deltas
were emitted, concatenating them equals the assistant
`message.completed.content`. A model may emit no deltas and return nonempty
completed content, so the completed message is always the replayable source of
truth. Assistant messages carry `requestId` and `finishReason`; user messages
reject those model-only fields. Tool messages strictly carry `name` and the
provider's `toolCallId` so the next model context can associate an observation
with the requested call.

New runtime producers attach `stateVersion: 1` and a monotonic
`messageRevision` to each completed message. A `model.request` records
`contextVersion: 1` together with the exact revision used to build that
request; either both fields are present or neither is. `turn.completed` may
carry the final state version, revision, cumulative usage, and a human-readable
note. These fields are additive so legacy event payloads remain
valid.

`steering.queued` is appended before `steer()` resolves. Appends serialize in
invocation order, and `steering.applied` records their incorporation only at a
safe model-request boundary. In-flight requests are immutable. Accepted
steering during a final response produces another round. Cancellation becomes
visible synchronously: later steering rejects; a steering append already in
progress finishes and remains in history even if cancellation wins. Completion
wins only at its serialized terminal boundary. Exactly one terminal outcome is
published. A new run/turn on the same session inherits messages, pending steering
and cumulative usage; concurrent turns and replacing prior context are rejected.
M14 adds cross-process storage and reconstruction.

`context.compacted` contains the durable summary text and its message identity,
not only telemetry. It must reduce the message count; token counts are optional
but, when present, appear as a before/after pair and must also decrease. Its
`requestId` is optional because deterministic compaction does not need a model
request.

Tool-loop producers continue to use `tool.call`, `policy.decision`, and
`tool.result` for requested intent, the persisted policy outcome, and completed
work. `tool.call` never means that execution already occurred. The intent is
durable before policy is derived, and the policy decision plus any permission
resolution are durable before any permitted side effect begins. Unknown tools
and invalid arguments follow `tool.call` with a typed failed `tool.result` and
do not derive authorization or execute a tool. New runtime policy decisions
carry the same `sessionId`, `runId`, `turnId`, and `callId` as the fenced call;
historical task-attributed and unattributed payloads remain decodable. The
runtime snapshots bounded ordinary JSON for the intent and validated input, so
model, event-consumer, and authorization mutations cannot change what later
executes. When a requested call crosses the hard tool-call limit, that intent
is still durable, followed by `budget.warning`; no policy is derived and the
over-limit call does not execute.

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
denial. A resolver-produced resolution uses the `operator` actor; a denial
synthesized by the runtime uses the `kernel` actor. The agent-server redacts
sensitive tool and permission payloads before events are persisted or sent over
ACP.

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

### Native workspace lifecycle (M9–M10)

`workspace.lifecycle` is emitted by the adapter after opening, when producing a
content-addressed snapshot, when disposing, and when granting or expiring an
explicit retention lease. `backend` is `local` or `docker`. Retention leases
carry `expiresAt` and are limited to one hour. The retained object is bounded
workspace state/output, never a running container. Docker command lifecycles
continue to emit M3 `sandbox.started` and `sandbox.stopped`; ownership or cleanup
failure remains a typed error. Callers connect `onEvent` to their audit sink.
No file contents, argv values or credentials are placed in lifecycle events.


M13 adds `context.accounted` (conservative `utf8-upper-bound/v1` occupancy,
window and output reservation), and `context.checkpoint` (version 1 summary,
original-history tail index/revision and immutable tail). The summary view never
replaces original message history. `context.compacted` links the before/after
counts. Summary requests use the ordinary model deadline, stream validation,
usage and hard budget; they do not execute tools. A failed summary or context
that cannot fit fails closed with `turn.completed.errorCode` equal to
`RUNTIME_SUMMARY_FAILED` or `RUNTIME_CONTEXT_OVERFLOW`. Usage is cumulative
across same-session turns; occupancy is measured independently per request.


M14 adds `runtime.checkpoint` with an independently versioned v1 payload.
The production `SessionEventStore` opts into checkpoints at model boundaries
(including summary requests) and terminal outcomes. Payloads retain original
message state, exact detached next request, model identity/options, cumulative
usage, round/tool counters, seen tool IDs, grants, pending FIFO steering,
turn identities and compaction state. SQLite/Postgres assign cursors, preserve
stable IDs, reject conflicting delivery and fence appends and checkpoint CAS
under their storage lock. Redelivery of an older identical checkpoint cannot
rewind the current cursor. A failed CAS stops the runtime before model execution.
`reconstructModelRequest` is pure and rejects future versions. `restoreSession`
loads committed terminal history for a new follow-up; uncertain model/tool work
is never silently repeated. Live Postgres remains outside the default lane;
its transaction and ordering contracts use injected deterministic fixtures.

M11 native model mutations (`fs.write`, `process.exec`) require the attested
isolated Workspace. Local or forged workspaces fail before effects and persist
`tool.result.error.code = WORKSPACE_ISOLATION_REQUIRED`. This removes the host
path-check/rename race from the model capability surface; trusted developer
LocalWorkspace APIs are not promoted into model mutation authority.


M15 adds `runtime.continued` (`runId`, `sessionId`, `turnId`,
`checkpointRevision`, `ownerId`). SQLite/Postgres append it in the same
transaction that replaces an expired owner and advances the safe checkpoint
cursor. A crash during takeover leaves either the old safe boundary or the
new safe boundary; stale owners cannot append. `runtime.checkpoint` v1 adds
phase `safe`, agent identity, reviewed tool definitions and workspace snapshot.
Safe checkpoints precede model intent. Model/summary checkpoints remain
indeterminate execution markers, never permission to retry. Continuation
preserves the original turn and does not emit another `agent.started`,
`turn.started`, or input message. Uncertain recovery uses M4 `session.restored`
with outcome `interrupted`; cancellation completes the original turn as canceled.

M17 adds `builder.attested` with gate task/run/session IDs, native run ID,
`native-builder/v1` version and attestation digest. The gate emits it only for
its registered native TaskAgent result after clean input, unchanged manifest,
source identity and generated scope checks. Native runtime and workspace
lifecycle logs are separate signed-digest artifacts. The complete v2 report is
sealed after tests and generated-tree verification. Candidate/accepted tree
verification is read-only and returns `native-acceptance/v1` evidence.

### Repeated denied calls

The native runtime records each `tool.call`, `policy.decision` and denied
`tool.result` normally. Three consecutive identical denied calls then emit the
existing `error` and `turn.completed` failure events with code
`RUNTIME_REPEATED_DENIAL`. No denied tool executes. Different arguments or an
intervening tool attempt reset the streak; model call IDs and JSON object key
order do not. The optional `runtime.checkpoint.payload.deniedCallStreak` stores
only a SHA-256 fingerprint and count, so safe continuation preserves this bound.
Legacy checkpoints without the field start with no streak. This guard is a
terminal failure, not permission escalation or an automatic retry.

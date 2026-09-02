# ARCHITECTURE.md

The harness platform: a dogfooding system in which the agent builds
the harness that runs the agent. This document is the contract between
the packages; code that violates it is a bug.

## 1. Core idea

```
            ┌────────────────────────────────────────────────────┐
            │                     TASK MANIFEST                  │
            │  id · goal · acceptance · allowed_paths ·          │
            │  permissions · budget · delivery                   │
            └───────┬──────────────┬──────────────┬──────────────┘
                    │              │              │
              ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
              │  policy   │  │ scheduler │  │  UI / TUI │
              │  engine   │  │ (control- │  │  (ACP     │
              │  (pure)   │  │  plane)   │  │   client) │
              └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
                    │              │              │
                    └──────────────┼──────────────┘
                                   ▼
                          ┌─────────────────┐
                          │   agent-server  │  ACP (JSON-RPC over WS)
                          └────────┬────────┘
                                   ▼
                          ┌─────────────────┐
          bounded ─────▶  │      KERNEL     │  ──▶  events (typed stream)
          tools           │  goal+model+    │
                          │  tools+budget   │
                          └────────┬────────┘
                                   │ process tool
                                   ▼
                          ┌─────────────────┐
                          │ sandbox-runner  │  one hardened container
                          └─────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  artifacts · audit log ·      │
                    │  run reports · OpenTelemetry  │
                    └──────────────────────────────┘
```

**The kernel is pure-ish and local.** It takes
(goal, model, tools, budget) and produces an event stream + final text.
Everything around the kernel (servers, sandboxes, UIs) is replaceable
without touching it. That is the property the tests and evals exploit.

### M6 additive runtime contract

M6 begins the self-hosting kernel migration without replacing the proven M0
loop. `runAgent()` and `Model.complete()` remain supported while
`MinimalAgentRuntime` adds the caller-facing `AgentRuntime` contract and
`CompleteModelAdapter` bridges completion-only models to `ModelAdapter`.
The M6 implementation is deliberately one text-only model request; the
policy-gated multi-round tool loop remains M7 work.

The runtime owns model invocation, message/context state, event publication,
run cancellation and steering lifecycle, and the narrow persistence port. It
does not own policy decisions, workspace implementations, provider credentials,
scheduling, UI, or side-effect enforcement. M8 moved the operational
`Workspace` contract to `@harness/workspace`; the kernel re-exports that
canonical type instead of maintaining a second definition. A workspace is
never placed directly in model input; reviewed bounded tools are its only
callers.

`RunInput` requires caller-known `runId`, `sessionId`, and `turnId` values plus
an explicit model name because `ModelAdapter` intentionally has no provider
identity. Registering the run and snapshotting caller-owned input are
synchronous, so later mutation cannot redirect events and `steer()` or
`cancel()` can address the run before event consumption begins. One per-run
writer serializes every append. The runtime appends before queueing an event for
its single-use async iterator, and the producer crosses a model boundary or
pulls another model event only after the consumer advances. Store failure
poisons the writer, aborts the model, wakes the consumer with a typed error, and
prevents later boundaries. Completed runs are retained only as small identity
tombstones so duplicate or terminal controls stay typed without retaining
session context or adapters.

The small `EventStore` interface is a session-facing dependency-inversion view,
not an alternate database contract. Its production adapter is backed by
`SessionStore`/`EventLog`, which remain authoritative for sequence allocation,
stable-event-id idempotency, checkpoint CAS, and owner fencing. M6 tests use an
in-memory recording fake local to the test; the kernel package adds no durable
store implementation or dependency on `@harness/sessions`.

Early steering is appended before `steer()` returns. The same per-run writer
linearizes the steering queue with `model.request`: messages committed before
the request enter that context snapshot. Because M6 has exactly one request,
steering linearized after that boundary is rejected with a typed error instead
of being durably orphaned; a later multi-round milestone can reopen a next-turn
boundary. Cancel requests coalesce, re-canceling an already canceled run is a
no-op, and other unknown or terminal identities are typed errors.
Calling an iterator's `return()` or `throw()` is abandonment: the model is
aborted and `turn.completed(status=canceled)` is still persisted even though
that consumer cannot receive it. If the terminal append fails, cancellation or
abandonment rejects with the typed persistence error. Provider cancellation is
defined by the forwarded `AbortSignal`; iterator `return()` is invoked as
best-effort cleanup and does not delay the durable cancellation result. Merely
losing a JavaScript object cannot be observed and is not treated as a
cancellation signal.

### M8 workspace capability boundary

`@harness/workspace` owns the operational filesystem/process contract and its
typed operation dispatcher. It intentionally supplies no host implementation
yet: `LocalWorkspace` and `DockerWorkspace` remain M9 and M10 work. The older
`openWorkspace()` helper is retained as a lexical `WorkspacePathScope`, so a
path resolver cannot be mistaken for an operational capability.

Both kernel paths keep workspace identity separate from capability. The
streaming runtime receives `RunInput.workspace` as an operational object; the
legacy loop keeps `RunOptions.workspace` as string event metadata and accepts
`RunOptions.workspaceCapability` separately. The runtime snapshots bound
methods before execution, advertises a reviewed workspace tool only when a
capability was injected, and still durably records tool intent and the pure
policy decision before invoking it. Pure tools receive no workspace object;
workspace tools receive a frozen view that delegates only their declared
operation and rejects every other operation with a typed error. The caller
owns workspace disposal.

Model-facing tools declare a reviewed boundary and invoke only the injected
workspace object. Production sources under `packages/kernel` and
`packages/tools` are guarded by an offline AST fixture against direct
filesystem or child-process imports. Tests use deterministic fake workspaces;
host API adaptation remains confined to the workspace layer or an explicitly
trusted outer CLI/service boundary.

The M3 Agent Server still has only a string workspace identity. During M8 it
therefore rejects workspace-bound tools at session admission instead of
advertising an operation it cannot execute. M9 supplies the explicit local
adapter and its lifecycle wiring; there is no implicit host-filesystem
fallback in the interim.

## 2. Layers

### L1 — Contracts (packages/)
- `events` — the wire format. Fixed envelope, typed payloads, versioned.
- `sdk` — **task manifest in**; normal and early-preflight reports out.
- `policy` — pure decision functions over the manifest.
- `models`, `tools`, `sessions`, `workspace`, `mcp`, `acp` — protocols.

### L2 — Execution
- `kernel` — the agent loop (M0, done).
- `sandbox-runner` (M3, done) — container boundary for tool execution;
  enforces policy *decisions*, never makes them.

### L3 — Services
- `agent-server` (M3, done) — hosts exactly one kernel run per ACP session.
- `control-plane` (M4, done) — fenced scheduling, task/run state, artifact
  registry, audit export, and the production health/API boundary.

### L4 — Interfaces
- `cli` (M0) — `validate`, `run`, and `bootstrap` exit-gate surfaces.
- `tui` (M3, done) / `web` (M2+) — event clients; the TUI also resolves asks.

The CLI has one ordered execution contract. `run` resolves the canonical task
path, selects its exact existing task branch when one is already present,
validates the authoritative branch manifest (or validates before creating a
new branch), attests the Git base and HEAD, gates a stable sampled task delta,
runs the manifest-approved test command, gates the post-test delta, and writes
a report. Local mode must be attached to the exact task branch after selection;
a detached HEAD is accepted only by verified CI head-ref/head-SHA/base context.
`bootstrap` inserts a `TaskAgent`
builder before the test gate; its production adapter targets upstream Pi,
launched without a shell in offline-startup, non-interactive mode with a fixed
file-only tool set. Test commands are also parsed to one executable plus argv
and never use a shell. Tests inject a `TaskAgent` and exercise the production
streaming adapter with a spawned Pi-protocol fixture. They prove the harness
composition and adapter contract, not an installed Pi binary or live provider.

The snapshots preserve committed, staged, unstaged, ordinary untracked, and
non-operational ignored evidence. The canonical manifest is not exempt when it
is part of that delta: its exact path is checked by the same contract. Rename and
copy records retain both source and destination; all write-relevant paths are
checked against `allowed_paths`. Raw tracked bytes, path type, and executable
mode are checked independently of Git clean filters. Git repository, HEAD,
branch, manifest, per-worktree/common metadata, and scope are rechecked after
the builder and tests. `tasks/runs/**` is reserved for evidence regardless of
manifest scope. In pull-request CI the head branch chooses its matching
manifest, and `--ci-head-ref`, `--head-sha`, and `--base-ref` must be provided
as one trusted tuple.

## 3. Data & state

| Data              | M0–M3                            | M4+ |
| ----------------- | -------------------------------- | --- |
| sessions/events   | SQLite (file-local)              | Postgres (SQLite remains the offline/local adapter) |
| artifacts/reports | local directory + dev MinIO      | S3-compatible storage (reference deployment uses MinIO) |
| task state        | manifest files in Git            | Postgres runtime state + Git task definitions |
| observability     | OpenTelemetry collector / Jaeger | Same event-to-OTel bridge across scaled services |

Rules:
- Events are **append-only**; no UPDATE, ever.
- Reviewed manifests in Git are the organizational source of truth for
  dogfooded tasks. The control plane stores a validated snapshot plus run
  history; its HTTP API trusts the authenticated admission caller and does not
  independently prove Git provenance.
- Every evaluated policy gate emits `policy.decision`; the **audit log is the
  event log filtered**, not a separate store. Each atomically committed normal
  report contains exactly one matching `run.recorded` receipt. An uncommitted
  in-memory outcome deliberately contains none.
- A normal attempt produces attestable `run-report/v2`; legacy `run-report/v1`
  remains readable but cannot represent current gate evidence. A malformed-manifest or early-Git
  attempt, before a complete normal report can be trusted, produces the strict
  `run-preflight-report/v1` artifact instead.
- The durable SQLite session contains causal gate events. A report is written
  to a same-directory temporary file, synced, and atomically renamed; its
  report-local `run.recorded` event is the commit receipt. This prevents either
  SQLite or telemetry from claiming delivery of a missing report.
  `deliverables.reportWritten` is false only when even fallback storage failed
  and the CLI can return the validated artifact only in memory.
- New normal reports enforce coherent branch/Git identity, path violations,
  test and failure status, and report-commit receipt. `failure` is the primary
  compatibility field; `failures` is the ordered complete failure trail.

The scheduler is at-least-once and fenced. A queued run is claimed with a
secret lease ID and a monotonically increasing fencing token. PostgreSQL time
defines lease creation and expiry; replica wall clocks are audit timestamps,
not authority. Heartbeats, state transitions, and completion must present both
lease values; work from an expired lease can clean up locally but cannot alter
canonical state. Expiring a lease before a run starts safely requeues it.
Expiring one after execution starts marks it `indeterminate` until an operator
explicitly cancels it or creates a new fenced attempt.

Every control-plane mutation enqueues its typed event in the same transaction.
A retrying outbox publisher copies those events into the append-only session
store and acknowledges them only after the store accepts the stable event ID.
This gives the audit stream at-least-once delivery without making an API request
fail after its state mutation already committed.

Artifact bytes are content-addressed in object storage; Postgres stores the
database-enforced immutable registry row. Conditional-upload retries verify the
stored bytes, not caller-controlled metadata. Signed URLs are derived, expiring
capabilities and are never durable state. Audit export reads the redacted event
stream by a store-wide commit-ordered sequence, writes deterministic JSONL,
registers that object, and only then advances its checkpoint.

## 4. Protocols

- **ACP** (we own the shape in `packages/acp`): agent ↔ client,
  JSON-RPC over WebSocket, event streaming, permission negotiation.
  It is *our* protocol, deliberately small; we do not adopt a foreign
  agent protocol wholesale. M3 is WebSocket-first and does not advertise
  replay/resume. M4 restore is cursor-based replay of committed events. A
  session whose durable tail is terminal is closed as completed. Otherwise an
  expired owner lease is reconciled by atomically appending an interrupted
  restore marker and closing the session. The server does not reconstruct and
  repeat an uncertain model/tool turn.
- **MCP** (`packages/mcp`): model context / third-party tool servers.
  We are a client of MCP servers (tools arrive over MCP), not a server
  of our own protocol in disguise.
- **Harness events**: the canonical durable/audit vocabulary for observable
  state changes (see EVENTS.md). HTTP and ACP control envelopes remain their
  protocol-specific typed JSON; their committed state changes emit events.

## 5. Language strategy (deliberate constraint)

One language — TypeScript, Node ≥ 22, pnpm workspaces — remains the default for
L1–L4 through M5. Reference harnesses (Rust/Go/Python/TS polyglots) are evidence
of *where* complexity lives, not a mandate for *polyglotism*. A second runtime
may be introduced in M5 only when M3–M4 profiling supplies a hard, measured
reason, and requires:

1. a written profile showing the bottleneck (CPU-bound loop, kernel
   sandbox runtime, native crypto path…) with numbers,
2. a task manifest justifying the change,
3. a design note in this document defining the runtime boundary and measured
   justification,
4. review against `AGENTS.md`.

### M5 decision — retain TypeScript/Node

The M5 review found no qualifying M3–M4 profile, so the condition for a
second runtime was not met. The M3 provider and sandbox boundaries are tested
with injected HTTP and process executors, and the M4 Postgres and object-store
boundaries are tested with injected protocol fakes. Those tests establish
correctness while remaining offline; they do not measure production service
latency or attribute CPU time to a runtime bottleneck. Available exit-gate
durations likewise measure the whole test command, not an M3 or M4 component.

No repository-backed M3–M4 evidence defines a representative workload or SLO,
reports repeated latency percentiles or throughput, attributes CPU or memory
samples to a hot path, or compares runtimes. Absence of that evidence is not a
claim that Node is optimal; it means there is no measured basis for accepting
the operational and supply-chain cost of another runtime. L1–L4 therefore
remain TypeScript on Node ≥ 22, and M5 adds no runtime or service boundary.

Reopening this decision requires a new task manifest and a written,
reproducible profile that:

1. names the production-representative workload, environment, repetitions,
   target or SLO, and baseline,
2. reports relevant latency percentiles or throughput together with CPU and
   memory evidence that attributes the limiting hot path,
3. shows why I/O, an external dependency, data structure, or algorithm is not
   the actual constraint and records the Node-side remedies attempted, and
4. demonstrates that a specific second-runtime boundary materially improves
   the target after build, deployment, security, observability, and ownership
   costs are included.

That follow-up is reviewed against `AGENTS.md`; a reference implementation or
language preference alone remains insufficient evidence.

## 6. Failure model

- Kernel: budget exceeded → `budget_exceeded` stop + event trail (never
  hangs, never silently continues).
- Permissioning: `ask` pauses before execution; only a correlated explicit
  allow resumes. Missing resolver, denial, timeout, cancellation, or disconnect
  produces a denied tool result.
- Sandbox: policy is compiled before Docker starts; unsafe or unrepresentable
  path/network rules fail closed instead of being widened. The Docker daemon,
  selected image, and non-concurrent host workspace are trusted launch inputs.
- Event deserialization: JSON/version/type/payload failures are distinct typed
  errors. Version/type errors retain the decoded frame; a boundary that needs
  quarantine must retain the inbound bytes itself before calling the decoder.
- Policy: unknown action ⇒ `ask`; unknown subject without `*` ⇒
  closed by default for exec, ask for everything else.
- Runner: any gate failure (manifest/git/policy/builder/tests/evidence/report)
  ⇒ non-zero exit + structured evidence. Manifest and early-Git failures use
  `run-preflight-report/v1`; normal outcomes use `run-report/v2` with status
  `passed|failed|blocked`. A run either *passes with evidence* or *fails
  loudly*.
- Local exit-gate snapshots are repeatable samples, not an atomic filesystem
  snapshot. The installed Git executable, preflight object database and
  allow-listed mainish base commit, pre-existing repository configuration, and
  a non-concurrently-mutated host workspace are trusted inputs. Preventive
  isolation for untrusted work belongs to the Docker sandbox-runner.
- Scheduler: leases expire → requeue only pre-execution work; started work →
  `indeterminate`. Stale fencing tokens are typed conflicts.
- Restore: sequence gaps or future cursors are typed input errors. Session
  appends, lease renewal, and closure are owner-fenced; an expired process
  cannot resurrect its lease or finish after another replica reconciles it.
  Interrupted work is replayed as evidence and never automatically re-executed.

## 7. Testing & evaluation

- Unit: each package is self-contained (`packages/*/test`).
- Integration: the exit gate (`harness run`, including the gate used by
  `harness bootstrap`) IS the integration test for the harness itself.
- Evals (`evals/`): golden repos + scenarios assert on **events and
  reports**, never internals — so refactorings stay safe and regressions
  are about behavior, not structure.

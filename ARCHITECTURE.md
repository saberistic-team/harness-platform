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

## 2. Layers

### L1 — Contracts (packages/)
- `events` — the wire format. Fixed envelope, typed payloads, versioned.
- `sdk` — the two external contracts: **task manifest in**, **run report out**.
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
- `cli` (M0) — the exit gate + operator surface.
- `tui` (M3, done) / `web` (M2+) — event clients; the TUI also resolves asks.

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
- Every policy decision and every run is an event → the **audit log
  is the event log filtered**, not a separate store.

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

One language — TypeScript, Node ≥ 22, pnpm workspaces — for L1–L4 in
M0–M5. Reference harnesses (Rust/Go/Python/TS polyglots) are evidence
of *where* complexity lives, not a mandate for *polyglotism*. A second
runtime requires:

1. a written profile showing the bottleneck (CPU-bound loop, kernel
   sandbox runtime, native crypto path…) with numbers,
2. a task manifest justifying the change,
3. review against `AGENTS.md`.

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
- Runner: any gate failure (schema/git/policy/test) ⇒ non-zero exit +
  a structured report with status `failed|blocked`. A run either
  *passes with evidence* or *fails loudly*.
- Scheduler: leases expire → requeue only pre-execution work; started work →
  `indeterminate`. Stale fencing tokens are typed conflicts.
- Restore: sequence gaps or future cursors are typed input errors. Session
  appends, lease renewal, and closure are owner-fenced; an expired process
  cannot resurrect its lease or finish after another replica reconciles it.
  Interrupted work is replayed as evidence and never automatically re-executed.

## 7. Testing & evaluation

- Unit: each package is self-contained (`packages/*/test`).
- Integration: the exit gate (`harness run`) IS the integration test
  for the harness itself.
- Evals (`evals/`): golden repos + scenarios assert on **events and
  reports**, never internals — so refactorings stay safe and regressions
  are about behavior, not structure.

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
- `control-plane` (M4) — scheduling, state, artifact registry, audit.

### L4 — Interfaces
- `cli` (M0) — the exit gate + operator surface.
- `tui` (M3, done) / `web` (M2+) — event clients; the TUI also resolves asks.

## 3. Data & state

| Data              | M0–M2                 | M4+                        |
| ----------------- | --------------------- | -------------------------- |
| sessions/events   | SQLite (file-local, through M3) | Postgres (control-plane) |
| artifacts/reports | local dir + MinIO     | S3                         |
| task state        | manifest files in git | Postgres + git is truth    |
| observability     | OpenTelemetry (local collector / Jaeger) — from day 1 |

Rules:
- Events are **append-only**; no UPDATE, ever.
- The task manifest is the source of truth for a task; the control
  plane stores a *copy* plus run history.
- Every policy decision and every run is an event → the **audit log
  is the event log filtered**, not a separate store.

## 4. Protocols

- **ACP** (we own the shape in `packages/acp`): agent ↔ client,
  JSON-RPC over WebSocket, event streaming, permission negotiation.
  It is *our* protocol, deliberately small; we do not adopt a foreign
  agent protocol wholesale. M3 is WebSocket-first and does not advertise
  replay/resume; that stateful capability remains M4.
- **MCP** (`packages/mcp`): model context / third-party tool servers.
  We are a client of MCP servers (tools arrive over MCP), not a server
  of our own protocol in disguise.
- **Harness events**: our internal event vocabulary (see EVENTS.md).
  Anything that crosses a process boundary is an event.

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
- Event deserialization: version/type/payload are three distinct typed
  errors; unknown frames are quarantined with raw preserved.
- Policy: unknown action ⇒ `ask`; unknown subject without `*` ⇒
  closed by default for exec, ask for everything else.
- Runner: any gate failure (schema/git/policy/test) ⇒ non-zero exit +
  a structured report with status `failed|blocked`. A run either
  *passes with evidence* or *fails loudly*.

## 7. Testing & evaluation

- Unit: each package is self-contained (`packages/*/test`).
- Integration: the exit gate (`harness run`) IS the integration test
  for the harness itself.
- Evals (`evals/`): golden repos + scenarios assert on **events and
  reports**, never internals — so refactorings stay safe and regressions
  are about behavior, not structure.

# ROADMAP.md

## M0 — Foundation  ✅ (this commit)
- pnpm workspaces, TS strict, vitest across the board
- `packages/events` — schema, round-trip, typed error gates
- `packages/kernel` — agent loop, budgets, event emission
- `packages/models` — protocol + `FakeModel`
- `packages/policy` — pure decision engine
- `packages/sdk` — task manifest in, normal/preflight run reports out
- `packages/{tools,sessions,workspace,mcp,acp}` — protocol surfaces
- `apps/cli` — `harness validate | run | bootstrap` (the exit gate)
- `tasks/kernel-0001.yaml` — first dogfooded task contract
- `skills/platform-builder` — operational skill
- Infra: Docker dev image + compose (MinIO). No Kubernetes.

## M1 — Operator loop  ✅ (branch chain `tasks/m1-*`)
- CI: `pnpm test` + `pnpm typecheck` + `harness run tasks/kernel-0001.yaml`
  as a required gate on every PR (dogfooding begins here)
  → `tasks/m1-ci-gate`, workflow in `.github/workflows/ci.yaml`
- Exit-gate hardening: manifest-derived `tasks/<id>` identity, trusted CI
  head/base tuple, committed/staged/unstaged/untracked/non-operational-ignored
  evidence, raw byte/type/mode checks, Git environment and metadata attestation,
  rename/copy endpoints, immutable manifest checkpoints, reserved evidence,
  post-test scope recheck, test process-group cleanup, and failure-safe atomic
  reports. Structural host-process and snapshot limits are documented in
  `SECURITY.md`
  → `tasks/m0-exit-gate-hardening`
- Bootstrap: manifest → exact branch identity → TaskAgent → pre/post-test gate →
  structured report. The production adapter targets upstream Pi with
  offline-startup/non-interactive operation and a shell-free file-only tool set;
  CI uses an injected builder and a spawned Pi-protocol fixture to exercise the
  streaming adapter, not the installed Pi binary or a live model provider
  → `tasks/m0-exit-gate-hardening`
- PR CI chooses the branch-matching task manifest and supplies
  `--ci-head-ref`, `--head-sha`, and `--base-ref` together
  → `tasks/m0-exit-gate-hardening`
- `apps/tui`: read-only session/event viewer
  → `tasks/m1-tui-viewer` (`harness-view list|show|report`)
- `evals/scenarios` runner + first scenario against the golden kernel
  → `tasks/m1-eval-scenarios` (`pnpm evals`, scenario `kernel-0001-golden`)
- SQLite persistence for session logs (`packages/sessions`)
  → `tasks/m1-sessions-sqlite` (node:sqlite, no new native deps)
- Run report: `deliverables.pullRequest` URL when CI provides it
  → `tasks/m1-ci-gate` (`HARNESS_PULL_REQUEST_URL` / `--pr-url`)
- `SECURITY.md` open question: exec egress pattern → rule compiler
  → `tasks/m1-exec-rules` (`compileRules()` in `@harness/policy`)

## M2 — Eval credibility  ✅ (branch chain `tasks/m2-*`)
- `evals/golden-repositories/hello-service` — first calibration target
  → `tasks/m2-golden-hello-service`
- Scenario DSL validation in `@harness/sdk` (YAML → invariants)
  → `tasks/m2-scenario-dsl`
- `apps/web`: minimal task board (manifests + reports, no real-time)
  → `tasks/m2-web-task-board`
- OpenTelemetry wiring end-to-end (kernel → CLI → local collector)
  → `tasks/m2-otel`
- `packages/mcp`: initialize-era live stdio client, with one locked official
  reference server in scheduled/manual CI (never the default lane)
  → `tasks/m2-mcp-stdio`

The M2 MCP adapter negotiates revisions through `2025-11-25`. The stateless
discovery lifecycle introduced by MCP `2026-07-28` is a future compatibility
adapter, not a silent behavior change to this client.

## M3 — Services  ✅ (`tasks/m3-services`)
- `services/agent-server`: ACP server over WS; one kernel run per session
- `services/sandbox-runner`: Docker-per-run, policy-enforced boundaries,
  fs mounts scoped by `allowed_paths`, network namespace default-deny
- Provider model adapter (OpenAI-compatible) behind `packages/models`
- `apps/tui`: interactive; permission `ask` flows

M3 keeps live-provider and live-Docker checks out of the default lane. The
provider adapter is tested with injected HTTP responses; the sandbox runner is
tested through an injected argv-only executor. ACP WebSocket integration is
local-only and uses the same typed harness event stream as persisted sessions.
Session replay/resume remains M4 work; the M3 server advertises that capability
as unavailable.

The server binds only to loopback by default. A non-loopback listener requires
both bearer-token authentication and an explicit plaintext-remote opt-in; the
supported deployment shape is a TLS reverse proxy with clients using `wss://`.
Sandbox images are immutable digest references unless a reviewed local image is
explicitly trusted for development.

## M4 — Control plane & scale  ✅ (`tasks/m4-control-plane`)
- `services/control-plane`: idempotent task admission, fenced scheduling,
  operator cancellation/reconciliation, transactional event outbox, and
  immutable artifact registry
- Postgres for shared sessions/events and task/run state; S3-compatible object
  storage (MinIO in the reference deployment) for content-addressed artifacts
- Automatic redacted audit export from the commit-ordered event stream to
  deterministic JSONL objects; bounded signed download URLs
- `infra/kubernetes/` is the production service topology, with default-deny
  networking, persistent reference stores, health checks, and resource bounds;
  Docker Compose remains a local-development aid
- Cursor-based, lease-fenced ACP restore replays only committed events and
  records an interrupted outcome without repeating an uncertain model/tool turn

The Kubernetes sandbox Job is a suspended deployment contract in M4. The base
does not grant Kubernetes API credentials or materialize Jobs; a future executor
overlay must add that privilege together with workspace staging and policy-safe
template substitution.

## M5 — Polyglot review (conditional)  ✅ (`tasks/m5-polyglot-review`)
- The repository-backed M3–M4 evidence contains correctness gates and
  observability seams, but no component profile that attributes a hard
  bottleneck to the Node runtime. Whole-suite test duration is not such a
  profile.
- Decision: retain TypeScript / Node ≥ 22 as the only runtime. No second runtime
  or service boundary is added.
- The decision can be reopened only by a new manifest and a reproducible,
  numeric profile meeting the language-strategy criteria in `ARCHITECTURE.md`.

The M6–M12 sequence below is dependency ordered. M6 and M7 are complete;
M8–M12 remain planned. This roadmap amendment is tracked by
`tasks/m6-minimal-kernel-roadmap`; each implementation milestone uses its own
manifest, `tasks/<id>` branch, and PR. The roadmap manifest is not reused for
implementation.

## M6 — Runtime contracts and event vocabulary (complete)

Delivered by `tasks/m6-kernel-contracts`.

Build the Pi-like minimal kernel contract. This is the first platform
component that must ultimately become self-hosting. The kernel owns only:

- model invocation
- message and context state
- the tool-call loop
- event emission
- cancellation
- steering messages
- context compaction
- session-persistence interfaces

Policy remains a pure injected decision, workspaces and stores remain injected
ports, and scheduling, UI, provider credentials, and side-effect enforcement
remain outside the kernel.

The target-facing minimal interfaces are:

```ts
export interface AgentRuntime {
  run(input: RunInput): AsyncIterable<AgentEvent>;
  steer(runId: string, message: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(context: ToolContext, input: unknown): Promise<ToolResult>;
}

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  readSession(sessionId: string): AsyncIterable<AgentEvent>;
}

export interface Workspace {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  listFiles(path: string): Promise<string[]>;
  execute(command: CommandRequest): Promise<CommandResult>;
  diff(): Promise<string>;
  snapshot(): Promise<WorkspaceSnapshot>;
  dispose(): Promise<void>;
}
```

These are compatibility targets, not permission to fork the existing
contracts. `AgentEvent` uses the harness event envelope; `EventStore` is a
session-bound view backed by the richer `SessionStore`; operational workspace
methods are exposed only through bounded tools; and adapters preserve current
`runAgent`, `Model.complete`, `Tool`, and `SessionStore` callers during the
migration. `RunInput` carries caller-known `runId`, `sessionId`, and `turnId`
values so callers can steer or cancel before consuming the first event.

Events come first. Reuse `tool.call`, `policy.decision`, and `tool.result` for
the requested-intent, decided-policy, and completed-tool semantics rather than
creating synonymous event dialects. Add genuinely missing turn, message,
steering, and compaction types to `packages/events` before kernel producers or
consumers. Events are durably appended before they are yielded; append failure
fails closed. Iterator abandonment has defined cancellation semantics,
`steer()` returns only after its message is durable, unknown or terminal run
IDs are typed errors, and `cancel()` is idempotent.

Tests use an additive deterministic streaming fake model. They cover stable
event serialization, typed unknown input, stream ordering and backpressure,
append-before-yield behavior, and compatibility with one text-only legacy
model turn.

**M6 gate:** a deterministic, no-tool turn is persisted and streamed in one
exact sequence, the new contracts typecheck, and existing public APIs and
offline tests remain green.

## M7 — Deterministic minimal session loop (complete)

Delivered by `tasks/m7-deterministic-session-loop`.

Implement model streaming, versioned message/context state, text aggregation,
multiple tool-call rounds, strict tool-argument validation, hard budgets,
cooperative cancellation, and model timeouts. Use only fake or pure tools in
this milestone.

The canonical valid-tool path is:

```text
User input
  ↓
Persist turn.started
  ↓
Build model context
  ↓
Persist model.request, then call the model
  ↓
Model emits text or a tool intention
  ↓
Persist tool.call (the requested intent)
  ↓
Compute the pure policy decision
  ↓
Persist policy.decision and any permission resolution
  ↓
Execute the tool
  ↓
Persist tool.result
  ↓
Return the observation to the model and repeat as needed
  ↓
Persist turn.completed
```

`agent.started` and `agent.stopped` bookend the run. Invalid or unknown tool
input follows a typed, no-side-effect error path; authorization is derived only
after arguments validate. Most importantly, the tool intent and allow/ask/deny
decision must both be durably appended before any side effect. If either append
fails, the tool does not execute.

Tests cover multiple tool rounds, invalid arguments, unknown tools, tool
failure, malformed model streams, cancellation while waiting on the model,
permission, or tool, model timeout, hard step/token/tool budgets, persistence
failure, and exactly one terminal outcome.

**M7 gate:** `AgentRuntime.run()` completes a multi-round FakeModel task with
the exact event order, and cancellation or timeout leaves no leaked work.

## M8 — Bounded workspace and five initial tools (planned)

Expose exactly these model capabilities:

- `fs.read`
- `fs.list`
- `fs.write`
- `process.exec`
- `git.diff`

Canonical dotted names remain the policy and audit identifiers. A provider
adapter may map them to provider-safe function names, but aliases never enter
policy or persisted events. File access remains escape-, symlink-, hard-link-,
and race-safe; writes stay inside `allowed_paths`; process execution is
argv-only without a shell and has output, time, and cancellation bounds; diffs
and snapshots are bounded. The operational `Workspace` is an injected
capability facade and can be reached only through the persisted-policy tool
loop.

Tests cover traversal and link attacks, invalid input, out-of-scope writes,
allow/ask/deny, bounded and atomic writes, no-shell execution, timeout and
cancellation, bounded diffs, cleanup, and a deterministic fixture edit/test/diff
round trip.

**M8 gate:** FakeModel edits only an allowed fixture, runs its tests, and
returns a bounded diff using the five tools; every out-of-scope attempt has no
effect and leaves typed evidence.

## M9 — Steering, follow-ups, and context compaction (planned)

Add the active-run registry behind `AgentRuntime`. Steering messages are
persisted FIFO and incorporated only at the next safe model-request boundary,
never spliced into an in-flight request. A follow-up is a new turn on the same
durable session. Define cancellation-versus-steering ordering and preserve one
terminal outcome.

Context-window accounting is separate from the cumulative token budget.
Compaction retains the append-only original history, persists its summary and
tail checkpoint, emits compaction evidence, and charges any model usage to the
budget. If compacted context still cannot fit, the run stops with a typed
context-overflow error.

Tests cover steering before and during model/tool phases, concurrent steering
order, follow-up turns, cancel-versus-steer races, compaction thresholds and
summary fidelity, compaction failure, and context overflow.

**M9 gate:** a long deterministic session compacts, accepts a steering message
at the defined boundary, and completes a follow-up without losing or reordering
message state.

## M10 — Durable replay and restart-safe continuation (planned)

Back the minimal persistence port with the existing SQLite/Postgres
`SessionStore` semantics: stable event IDs, per-session sequence cursors,
idempotent identical delivery, typed conflicting duplicates, checkpoint CAS,
and owner fencing. A versioned checkpoint contains enough message, model,
usage, tool-loop, steering, and compaction state to reconstruct the next model
request.

Extend M4 recovery with an explicit fenced continuation (or continuation-run)
primitive for a committed safe checkpoint. Preserve M4's conservative rule for
uncertain work: if a process may have completed a model or tool side effect
without persisting its result, mark that segment interrupted/indeterminate and
never execute it again automatically.

Tests inject crashes around every model, intent, decision, side-effect, result,
and checkpoint boundary. They cover session replay, duplicate event delivery,
SQLite close/reopen, checkpoint conflict and future-version errors, safe resume
after process restart, and non-repetition of uncertain effects.

**M10 gate:** after restart, the runtime reconstructs the same next model
request from the last committed safe checkpoint, continues once, and never
duplicates an event or side effect.

## M11 — Kernel-backed self-host runner (planned)

Integrate the new runtime as a TaskAgent path behind the existing exit gate.
The trusted CLI still validates the canonical manifest, creates or selects the
exact `tasks/<id>` branch, runs pre/post `allowed_paths` gates and tests, and
writes the report. Branch creation is not a sixth kernel tool. The kernel uses
only the M8 tools to edit, test, and return a diff.

All default coverage remains deterministic and offline. A FakeModel
integration runs in a temporary clean repository and proves branch identity,
scoped changes, tests, diff/report generation, deliberate safe restart, and
session continuation without invoking upstream Pi.

**M11 gate:** the kernel-backed runner completes a small tested fixture change
from a clean checkout, survives a safe-boundary restart, and produces a passing
run report with a reviewable diff.

## M12 — First live self-hosted `/doctor` change (planned)

Run the kernel-backed path with a real model and ask it to add `/doctor` to its
own CLI. At the existing argv boundary the command is spelled `harness doctor`;
an interactive `/doctor` alias is added only if slash-command syntax is
deliberately introduced. The command reports:

- kernel version
- model provider
- workspace type
- policy profile
- event-store health
- repository status
- available tools

This dogfood run gets its own manifest, branch, PR, and evidence. From a clean
checkout, the exit-gate CLI creates/selects the task branch, the kernel
implements and tests the command, a deliberate safe-boundary restart proves
continuation, and the run returns a bounded diff and report. A human reviews
and merges it; the kernel does not push or merge. The live-provider proof is a
manual, credentialed lane, while CI continues to use FakeModel with no network.

**M12 / program exit gate:** without upstream Pi on this execution path, the
new kernel can complete a small tested change in its own repository from a
clean checkout, resume the same logical session after restart without
duplicating uncertain work, and return evidence suitable for human review.

## Explicit non-goals (M0–M12)
- No microservice decomposition of the kernel (it is a library)
- No Rust/Go/Python services just because a reference uses them
- No custom web framework before `apps/web` v0.1 is actually used
- No K8s before the control plane exists and we have >2 long-lived
  containers that need to be scheduled
- No browser automation, GitHub, deployment, secret, database, subagent, or
  arbitrary MCP capability is exposed to the M6–M12 kernel runtime. Existing
  platform services remain outside its five-tool surface.
- No autonomous push or merge in the first self-hosted task

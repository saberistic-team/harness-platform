# ROADMAP.md

## M0 — Foundation  ✅ (this commit)
- pnpm workspaces, TS strict, vitest across the board
- `packages/events` — schema, round-trip, typed error gates
- `packages/kernel` — agent loop, budgets, event emission
- `packages/models` — protocol + `FakeModel`
- `packages/policy` — pure decision engine
- `packages/sdk` — task manifest in, normal/preflight run reports out
- `packages/{tools,sessions,workspace,mcp,acp}` — protocol surfaces at
  deliberately different maturity levels: `workspace` is still a lexical
  path-scoping seed and `tools` does not yet contain the five native
  development capabilities
- `apps/cli` — `harness validate | run | bootstrap` (the exit gate)
- `tasks/kernel-0001.yaml` — first dogfooded task contract
- `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, and `EVENTS.md` — initial
  governance, architecture decisions, boundary model, and event reference;
  decisions are recorded in these versioned documents rather than a separate
  ADR directory
- `skills/platform-builder` — initial operating guidance; its historical
  `run-report/v1` wording is now legacy and is explicitly refreshed in M16
- Infra: Docker dev image + compose (MinIO). No Kubernetes.

## M1 — Operator loop  ✅ (branch chain `tasks/m1-*`)
- CI: `pnpm test` + `pnpm typecheck` + evals on pushes and pull requests;
  pull requests additionally run `harness run` against the manifest selected
  by the exact `tasks/<id>` head branch. The `gate` job is designed to be made
  required by repository branch protection; that external setting is not
  claimed as repository-contained evidence
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

M1 begins governance dogfooding: the platform validates its own task, branch,
scope, tests, and report contracts. `harness run` verifies changes that already
exist; only `bootstrap` invokes a builder, and its production builder is still
upstream Pi. Native source authorship does not begin until the live milestone
below.
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
- OpenTelemetry wiring through kernel, CLI, and evals, plus local collector
  configuration; deterministic tests exercise injected sinks rather than
  claiming a live production collector deployment
  → `tasks/m2-otel`
- `packages/mcp`: initialize-era live stdio client, with one locked official
  reference server in scheduled/manual CI (never the default lane)
  → `tasks/m2-mcp-stdio`

The M2 MCP adapter negotiates revisions through `2025-11-25`. The stateless
discovery lifecycle introduced by MCP `2026-07-28` is a future compatibility
adapter, not a silent behavior change to this client.

## M3 — Service and isolation seams  ✅ (`tasks/m3-services`)
- `services/agent-server`: harness-specific `harness/acp/1` JSON-RPC over
  WebSocket; one legacy kernel run per session. It is an ACP-shaped
  compatibility seam, not yet the official ACP stdio adapter
- `services/sandbox-runner`: optional Docker-per-run, policy-enforced boundary,
  fs mounts scoped by `allowed_paths`, network namespace default-deny. It is
  not yet a `DockerWorkspace`, the platform-development default, or a
  control-plane-dispatched executor
- Provider model adapter (OpenAI-compatible) behind `packages/models`
- `apps/tui`: interactive; permission `ask` flows

M3 keeps live-provider and live-Docker checks out of the default lane. The
provider adapter is tested with injected HTTP responses; the sandbox runner is
tested through an injected argv-only executor. Deterministic ACP WebSocket
integration tests are loopback-only and use the same typed harness event stream
as persisted sessions. Session replay/resume remains M4 work; the M3 server
advertises that capability as unavailable.

The server binds only to loopback by default. A non-loopback listener requires
both bearer-token authentication and an explicit plaintext-remote opt-in; the
supported deployment shape is a TLS reverse proxy with clients using `wss://`.
Sandbox images are immutable digest references unless a reviewed local image is
explicitly trusted for development. The M3 service still calls the legacy
`runAgent`/`Model.complete` path and exposes an optional `sandbox_exec`; later
milestones converge it onto `MinimalAgentRuntime`, the operational Workspace
contract, and the five canonical native tools.

## M4 — Control-plane domain and deployment contracts  ✅ (`tasks/m4-control-plane`)
- `services/control-plane`: idempotent task admission, fenced scheduling,
  operator cancellation/reconciliation, transactional event outbox, and
  immutable artifact registry
- Postgres for shared sessions/events and task/run state; S3-compatible object
  storage (MinIO in the reference deployment) for content-addressed artifacts
- Automatic redacted audit export from the commit-ordered event stream to
  deterministic JSONL objects; bounded signed download URLs
- `infra/kubernetes/` is a production-shaped, fail-closed Kustomize contract
  with default-deny networking, persistent reference stores, health checks,
  resource bounds, invalid image/storage placeholders, and a suspended sandbox
  Job template. It is not yet a deployable executor or demonstrated scaled
  environment; Docker Compose remains a local-development aid
- Cursor-based, lease-fenced ACP restore replays only committed events and
  records an interrupted outcome without repeating an uncertain model/tool turn

The Kubernetes sandbox Job is a suspended deployment contract in M4. The base
does not grant Kubernetes API credentials or materialize Jobs; a future executor
overlay must add that privilege together with workspace staging and policy-safe
template substitution.

M4's Postgres and S3-compatible implementations have deterministic adapter
tests, but no worker manager yet dispatches the Agent Server or sandbox runner,
and the checked-in Compose stack is not a complete control-plane integration.

## M5 — Language decision review (conditional)  ✅ (`tasks/m5-polyglot-review`)
- The repository-backed M3–M4 evidence contains correctness gates and
  observability seams, but no component profile that attributes a hard
  bottleneck to the Node runtime. Whole-suite test duration is not such a
  profile.
- Decision: retain TypeScript / Node ≥ 22 as the only runtime. No second runtime
  or service boundary is added.
- The decision can be reopened only by a new manifest and a reproducible,
  numeric profile meeting the language-strategy criteria in `ARCHITECTURE.md`.

The M6–M76 sequence below is dependency ordered. M6 and M7 are complete;
M8–M76 remain planned. `tasks/m6-minimal-kernel-roadmap` records the earlier
M6–M12 plan; `tasks/m8-platform-roadmap-decomposition` replaces only its
unimplemented portion with the smaller milestones below. Each implementation
milestone uses its own manifest, `tasks/<id>` branch, PR, tests, exit-gate
report, and milestone-specific proof. Neither roadmap manifest is reused for
implementation.

### Final planning audit: code reality and deliberate substitutions

This sequence was reconciled against the implemented repository and the full
platform plan, not written as a greenfield wish list:

- M6–M7 provide the deterministic `MinimalAgentRuntime`, but no CLI or service
  uses it as the production authoring path yet. M16 converges the existing
  TaskAgent exit-gate seam onto that runtime; M43 later migrates the M3 service.
- `packages/workspace` is currently a lexical resolver, while
  `packages/tools` contains one host `read_file`, pure fixtures, and the M3
  `sandbox_exec` seam. M8–M11 introduce the operational Workspace family and
  the five canonical development tools rather than relabeling those seeds.
- SQLite and Postgres already provide append-only events, stable-ID
  idempotency, checkpoint CAS, and owner fencing. M14 wires the runtime's
  `EventStore` port to them. There will not be a third authoritative JSONL
  database: M26 provides versioned JSONL portability and audit export while
  SQLite/Postgres remain authoritative.
- M2–M4 already contain OpenTelemetry wiring, an initialize-era MCP stdio
  client, a harness-specific ACP-shaped WebSocket service, a strong optional
  Docker runner, durable control-plane primitives, a read-only web board, and
  fail-closed Kubernetes manifests. The planned milestones extend, converge,
  and activate these seams; they do not create parallel event, policy,
  session, workspace, or protocol domains.
- The prior plan exposed model/profile selection without first defining the
  registry lifecycle and referred to generic budgets without a monetary cost
  contract. M23 and M52 now make those dependencies explicit.
- The Kubernetes base is a suspended contract, not evidence of an operating
  executor. M55–M58 materialize it only after Docker and control-plane paths
  qualify, including the trusted/untrusted node boundary, database-access
  boundary, and an explicit measured decision about warm capacity.

The default test lane remains deterministic and offline. Live Docker,
provider, MCP, ACP, Postgres, Compose, registry, external-service, deployment,
and Kubernetes conformance runs use injected fixtures in default tests and
explicit credentialed scheduled/manual lanes for the live proofs that cannot
be made offline.

| Range | Program outcome |
| --- | --- |
| M8–M18 | Isolated native self-hosting with verifiable authorship |
| M19–M31 | Effect policy, separated duties, durable sessions, and SDK-only clients |
| M32–M42 | Versioned MCP delivery and ACP interoperability without policy bypass |
| M43–M49 | Recoverable remote execution behind a stable Docker executor |
| M50–M54 | Complete Docker control-plane admission, metering, and self-hosting |
| M55–M58 | Kubernetes execution, isolation, production topology, and activation |
| M59–M66 | Constrained, reversible, provenance-complete self-release |
| M67–M71 | SDK-only Canvas for live work, operations, evaluation, and release |
| M72–M76 | Canonical automation ingress and full self-building release rehearsal |

### Traceability to the original 24-step build order

| Original step | Final milestone ownership |
| --- | --- |
| 01 Repository, architecture decisions, `AGENTS.md`, task schema | M0; M5 records the later language decision |
| 02 Typed agent events | M0 and M6 |
| 03 Append-only event storage | M1/M4 stores, M14 runtime adapter, M26 JSONL portability |
| 04 Deterministic fake model | M0 and M6–M7 |
| 05 Minimal model/tool loop | M0 and M7 |
| 06 Workspace interface | M8 |
| 07 `LocalWorkspace` | M9 |
| 08 `DockerWorkspace` | M10 |
| 09 Five development tools | M11 |
| 10 CLI run command | M0–M1 exit gate, M16 native authoring integration |
| 11 Self-built doctor command | M18 |
| 12 Permission engine | M19–M21 |
| 13 Plan/Build/Review profiles | M22 and M25; Release arrives at M63 |
| 14 Headless session server | M23–M27 |
| 15 WebSocket event stream | M28 |
| 16 Generated SDK | M29–M31 |
| 17 MCP client/adapters | M32–M38 |
| 18 ACP server adapter | M40 |
| 19 ACP client/provider adapter | M39 and M41–M42 |
| 20 Remote Agent Server | M43–M49 |
| 21 Docker control plane | M46–M54 |
| 22 Kubernetes executor | M55–M58 |
| 23 Canvas | M67–M71 |
| 24 Self-release automation | M59–M66 and M72–M76 |

## Progressive self-hosting ratchet

M16 integrates the native path offline, M17 proves its authorship attestation,
and M18 is the live cutover. Once M18 passes, self-hosting is a program
invariant rather than an occasional demonstration. For every implementation
milestone M19–M76, the latest qualified platform revision must perform the
source changes for the next milestone from a clean checkout, using its
canonical task manifest and required isolated workspace. The builder identity
is fixed for the run. Candidate code may be exercised by its own milestone
gate, but it does not become a trusted builder path until the candidate fully
qualifies. In shorthand, qualified platform N builds candidate N+1; a
candidate's clean self-build is comparison evidence, not authority to act as
its own builder.

For this rule, a clean checkout means the accepted base revision has no source
or implementation delta. The new human- or policy-approved `tasks/<id>.yaml`
may be mounted or overlaid as the sole pre-builder repository change and
immutable control input. Its path, bytes, and digest are attested before the
run, it is included in the eventual PR, and the builder cannot edit it. It is
not treated as a pre-authored implementation patch. After M25, any
implementation plan is produced inside the governed Planner session rather
than injected beside the manifest.

The manifest, initial prompt, approval messages, and steering may state intent,
constraints, target interfaces, reviewer findings, and acceptance criteria.
They may not contain ready-to-apply source, a diff, an encoded patch, or other
implementation text that would make the live builder a patch applicator rather
than the author. A finding that requires code changes returns to a new or
continued qualified native run.

A qualified builder is an immutable revision or image that passed both its
milestone-specific gate and this inherited ratchet, was independently verified,
and was human-accepted: merged for development milestones, successfully
promoted for the one-time M65 release bootstrap, and successfully promoted for
M66 and later release-path milestones. Except for the M18 bootstrap
qualification, its implementation patch was authored by the prior qualified
builder. A passing branch, unmerged patch, rejected candidate, or rolled-back
release is evidence but never a qualified builder.

Qualification also requires the accepted merge tree or promoted source/image
to match the attested candidate output. A clean merge may match the candidate
tree directly; a squash or rebase must prove exact patch equivalence on the
attested base. Human merge edits, conflict-resolution edits, or a changed
promotion input invalidate authorship evidence and return the change to the
prior qualified builder for a new run.

Whenever a later milestone says that passing qualifies a path or makes it
mandatory, “passing” means this full qualification—including independent
verification and human acceptance—not merely a successful test process.

The human may define or approve the task, prompt or steer the run, answer
scoped approvals, review the result, and merge it. The trusted outer exit gate
and CI may validate the manifest, prepare the exact task branch and clean base,
provision the already-qualified builder and isolation boundary, broker
explicitly approved credentials, stream committed events, independently rerun
tests, typecheck, and path gates, and export the patch, artifacts, and report.
Neither the human nor the outer gate may inject source edits or a pre-authored
patch; steering may clarify intent, answer a question, or stop the run, but may
not supply implementation text. The outer gate may not invoke upstream Pi or
another coding agent, bypass the public session and policy path, replay an
uncertain effect, or substitute a less-governed workspace, server, API, or
executor. A deterministic fixture proves mechanics but cannot replace the
live-model self-hosted run that actually authored the milestone patch.

Every M19–M39 source-authoring run attests `MinimalAgentRuntime` through the
qualified native CLI or SDK path; candidate M39 provider code is not trusted to
author itself. After M39 qualifies the provider boundary, every M40–M76
authoring run uses and attests that same native runtime through
`NativeHarnessProvider`. `AcpHarnessProvider`, OpenCode, Goose, and other ACP
agents are compatibility and evaluation targets only; they cannot author a
roadmap milestone patch even when they run behind the same qualified SDK,
server, workspace, or executor path.

The required builder path ratchets only after the prior gate qualifies it:

- M19–M30: the latest qualified revision uses the native-kernel-in-Docker path
  first qualified by M18 and is coordinated by the trusted exit-gate CLI. M30
  may exercise its candidate CLI/CI cutover with the accepted M29 SDK under
  independent control, but only against a disposable fixture; candidate M30
  code cannot author or accept its own implementation.
- M31–M44: the latest qualified revision uses the public SDK path first
  qualified by M30. After M38, issue, evidence, exact remote commit, and PR
  delivery use the qualified constrained MCP path; a human still merges.
- M45: the latest qualified M44 revision uses its already-delivered remote
  Agent Server to author a named activation change. Acceptance qualifies that
  remote path for subsequent milestones.
- M46–M53: the latest qualified revision uses the remote Agent Server path
  first qualified by M45. It performs every implementation-time source edit
  and task-requested test in Docker; the local client only submits, streams,
  approves, and retrieves evidence. Independent CI still reruns verification.
- M54: the latest qualified M53 revision uses its already-delivered Compose
  path to author a named activation change. Acceptance qualifies
  control-plane admission for subsequent milestones.
- M55–M58: the latest qualified revision uses the Docker control-plane path
  first qualified by M54; clients do not launch an Agent Server directly. M58
  activates the accepted Kubernetes path with a named self-hosted change.
- M59–M66: the latest qualified revision uses the Kubernetes executor path
  first qualified by M58. Docker and local modes remain development aids but
  cannot satisfy the milestone gate. After M59, its constrained tools are the
  only permitted staging-mutation path.
- M67–M76: the latest qualified released platform uses the governed release
  path first fully qualified by M66 to build its immutable successor and carry
  it through staging, independent verification, approval, canary, and
  promotion or rollback. M72 canonical ingress is mandatory for M73–M76, and
  M74 unattended-run semantics are mandatory for every M75 adapter.

Only a merged, independently verified, and—where release applies—successfully
promoted candidate becomes the builder for the following milestone. A rejected
or rolled-back candidate never advances the chain; the prior qualified builder
authors the next attempt again.

Within those ranges, a newly qualified governance layer also becomes mandatory
on the next applicable milestone: role-separated workflow after M25, the
public SDK after M30, the secrets broker after M35, constrained external
delivery after M38, the native provider boundary after M39, remote execution after
M45, `DockerExecutor` after M47, hard usage/cost budgets after M52,
control-plane admission after M54, Kubernetes execution after M58, constrained
staging mutation after M59, the trusted image-build boundary after M60, the
first release builder after M65, the full governed release path after M66,
canonical trigger ingress after M72, and unattended automation semantics after
M74. A candidate capability may be
exercised under independent control by its qualification gate, but it may not
author the patch that introduces it or be the sole authority accepting itself.

Every M19–M76 milestone-specific gate is necessary but not sufficient: it also
inherits this ratchet. Its report and PR evidence must bind the qualified
builder source revision and, whenever image-backed, its immutable image digest;
the input base SHA and clean snapshot; manifest identity and digest;
session/run and event-log identity; actual client/server/workspace/executor
path; model/tool/protocol versions; policy decisions and approvals; post-run
tree, diff, and artifact hashes; pre/post scope checks; tests, typecheck,
exit-gate result; the exact `MinimalAgentRuntime`/TaskAgent entrypoint for
M19–M39 and, from M40 onward, `NativeHarnessProvider` identity; and fallback
status. Before
qualification, PR and CI evidence must bind the generated tree/diff hash to the
candidate head/tree and then to the human-accepted merge tree or promoted
image. Evidence requirements may become stronger as the schema evolves but may
not weaken; fallback status must be `none` for a passing milestone.
Deterministic CI evidence supplements rather than substitutes for the
live-model run that authored the patch.

If the required self-host path is unavailable or lacks a capability, the run
fails with a typed, evidenced outcome. There is no automatic fallback to a path
less governed than the one required for that milestone, including—once
superseded—Pi, `LocalWorkspace`, internal client calls, direct or local Agent
Server launch, Docker, or an earlier executor. An emergency break-glass action
may only repair operational state, restore credentials/infrastructure, or roll
back to the last qualified revision; it may not change platform source. It uses
a separate, explicitly approved manifest, is recorded as non-self-hosted, and
cannot satisfy a roadmap milestone. Any source fix and the affected milestone
must be authored again by the last qualified builder through the restored
required path.

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

Policy remains a pure injected decision and `EventStore` is an injected port.
The M6 `Workspace` shape is a compatibility target only: operational
workspace injection and tool integration begin in M8. Scheduling, UI, provider
credentials, and side-effect enforcement remain outside the kernel.

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
contracts. `AgentEvent` uses the harness event envelope. `EventStore` is
currently an injected port exercised by deterministic in-memory test stores;
M14 must deliver its session-bound adapter over the richer `SessionStore`.
Operational workspace methods are exposed only through bounded tools, and
adapters preserve current `runAgent`, `Model.complete`, `Tool`, and
`SessionStore` callers during the migration. `RunInput` carries caller-known
`runId`, `sessionId`, and `turnId` values so callers can steer or cancel before
consuming the first event.

Events come first. Reuse `tool.call`, `policy.decision`, and `tool.result` for
the requested-intent, decided-policy, and completed-tool semantics rather than
creating synonymous event dialects. Add genuinely missing turn, message,
steering, and compaction types to `packages/events` before kernel producers or
consumers. The runtime awaits the injected `EventStore` append before yielding;
append failure fails closed. M14 supplies the durable production adapter.
Iterator abandonment has defined cancellation semantics, `steer()` returns
only after its message append succeeds, unknown or terminal run IDs are typed
errors, and `cancel()` is idempotent.

Tests use an additive deterministic streaming fake model. They cover stable
event serialization, typed unknown input, stream ordering and backpressure,
append-before-yield behavior, and compatibility with one text-only legacy
model turn.

**M6 gate:** a deterministic, no-tool turn is append-before-yield through the
injected store and streamed in one exact sequence, the new contracts typecheck,
and existing public APIs and offline tests remain green.

## M7 — Deterministic minimal session loop (complete)

Delivered by `tasks/m7-deterministic-session-loop`.

Implement model streaming, versioned message/context state, text aggregation,
multiple tool-call rounds, strict tool-argument validation, hard budgets,
cooperative cancellation, and model timeouts. Use only fake or pure tools in
this milestone. “Hard” means cumulative accounting stops before the next
model/tool boundary; the runtime supplies the remaining request allowance but
cannot undo a provider response that reports usage beyond it.

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
decision must both be successfully appended through the injected `EventStore`
before any side effect. If either append fails, the tool does not execute. M14
adds the production adapter that makes those acknowledged records durable
across restart.

Tests cover multiple tool rounds, invalid arguments, unknown tools, tool
failure, malformed model streams, cancellation while waiting on the model,
permission, or tool, model timeout, hard step/token/tool budgets, persistence
failure, and exactly one terminal outcome.

**M7 gate:** `AgentRuntime.run()` completes a multi-round FakeModel task with
the exact event order. Cooperative adapters observe cancellation or timeout,
the runtime performs no later pull or effect, and non-cooperative cleanup is
bounded and classified rather than claimed to have disappeared.

## M8 — Enforced workspace capability boundary (planned)

Introduce the operational `Workspace` filesystem/process contract in
`packages/workspace`, adapt the M6 kernel compatibility target to it, and
migrate the kernel and tools to that injected capability. The current lexical
`resolvePath` seed is not treated as an operational implementation. Add an
import/package-boundary
rule that rejects `node:fs`, `node:fs/promises`, and `node:child_process` from
`packages/kernel` and model-facing implementations in `packages/tools`.
Within the kernel/tool capability layer, only `packages/workspace` may adapt
those host APIs; trusted CLI and service infrastructure retain their explicit
outer-boundary adapters. Unknown workspace operations and unsupported
capabilities remain typed errors.

**M8 gate:** a compile/lint fixture proves forbidden host imports cannot land,
and the kernel plus tools complete their offline tests with every filesystem or
process operation routed through an injected workspace.

## M9 — Trusted developer `LocalWorkspace` (planned)

Implement `LocalWorkspace` against the M8 contract by adapting the existing
escape-safe path resolver and argv-only process boundary. Preserve
`allowed_paths`, link and race defenses, bounded I/O, cancellation, diff,
snapshot, and disposal semantics even in trusted mode. Local execution is an
explicit developer-only selection, never an implicit production fallback.

**M9 gate:** the workspace conformance suite passes against a temporary local
repository, and malformed input, escape attempts, unsupported operations, and
an omitted explicit-local flag fail without touching files or processes.

## M10 — Disposable `DockerWorkspace` isolation (planned)

Adapt the M3 sandbox runner into a kernel-facing `DockerWorkspace` rather than
building a second container path. Each run starts from a clean clone or copied
worktree in an immutable image, mounts no host home directory, Docker socket,
or SSH agent, disables network by default, and applies CPU, memory, process,
disk, output, time, and cancellation limits. A run exports only declared
artifacts or a bounded Git patch and is destroyed after completion; explicit
retention is time-bounded and audited. Sandboxes start credential-free; any
later tool credential must be short-lived, scoped, and brokered under M35.
Before then, a manual live-model lane may provide its provider credential only
to the trusted model-adapter process boundary, never to model context, a
generic tool environment, or the sandbox.

Default tests use the injected argv-only executor. A scheduled/manual live
Docker suite covers traversal and link attacks, host credential probes, socket
and agent probes, network denial, resource exhaustion, cleanup, and retained
workspace expiry.

Passing this milestone makes `DockerWorkspace` the default of the new native
Workspace selector. M16 makes that selector the native platform-development
dispatch path. `LocalWorkspace` remains an explicit developer-only mode; there
is no automatic fallback when Docker is unavailable.

**M10 gate:** native Workspace selection defaults to `DockerWorkspace`, Docker
unavailability fails closed, and local execution requires the explicit
developer-only selection. A malicious fixture cannot read the host home
directory or credentials, escape its workspace, reach the network when denied,
or survive the lifecycle boundary, while its declared patch and artifacts
remain retrievable. This does not claim that the still-upstream-Pi TaskAgent
dispatch has already migrated.

## M11 — Five bounded development tools (planned)

Expose exactly these model capabilities through the persisted-policy tool
loop:

- `fs.read`
- `fs.list`
- `fs.write`
- `process.exec`
- `git.diff`

Canonical dotted names remain the policy and audit identifiers. Provider-safe
function aliases never enter policy or persisted events. The existing
`read_file` and `sandbox_exec` seams are migrated behind this contract; they do
not survive as extra model capabilities. File operations are
escape-, symlink-, hard-link-, and race-safe; writes are atomic and stay inside
`allowed_paths`; process execution is argv-only without a shell; outputs,
diffs, snapshots, time, and cancellation are bounded.

**M11 gate:** FakeModel edits only an allowed fixture, runs its tests, and
returns a bounded diff through the five tools; each invalid or out-of-scope
attempt has no side effect and leaves typed evidence.

## M12 — Steering and follow-up turns (planned)

Extend the M6/M7 active-run registry beyond its current first-boundary
steering behavior. Steering messages are append-acknowledged through the
injected `EventStore` in FIFO order and incorporated only at the next safe
model-request boundary, never spliced into an in-flight request. A follow-up is
a new turn on the same logical session. M14 adds cross-restart durability.
Define cancellation-versus-steering ordering, concurrent steering behavior,
terminal-run errors, and exactly one terminal outcome.

**M12 gate:** deterministic tests steer during model and tool phases, preserve
concurrent FIFO order, resolve cancel-versus-steer races, and complete a
follow-up without losing or rewriting prior message state.

## M13 — Context accounting and compaction (planned)

Track context-window occupancy separately from the cumulative token budget.
Compaction retains the append-only original history, appends a versioned summary
and tail checkpoint through the injected `EventStore`, emits compaction
evidence, and charges all model usage to the hard budget. M14 supplies durable
cross-restart storage. Summary failure is typed and fail-closed; if the
compacted context still cannot fit, the run stops with a typed context-overflow
outcome.

**M13 gate:** a long deterministic session compacts at the configured
threshold, reconstructs the expected next request from its summary and tail,
and proves failure and overflow paths do not discard original history.

## M14 — Durable replay and checkpoint invariants (planned)

Deliver the production `EventStore`-to-`SessionStore` adapter and back the
minimal persistence port with the existing SQLite/Postgres semantics: stable
event IDs, per-session sequence cursors,
idempotent identical delivery, typed conflicting duplicates, checkpoint CAS,
and owner fencing. A versioned checkpoint contains enough message, model,
usage, tool-loop, steering, and compaction state to reconstruct the next model
request. Future checkpoint versions fail explicitly rather than falling back.

**M14 gate:** SQLite close/reopen and Postgres contract tests replay the same
ordered session, reject conflicting duplicates and stale owners, and recreate
the exact next model request from a committed checkpoint.

## M15 — Restart-safe continuation (planned)

Extend M4 recovery with an explicit fenced continuation (or continuation-run)
primitive for a committed safe checkpoint. Preserve the conservative rule for
uncertain work: if a process may have completed a model or tool side effect
without persisting its result, mark that segment interrupted/indeterminate and
never execute it again automatically.

Tests inject crashes around every model request, tool intent, decision,
side-effect, result, and checkpoint boundary. They distinguish a safe retry
from an uncertain effect and cover cancellation during recovery.

**M15 gate:** after process restart, the runtime continues exactly once from
the last committed safe boundary and never duplicates an event, model turn, or
tool side effect.

## M16 — Offline kernel-backed self-host runner (planned)

Integrate the new runtime as a TaskAgent path behind the existing exit gate.
The trusted CLI still validates the canonical manifest, creates or selects the
exact `tasks/<id>` branch, runs pre/post `allowed_paths` gates and tests, and
writes the report. Branch creation is not a sixth kernel tool. The kernel uses
only the M11 tools to edit, test, and return a diff. M10 already made
`DockerWorkspace` the native selector's default; this runner adopts that
selector and cannot fall back to local execution. Refresh
`skills/platform-builder` to the native path,
current `run-report/v2` evidence, and the same manifest/branch/scope rules so
the repository's operating guidance no longer describes the legacy report as
acceptable.

All default coverage remains deterministic and offline. A FakeModel
integration runs in a temporary clean repository and proves branch identity,
scoped changes, tests, patch/artifact and report generation, deliberate safe
restart, and session continuation without invoking upstream Pi.

**M16 / first integrated gate:** the native kernel accepts a task manifest,
works in a disposable sandbox, modifies only its allowed fixture, runs tests,
records every event and policy decision, survives a safe-boundary restart, and
returns a passing report plus reviewable patch without touching `main` or
invoking upstream Pi. This qualifies the offline integration mechanism; it
does not yet prove authorship or activate the self-hosting ratchet.

## M17 — Native-builder authorship attestation (planned)

Add a versioned native-builder attestation rather than relying on the free-form
builder name in `run-report/v2`. Preserve the clean pre-builder and
post-builder Git snapshots. The trusted exit gate verifies the exact
`MinimalAgentRuntime` TaskAgent entrypoint, immutable builder source revision,
image digest whenever image-backed, immutable manifest-overlay digest, input
base SHA, workspace identity, session/run and event log, and generated tree and
patch digests.

Reject every pre-existing change except the attested manifest control input,
and reject a patch or report that cannot be tied to the verified native run.
PR/CI evidence binds the generated tree and patch to the candidate commit and
then to the accepted merge tree, with exact patch equivalence required for
squash or rebase. Human conflict edits return the task to the builder. The
kernel still does not need a commit tool to create valid authorship evidence.

**M17 gate:** an independently controlled seeded-patch test proves the native
run cannot claim pre-authored source, and an honest run binds clean base,
manifest, runtime, model, workspace, events, generated tree/diff, candidate
commit, and accepted tree without an identity gap. This attests the path that
will perform M18; it does not make the M17 implementation a qualified builder.

## M18 — First live self-hosted `harness doctor` change (planned)

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

**M18 gate:** using the M17-attested native path and without upstream Pi, the
new kernel completes a small tested change in its own repository from a clean
checkout, resumes the same logical session after restart without duplicating
uncertain work, and returns evidence suitable for human review. Passing
the gate is not enough by itself: after independent verification, human review,
and merge, the resulting M18 candidate commit/image becomes the first qualified
builder and must author M19. The M17 revision that performed the live run is not
silently re-qualified as the successor.

## M19 — Tool-independent action vocabulary (planned)

Extend `@harness/policy` with canonical actions that describe effects rather
than tool names:

```text
fs.read                  fs.write
process.exec             network.connect
secret.use               git.commit
git.push                 github.pr.create
deployment.read          deployment.apply
infrastructure.apply     billing.spend
```

Every native, MCP, ACP-backed, or service tool declares the actions it may
request. Provider aliases and transport method names map into this vocabulary
before policy evaluation; unknown actions and incomplete declarations are
typed errors. The policy engine remains pure and performs no enforcement.

**M19 gate:** declaration and mapping tests prove two differently named tools
with the same effect receive the same deterministic policy decision, while an
unknown or undeclared effect cannot reach an executor. The implementation
report names the qualified M18 builder and proves there was no Pi, direct-edit,
local-workspace, or other fallback.

## M20 — Contextual rules and approval leases (planned)

Evaluate declared actions against typed user, organization, agent profile,
repository, workspace, task manifest, path, command, destination host,
environment, and approval-lease context. Compile explicit allow/ask/deny rules
for read-only, build, review, and release use cases. Approval leases are scoped
to the exact action and relevant resource, expire by time and use, and cannot
widen the underlying manifest.

**M20 gate:** pure table tests cover precedence, path and argv matching,
destination/network rules, lease expiry and replay, conflicting scopes, and
typed unknown input without reading external state.

## M21 — Native effect-boundary enforcement conformance (planned)

Turn M7's persisted ordering rule into a reusable execution-boundary
conformance contract and apply it first to every native tool and Workspace
effect that exists at this point. Enforce the pure decision at the last trusted
boundary before execution. Preserve the canonical
`tool.call` → `policy.decision` → `tool.result` vocabulary: intent and decision
are durably appended before execution, an approval is linked to its request,
and append failure stops the effect. A denial keeps its typed audit decision
and outcome but produces no executor invocation or execution record because it
never crosses the boundary.

Every future side-effect adapter—MCP, secrets, Agent Server, executor,
deployment, or release—must pass this same conformance suite when introduced;
M21 does not claim to test adapters that do not exist yet.

**M21 gate:** fault injection proves every native side effect has one preceding
persisted decision, denied and failed-to-persist actions have no effect, and a
new adapter fails its contract tests unless it reuses the same validation,
decision, approval, cancellation, and audit path.

## M22 — Planner, Builder, and Reviewer capability profiles (planned)

Define three least-privilege profiles without pretending a production Release
capability exists yet. The Planner can inspect task and repository context and
produce a plan but cannot edit source. The Builder may edit and test only
inside the task sandbox. The Reviewer reads the attested patch and runs bounded
verification but cannot silently fix what it reviews. Profile changes require
a new authorized session rather than mutating privileges in place.

**M22 gate:** a pure capability-matrix suite and session fixture prove the
Planner cannot edit, the Builder cannot widen scope or self-review, and the
Reviewer cannot write. Unknown capabilities and attempted in-place escalation
fail typed and leave policy evidence. The Release profile arrives only after
candidate and staging mechanics exist.

## M23 — Model, tool, and profile registry lifecycle (planned)

Define durable, versioned catalogs for model adapters, native/MCP tools,
declared actions, agent profiles, and capability compatibility. Registry
records contain identifiers and configuration references, never provider
secrets. The registry issues immutable pin records that M24 sessions consume at
creation or fork; refresh, deprecation, replacement, and disappearance produce
typed states instead of silently selecting a different model or tool.

**M23 gate:** deterministic registry tests cover publish, list, resolve, pin,
deprecate, incompatible replacement, stale reference, and unavailable
capability behavior. After registry-store reopen, an existing pin either
resolves the same immutable selection or fails explicitly; it never drifts to
a new provider or tool.

## M24 — Durable session service domain (planned)

Build the public session domain that M3/M4 do not yet provide: create, load,
fork, prompt, steer, cancel, answer-permission, read-diff, list-artifacts, and
retrieve-report. SQLite remains the local single-user store and Postgres the
shared store. Model and initial profile selection resolve and pin accepted M23
catalog revisions and are allowed only when creating or forking; an active
session cannot mutate its identity or capabilities in place.

**M24 gate:** a session can be created, loaded, prompted, steered, forked,
cancelled, answered at a permission boundary, and resumed after store reopen;
diff, artifact-list, and report retrieval return the same authorized records.
History and pinned registry revisions remain ordered and unambiguous across
approval, checkpoint, artifact, and ownership state, and an in-place identity
or profile change is rejected.

## M25 — Role-separated workflow and immutable handoffs (planned)

Run the M22 profiles as separate durable M24 sessions. The Planner produces a
versioned `plan.json`; the Builder consumes that exact plan and emits an
attested revision; the Reviewer consumes that revision and returns findings;
any correction returns to a continued or new Builder session. Persist actor,
input digest, output digest, causal links, and supersession without permitting
a later actor to rewrite an earlier record.

**M25 gate:** an end-to-end fixture proves immutable Planner → Builder →
Reviewer handoffs, rejects a Builder that did not consume the approved plan,
returns findings without reviewer edits, and binds a corrected revision to the
finding it addresses. Passing makes role-separated workflow mandatory for M26
and later applicable development.

## M26 — Versioned JSONL session portability (planned)

Export and import events, policy decisions, checkpoints, pinned registry
records, artifact metadata, handoffs, and terminal state as bounded,
versioned JSONL. This is a portability and audit format, not another
authoritative event store. Import validates every frame, preserves stable
identities, rejects gaps and conflicting duplicates, and cannot resurrect a
closed or indeterminate effect as runnable work.

**M26 gate:** SQLite and Postgres sessions round-trip through JSONL with the
same canonical event bytes, checkpoints, ownership state, handoffs, and
artifact references; corrupted, future-version, conflicting, truncated, and
oversized imports fail typed without partially mutating the destination.

## M27 — Headless REST API and OpenAPI contract (planned)

Expose M23–M26 commands, registry retrieval, and artifacts through an
authenticated REST engine API whose OpenAPI document is the source of truth.
Model/profile selection, diffs, artifacts, reports, and permission answers all
pass through the same service and policy layer. Thin clients never call worker
pods or internal repositories directly.

**M27 gate:** generated contract tests exercise every success and typed error
response, reject unauthorized or stale commands, and prove no public route can
bypass session fencing, pinned registries, immutable handoffs, or policy.

## M28 — Multi-client WebSocket events and approvals (planned)

Add cursor-based WebSocket streaming for committed events, interactive
permission requests, steering, cancellation, and lifecycle updates. Define
backpressure, reconnect, duplicate delivery, competing approval, and stale
client behavior. REST remains the command/retrieval authority; WebSocket is the
ordered interactive channel.

**M28 gate:** two clients attach to one session, observe the same ordered
events, race safely on one approval, cancel or steer the active run,
disconnect, and resume from a committed cursor after the engine restarts.

## M29 — Generated TypeScript SDK (planned)

Generate and version a TypeScript REST client from M27 OpenAPI with the M28
WebSocket event iterator as a typed companion. Keep generation reproducible,
publish a machine-readable server/client compatibility table, and surface
unknown server fields, unsupported versions, pagination, cancellation, and
transport errors without falling back to internal calls.

**M29 gate:** a clean generation produces no diff, supported client/server
pairs pass the complete API and stream contract, incompatible pairs fail
before mutation, and the package exposes no private repository or worker
handle.

## M30 — CLI and CI SDK cutover with live dogfood (planned)

Migrate CLI session commands and CI orchestration from internal service imports
to M29. Keep the trusted local preflight/exit-gate shell around the public
client, but all session execution, approvals, events, diff, artifacts, and
report retrieval cross the SDK contract.

**M30 gate:** under independent control, the candidate CLI/CI cutover uses the
already accepted M29 SDK to drive the latest qualified native builder through
a named bounded live-model edit/test/diff task in a disposable clean golden
repository. Its fixture patch is retained as gate evidence and then discarded;
it is not an accepted platform patch and cannot help author or approve M30.
Events, diff, artifacts, and report all travel through the SDK, and CI repeats
the contract deterministically. Passing makes SDK orchestration mandatory for
M31 onward.

## M31 — TUI and web client migration (planned)

Migrate the interactive TUI and existing read-only web task board to the same
generated SDK. Remove their direct SQLite, report-directory, and worker-facing
execution paths while preserving local read-only import as an explicit offline
viewer mode that cannot launch or mutate a run.

**M31 gate:** CLI, CI, TUI, and web produce equivalent session and artifact
views from one API fixture, and static analysis plus adversarial tests prove no
interactive client has a privileged execution or permission shortcut.

## M32 — Initialize-era MCP connection core (planned)

Grow the M2 stdio client into versioned `McpClient`, `McpServer`, and
`McpConnectionManager` components for the initialize-era protocol through
`2025-11-25`. Define capability negotiation, stdio and authenticated
Streamable HTTP transport, disconnect, reconnect, timeout, cancellation,
malformed frames, backpressure, and explicit protocol pinning with locked
offline fixtures.

**M32 gate:** client and server negotiate `2025-11-25` explicitly over both
transport fixtures, unknown revisions and wire input fail typed, and
disconnect/reconnect does not corrupt the owning harness session or replay an
uncertain call.

## M33 — MCP `2026-07-28` stateless compatibility (planned)

Add the modern stateless lifecycle as a separate era: `server/discover`,
per-request protocol and client metadata, no initialize handshake or hidden
protocol session, routable method/name metadata, cache semantics, and
multi-round-trip input requests. Auto negotiation may fall back only according
to the explicit compatibility policy; pin mode never falls back. Application
state uses explicit handles and remains outside MCP transport identity.

**M33 gate:** modern-only, initialize-era-only, auto-negotiated, and pinned
fixture pairs produce the expected wire sequences. A modern request is
self-contained, a pin mismatch fails before tool execution, and no lifecycle
silently crosses eras.

## M34 — MCP adapters and lazy capability discovery (planned)

Implement `McpToolAdapter`, `McpResourceAdapter`, `McpPromptAdapter`, and
`McpPermissionMapper` around the internal tool and action interfaces. Search or
filter a connection's catalog first and load only relevant definitions into
model context; do not inject hundreds of capabilities on every turn. Adapter
calls pass M21 enforcement conformance and retain connection, server,
transport, and protocol identity in audit metadata.

**M34 gate:** native and MCP-backed versions of the same fixture action produce
the same validation, policy, permission, cancellation, and audit semantics,
and the model receives only definitions selected from the lazy catalog.

## M35 — Scoped short-lived secrets broker (planned)

Add a capability request flow in which policy authorizes a broker to issue an
expiring, least-privilege credential directly to one specific tool or trusted
adapter. Initial tool credentials are restricted to one repository, one
staging deployment, one object-store run prefix, or—when M60 activates
publication—one OCI candidate namespace.

Define the remote model path before the Agent Server needs it: an isolated
`ModelAdapter` receives only a single-run opaque capability for a trusted model
gateway outside the sandbox. The gateway alone holds the provider credential,
pins provider/model, audience, request/token ceiling, expiry, and allowed egress,
and returns bounded model-protocol frames. No generic provider token is mounted
in the run. Long-lived secrets never enter a model prompt, message, generic
sandbox environment, event payload, report, or artifact.

**M35 gate:** scope, audience, expiry, revocation, redaction, and replay tests
prove a tool can perform its one approved operation while the model, unrelated
tools, later runs, and retained artifacts cannot recover or reuse the secret.
Gateway fixtures and an explicit live-provider lane prove a remote
`ModelAdapter` can invoke only its pinned provider/model within its run budget,
while expiry, wrong audience, prohibited egress, log inspection, and sandbox
inspection reveal no reusable provider secret. Passing makes this brokered
model path mandatory for M43 and later remote live-model runs.

## M36 — Repository, issue, commit, push, and PR integration (planned)

Add narrow MCP-backed issue retrieval and repository delivery operations. The
Builder still changes source only through the five native Workspace tools. A
trusted delivery operation accepts the attested base, tree/patch digest,
canonical task branch, and commit metadata; it creates and pushes exactly that
tree and opens a PR whose base may be `main`. It cannot accept arbitrary source
content, commit or push directly to `main`, rewrite history, merge, or push a
tree different from the attested output.

**M36 gate:** offline remote-host fixtures prove issue/repository scoping,
single-use credential delivery, exact patch-to-commit equivalence, branch
protection, idempotent push/PR retry, and denial of unrelated commits, force
push, direct-main mutation, or merge.

## M37 — CI, documentation, artifact, and deployment-status integration (planned)

Add only the remaining read or append-only integrations needed to build the
platform: documentation lookup, CI status, run-scoped artifact storage, and
read-only deployment status. Each uses a narrow action declaration and scoped
credential. Do not expose arbitrary cloud shells, production machines,
cluster-admin commands, or generic storage roots. Reconnection restores
availability without replaying uncertain calls.

**M37 gate:** contract tests demonstrate destination, repository, run-prefix,
and read-only deployment scoping, safe disconnect/reconnect, bounded results,
and denial of every undeclared administrative operation.

## M38 — MCP-backed issue-to-PR dogfood (planned)

Use M32–M37 to read a named platform issue, prepare a clean manifest-backed
workspace, implement and verify the task, inspect CI, export evidence, create
the exact attested commit, and open a pull request. A human remains responsible
for review and merge.

**M38 gate:** the named task reaches a reviewable PR whose remote tree equals
the attested Builder output and whose linked report traversed the shared
policy/audit path. There is no unrestricted shell, cloud administrator,
cluster credential, autonomous merge, direct worker access, or delivery-time
source edit. Passing makes this constrained external-delivery envelope
mandatory for subsequent milestone delivery.

## M39 — `HarnessProvider` and native adapter (planned)

Introduce one provider boundary above harness-specific session protocols:

```ts
interface HarnessProvider {
  capabilities(): Promise<HarnessCapabilities>;
  createSession(input: CreateHarnessSession): Promise<string>;
  loadSession(input: LoadHarnessSession): Promise<string>;
  prompt(sessionId: string, prompt: Prompt): AsyncIterable<AgentEvent>;
  steer(sessionId: string, message: string): Promise<void>;
  answerPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
```

Implement `NativeHarnessProvider` first. Task manifests, workspace allocation,
policy, canonical events, artifacts, budgets, and audit remain above the
provider boundary and therefore cannot vary by agent implementation.

**M39 gate:** native golden tasks create or load a session, prompt, steer,
answer a permission, cancel, and resume through `HarnessProvider` with the same
event sequence, decisions, artifacts, and reports as the direct path, which is
then removed from client orchestration. Passing makes
`NativeHarnessProvider` the attested authoring boundary for M40 onward.

## M40 — Native inbound ACP server compatibility (planned)

Complete the inbound ACP direction for the native runtime: initialize,
authentication capabilities, session/new, session/load, session/prompt,
session/cancel, streamed updates, permission requests, file locations, and tool
status. Add the official local stdio flow while preserving the existing
`harness/acp/1` loopback WebSocket protocol as an explicitly named compatibility
surface. Both normalize into `AgentEvent`; neither becomes a second session
model or the authenticated remote-control API.

**M40 gate:** an offline conforming ACP client fixture creates or loads a native
session, prompts it, answers a permission, observes file/tool updates, cancels
it, and receives the canonical persisted event order over stdio.

## M41 — Outbound ACP harness provider (planned)

Implement `AcpHarnessProvider` so the control plane can operate OpenCode,
Goose, and future compatible agents through initialize, session, prompt,
update, permission, and cancellation flows. Deterministic protocol fixtures
run in the default lane; live OpenCode and Goose checks are explicit
compatibility lanes. Remote execution continues to use the authenticated
platform REST/WebSocket API rather than assuming remote ACP semantics.

**M41 gate:** the same scheduler and client switch among native, OpenCode, and
Goose fixtures without changing the task manifest, workspace, permissions,
budget, artifact handling, or event consumers.

## M42 — Versioned cross-harness golden comparison matrix (planned)

Pin a versioned golden corpus and result schema, then run every compatible task
against `native`, `opencode-acp`, and `goose-acp`. Normalize outputs into the
shared event schema and compare completion, tool use, permission behavior,
reported usage/cost inputs, duration, test results, and objective diff
properties. Capability differences are explicit `unsupported` results, never
silent fallbacks; subjective quality claims require a separately versioned
rubric or human review.

**M42 gate:** one schema-valid report identifies the exact corpus, provider,
model/configuration, environment, and repetitions for every pass, fail, or
unsupported cell. Provider switching cannot bypass policy or alter workspace
and artifact ownership. ACP providers remain evaluation-only and cannot
author roadmap patches. Provider-reported cost inputs remain explicitly
provisional until the authoritative pinned ledger reconciliation in M52.

## M43 — Remote Agent Server lifecycle and native convergence (planned)

Run an authenticated Agent Server inside the isolated runtime, using only the
M35 single-run model-gateway capability for live provider calls. Migrate the M3
service from legacy `runAgent`/`Model.complete` and its private session state to
the M24 domain through `NativeHarnessProvider`. Extend health/readiness,
initialize, start/load session, prompt, stream, cancel, and graceful shutdown.
The public SDK is the remote client; the harness-specific M3 WebSocket protocol
is only a named compatibility adapter. Persist the lifecycle:

```text
requested → provisioning → initializing → ready → running
          → waiting_for_approval
          → completed | failed | cancelled
          → archiving → destroyed
```

The local CLI submits through the public SDK and watches events; it does not
perform remote workspace work itself.

**M43 gate:** the public SDK drives every session and lifecycle transition
against an offline remote-server fixture, including approval wait,
cancellation, failure, archival, and graceful destruction. The server uses the
canonical session store and native provider, and no client-side workspace or
legacy direct-runtime execution remains.

## M44 — Remote workspace and artifact operations (planned)

Add bounded workspace execution, file upload/download, diff retrieval,
snapshot creation, and artifact export to the in-sandbox Agent Server. Every
operation delegates to the current `Workspace`, action vocabulary, policy
decision, and committed event path; the service never calls host filesystem or
process APIs as a shortcut. File and artifact transfer is content-addressed,
size-bounded, cancellable, and scoped to the owning run.

**M44 gate:** the remote server completes a deterministic edit/test/diff
fixture, round-trips one declared artifact and snapshot, rejects cross-run and
oversized access, and leaves no live process or workspace after teardown.

## M45 — Remote platform-development dogfood (planned)

Have the accepted M44 Agent Server author a named, bounded versioned change to
`services/control-plane` inside `DockerWorkspace` from a clean manifest-backed
checkout. The task must change and test control-plane service behavior; a
docs-only or unrelated package change cannot qualify. The local CLI only
submits, streams committed events, answers approvals, and retrieves the report,
patch, and artifacts through the SDK. Live model calls use the M35 gateway; no
provider credential enters the Docker runtime.

**M45 gate:** the named manifest produces an accepted control-plane service
patch whose source edits and task-requested tests ran entirely in the remote
Docker workspace. Deterministic CI repeats mechanics offline; no source edit,
test process, provider secret, or credential-bearing operation executes in the
local client or generic sandbox environment.
Discarded or rejected activation output cannot qualify the path. Passing makes
remote execution mandatory for M46 onward until control-plane admission
qualifies.

## M46 — Executor contract (planned)

Extract workspace provisioning, Agent Server launch, lifecycle observation,
artifact export, cancellation, retention, and destruction behind one executor
contract. Publish a transport-neutral offline conformance suite so future
executors cannot change session, event, policy, workspace, or API semantics.

**M46 gate:** two structurally different fake executors pass the same lifecycle
and failure corpus; unknown capabilities, stale identities, invalid state
transitions, and unbounded retention fail before resource creation, and the
control plane imports no container- or Kubernetes-specific implementation.

## M47 — `DockerExecutor` adaptation (planned)

Move the existing M10 sandbox runner and M43–M44 remote server path behind the
M46 contract. Preserve immutable images, bounded mounts, network policy,
resource limits, cancellation, patch/artifact export, retention, and cleanup
without building a second Docker launch path.

**M47 gate:** `DockerExecutor` passes the full executor and Workspace
conformance suites through the injected offline process boundary, while a
scheduled live-Docker lane proves image, mount, network, resource, process,
artifact, cancellation, and cleanup behavior. Passing makes this the mandatory
remote Docker provisioning path for M48 and later Docker-hosted work.

## M48 — Crash-safe remote recovery (planned)

Connect executor recovery to M15 checkpoints, fenced ownership, and effect
identity. Destroy and recreate a Docker sandbox after a worker crash, resume
only from a committed safe boundary, and classify uncertain model, tool, and
external effects without repeating them.

**M48 gate:** fault injection terminates the worker immediately before and
after every external-effect and checkpoint boundary. Recovery either completes
from the safe cursor or records one indeterminate outcome; it never duplicates
an event, model request, tool effect, artifact commit, or delivery operation.

## M49 — Remote isolation and credential-containment proof (planned)

Prove the Docker runtime receives no control-plane filesystem, database
credential, object-store root credential, host home, Docker socket, SSH agent,
generic host identity, or long-lived provider secret. Scoped credentials reach
only their approved tool or single-run model-gateway call and disappear at
expiry or teardown.

**M49 gate:** adversarial live-Docker probes cannot read or reach protected
host/control-plane state, another run, a prohibited destination, or a brokered
credential outside its approved tool or model-adapter call; cleanup and
retained-artifact inspection find no recoverable secret.

## M50 — Control-plane identity and catalog records (planned)

Extend, rather than replace, the M4 domain with user, organization,
repository, agent/model profile, pinned registry revision, approval, workspace,
artifact, audit, and deployment-candidate records. Define ownership,
authorization, immutability, and deletion/retention behavior before exposing
them through public APIs.

**M50 gate:** repository tests cover tenant and repository isolation, immutable
profile/candidate inputs, authorization joins, retention, redaction, and typed
conflicts in memory and Postgres without creating a second task/run/session
domain.

## M51 — Postgres admission queue and worker manager (planned)

Add worker registration and heartbeat, capability matching, workspace
allocation, approval routing, retry, cancellation, and reconciliation to the
existing fenced scheduler. Use Postgres leases and `SKIP LOCKED`; Kafka, NATS,
Redis, and Temporal require a separately measured need.

**M51 gate:** deterministic concurrent scheduler and worker-manager fixtures
admit one canonical manifest, select one compatible worker, grant one live
lease, recover expired pre-start ownership, quarantine uncertain started work,
and route one approval. An explicit live-Postgres lane restarts the database
mid-lifecycle and reaches one fenced terminal record without duplicate
ownership or effects.

## M52 — Usage ledger, monetary cost, and hard budgets (planned)

Create an append-only usage ledger for model tokens, tool calls, elapsed time,
workspace resources, and monetary cost. Pin the provider/model pricing revision,
currency, rounding rule, and source used for each calculation; later invoice
reconciliation is separate evidence and cannot rewrite historical estimates.
Extend manifests and profiles with compatible hard limits and warning
thresholds. Unknown pricing is a typed policy outcome, never zero cost.

**M52 gate:** deterministic usage fixtures reconcile event totals to the
ledger, emit warnings before configured thresholds, and stop before the next
model/tool boundary when any hard token, tool, time, resource, or cost budget
is exhausted. Price changes do not alter prior runs, and retries cannot double
charge or reset a budget. Re-run or replay the exact M42 native/OpenCode/Goose
matrix inputs through the pinned ledger and publish the reconciled comparable
costs, with unknown, unsupported, and non-comparable cells preserved rather
than coerced to zero.

## M53 — Docker Compose control-plane integration (planned)

Compose the control API, scheduler, worker manager, Postgres, MinIO, OTel
collector, Agent Server workers, and web shell around the complete accepted
M47–M52 path. Wire
authenticated SDK commands, committed event ingestion, allocation, approval,
cancellation, metering, content-addressed artifacts, audit export, and
health/readiness without introducing another state or queue path.
Extend the M27 OpenAPI contract with canonical task admission and control-plane
commands, then regenerate the M29 SDK; do not create a private Compose client.

**M53 gate:** a deterministic end-to-end Compose fixture admits a canonical
manifest, leases a Docker worker, survives control-service and worker restart,
streams committed events to two clients, honors approval and every hard
budget, archives artifacts, exports audit, and reaches one fenced terminal
state. Fault and adversarial cases exercise M48 safe recovery and M49 network,
tenant, and credential containment through the composed path. This proves
integration mechanics but does not yet qualify Compose for milestone
authorship.

## M54 — Compose self-hosting activation (planned)

Use the accepted M53 Compose path to author a named bounded platform change.
The external client may submit, approve, and retrieve evidence only; scheduling,
native authoring, task tests, artifacts, and terminal state all pass through
the composed control plane.

**M54 gate:** the named manifest produces an independently verified and
accepted patch with complete lease, event, approval, usage, cost, artifact, and
report evidence. Discarded activation output cannot qualify the path. Passing
makes control-plane admission mandatory for M55 onward.

## M55 — Thin `KubernetesWorkspace` adapter (planned)

Implement `KubernetesWorkspace` as an executor-backed transport over the
authenticated in-pod Agent Server, not a duplicate workspace domain. It
preserves the bounded file, process, diff, snapshot, artifact, cancellation,
and disposal contract; pod identity never leaks into kernel or tool APIs.

**M55 gate:** the shared Workspace conformance suite passes against an offline
Kubernetes transport fixture, including disconnect, stale pod identity,
cancellation, bounded transfer, and disposal, with no Kubernetes branch in the
kernel or tools.

## M56 — `KubernetesExecutor` lifecycle conformance (planned)

Materialize the suspended M4 sandbox Job contract behind M46. Implement safe
template substitution, workspace staging, Agent Server readiness, lifecycle
observation, artifact export, cancellation, retention, and TTL destruction.
Only the trusted executor service receives the narrow Kubernetes API authority
required to manage run resources.

**M56 gate:** an offline API fixture and an explicit live-cluster lane pass the
same executor lifecycle corpus, including partial create, watch disconnect,
stale UID, cancellation, artifact failure, retention expiry, and idempotent
cleanup.

## M57 — Kubernetes run isolation hardening (planned)

Place untrusted run pods behind dedicated service accounts and a namespace or
equivalent strong run identity, with resource limits, default-deny
NetworkPolicy, pod-security restrictions, read-only root filesystem where
practical, ephemeral workspace storage, and TTL cleanup. Run pods receive no
Kubernetes API token, control-plane credential, or cross-run network path.

**M57 gate:** adversarial tests prove a run pod cannot reach the Kubernetes
API, control-plane/database/object-store credentials, another run, protected
metadata endpoints, or prohibited egress, and cannot persist after its TTL.

## M58 — Kubernetes production topology and self-hosting activation (planned)

Place trusted control services and untrusted, high-churn sandboxes on separate
node pools with independently scalable policies. Trusted database access uses
a separately scoped connection/proxy boundary; run pods cannot reach the
database. Record a measured provisioning-SLO decision for warm standby pods:
they remain disabled by default unless evidence justifies them, and any warm
pool must be scrubbed and re-attested before assignment. The community Agent
Canvas Helm chart is not accepted as a multi-tenant authentication or
isolation boundary.

Use the accepted M55–M57 workspace, executor, and isolation path to author a
named platform change through the M54 control plane.

**M58 gate:** topology and adversarial checks pass, the named live-model task
produces an independently verified and accepted patch entirely inside the
Kubernetes executor, and evidence binds the exact M55 Workspace transport, M56
executor implementation, M57 run identity/isolation policy, and M58 trusted
topology identities. No Docker fallback participates. Passing makes Kubernetes
mandatory for M59 onward.

## M59 — Constrained staging deployment capability (planned)

Extend M37's read-only deployment status with narrow, policy-declared
operations such as `deployment.create_staging_release` and
`deployment.rollback_staging`. Deliver a staging-scoped credential only to the
approved tool; never mount cluster-admin access or expose arbitrary `kubectl`
or production shell execution to the agent.

**M59 gate:** the platform can inspect, create, and roll back only its own
staging release, every operation passes M21 enforcement and has persisted
approval/audit evidence, and production or out-of-scope attempts are denied
before execution. Passing makes these tools the only staging-mutation path for
M60 onward.

## M60 — Trusted build and OCI publication boundary (planned)

Introduce a non-model-facing, trusted build service or job behind a narrow
M21-enforced `image.build_and_publish` contract. It accepts only an attested,
human-accepted source tree digest, pinned build definition, dependency and
base-image digests, toolchain, target platforms, environment, and approved OCI
destination. It runs rootless or behind an equivalently isolated remote build
boundary and has no source-edit, deployment, promotion, or arbitrary registry
authority.

The M35 broker delivers a short-lived push credential directly to this service,
scoped to one candidate repository/digest namespace. The agent, model adapter,
run pod, and generic tool environment receive no registry credential, Docker
socket, or Kubernetes API. Inputs, outputs, policy decision, effect identity,
and credential audience/expiry are committed before or around the effect under
the same M21 conformance rules as every other external action.

**M60 gate:** offline service/registry fixtures plus an explicit live-registry
lane prove immutable input binding, destination allowlisting, rootless or
remote isolation, single-use credential scope, idempotent retry, audit/redaction,
and immutable digest output. The live lane performs one tiny pinned source build,
pushes by candidate digest, pulls it back, inspects its OCI content, and verifies
the source/material attestation and signature. The service cannot push a
mutable release tag or promote an image. Candidate M60 code does not build or
publish its own image;
only the independently verified and merged M60 service becomes mandatory for
M61.

## M61 — Prior-builder immutable image publication (planned)

Use the already accepted M60 service to build the M61 successor image from the
accepted clean source tree. Source acceptance or merge alone does not qualify
M61: the M60 service remains the authoritative prior builder throughout this
gate. Pin the build definition, dependency graph, base-image digests,
toolchain, target platforms, and environment. Record source tree, build-service
source/image identity, build record, OCI manifest/config/layer digests,
SBOM/material graph, and signatures before publishing an immutable candidate
digest. Candidate M61 code cannot execute the authoritative build or obtain
the publication credential.

**M61 gate:** two attempts with identical declared inputs either produce the
same versioned reproducibility identity or fail with an explained input/output
delta; changing any material creates a distinct build record. Tags cannot
replace digests, the published object cannot be mutated in place, and every
output binds to the accepted M61 tree and prior M60 service identity.

## M62 — Staging verification and candidate self-build (planned)

Deploy only the M61 prior-builder artifact to staging through the M59 boundary
and run pinned smoke and golden suites. Separately run the candidate revision's
own M60-compatible build-service implementation in a clean, credential-free,
non-authoritative comparison namespace and have it rebuild the same accepted
source. A versioned reproducibility policy defines equality; the initial policy
requires equal per-platform OCI content identity and equal normalized
SBOM/material graph, while signatures and build-record identities remain
distinct. The comparison worker has no publication or promotion credential,
and its artifact is never promotion input.

**M62 gate:** the authoritative digest has a reviewable staging report, every
smoke/golden result links to its exact corpus and environment, and the separate
self-build either matches the declared identity or rejects the candidate.
Changed input, missing evidence, or failed checks stop before promotion and
leave the current platform available.

## M63 — Release profile and human approval state machine (planned)

Publish the fourth least-privilege profile through the M23 registry and run it
as a separate durable M24 session.
Release may inspect the immutable candidate and verification graph and request
promotion, but it cannot edit source, build an image, change evidence, widen
scope, or approve its own request. Human approval is bound to one digest,
environment, release policy revision, evidence snapshot, expiry, and use.

**M63 gate:** the Release session cannot request an unverified or changed
digest, Builder/Reviewer sessions cannot promote, stale or replayed approval is
rejected, and only an explicit authorized human decision advances the exact
candidate to canary eligibility.

## M64 — Production canary, health evaluation, promotion, and rollback (planned)

Extend M35 with a production-release credential and introduce a
non-model-facing production deployment controller with only the
narrow M21-enforced actions needed to start a canary, promote the approved
candidate, and roll back to the retained prior digest. Its service identity and
M35 credential are restricted to the platform's production release target and
one approved digest; no agent session receives cluster-admin, production shell,
or generic deployment authority. Every operation requires the unexpired M63
human approval and is idempotent, fenced, restart-safe, and committed before
the external effect.

Implement bounded canary rollout and automatic health evaluation. A versioned
release policy pins metrics, queries/data sources, thresholds, minimum sample
and observation period, missing-data behavior, promotion deadline, rollback
trigger, rollback deadline, and previous-version retention. Candidate code
cannot alter the controller, credential, or policy governing itself.

**M64 gate:** deterministic fixtures plus an explicit controlled live-environment
lane prove production destination and digest scoping, credential containment,
M21 effect ordering, and healthy, unhealthy, stale, missing, contradictory,
timeout, controller-restart, and rollback-failure states. A healthy explicitly
approved canary promotes once; every other state blocks or rolls back within
policy, and the prior immutable version remains runnable. This proves accepted
mechanics but does not yet create a qualified release builder.

## M65 — One-time release-builder bootstrap (planned)

The qualified M64 development platform, still running through Kubernetes,
authors a named small successor task. After source acceptance, that same prior
qualified platform invokes the M61 authoritative build through the accepted
M60 service; independent control runs M62 verification, obtains the explicit
M63 human approval, and invokes the M64 canary/promotion controller. The
candidate does not author its own patch, select its evidence, approve itself,
or replace the prior build input.

**M65 gate:** the named successor is independently verified, human-approved,
canaried, and successfully promoted with the prior version retained. Only then
does M65 become the first qualified release builder. A failed, rejected, or
rolled-back attempt leaves M64 as the qualified development builder and creates
no release builder.

## M66 — Complete self-release provenance and cutover (planned)

Have the qualified M65 release builder author and build its M66 successor, then
carry it through independent verification, explicit human approval, canary,
and promotion through the full accepted path. Record builder
source/tree/image digests, candidate source/tree/image digests, task manifest,
model and parameters, tool versions, MCP/ACP revisions, policy/approval
decisions, workspace/executor/build-service images, usage/pricing revision,
tests, artifacts, staging, health, and rollback state.
`builder_version != candidate_version` is descriptive shorthand; the security
invariant is distinct immutable source commits/trees, build records, and image
identities with the prior builder authoritative.

**M66 gate:** an auditor can reproduce the immutable release input graph,
verify every hash and approval link, bind the promoted artifact to the accepted
candidate tree, and prove neither candidate code nor a fallback acted as its
own trusted builder. Successful promotion makes the governed release path
mandatory for M67–M76.

## M67 — Canvas live session and approval slice (planned)

Turn the M2 read-only board into the first Canvas slice using only the public
SDK lineage introduced in M29 and extended with control-plane admission in M53.
Show session creation/attachment, live text, tool calls, committed status,
permission requests, pinned model/profile, token and cost usage, budgets, and
cancel/steer controls. The browser has no worker credentials, direct store
access, or privileged backend shortcut.

**M67 gate:** an operator creates or attaches to a session, observes ordered
live state, answers one scoped approval, steers or cancels safely, reconnects by
cursor, and sees the same authoritative result as CLI and CI.

## M68 — Canvas patch, verification, and review slice (planned)

Add changed files, bounded inline diff, tests, artifacts, Planner handoff,
Reviewer findings, corrected revisions, and explicit approve/reject review
controls. Every view is keyed to the attested tree and event/report identity;
Canvas cannot edit the patch or silently turn a finding into source.

**M68 gate:** an operator traces plan → patch → tests → findings → correction,
reviews the exact accepted tree, and submits a decision through the public API.
Stale, superseded, mismatched, or incomplete revisions cannot be approved.

## M69 — Canvas operations and interoperability (planned)

Add sandbox lifecycle, resource use, snapshots, retention, and expiry; native
and ACP-backed harnesses; profiles, models, tools, and declared capabilities;
and native/MCP connection health, revisions, permissions, and usage. Group
pending approvals by risk: file modification, network access, credential use,
PR creation, staging deployment, and production deployment.

**M69 gate:** Canvas reflects authoritative API state for every lifecycle and
connection transition, switches evaluation harnesses without a special
execution path, and cannot display or grant authority broader than the
underlying request.

## M70 — Canvas evaluation view (planned)

Display the versioned M42 golden corpus and M52 authoritative ledger
reconciliation: pass/fail/unsupported cells, regressions, usage, pinned price
inputs, reconciled costs, durations, objective diff metrics, repetitions, and
environment. Every number links to its source run, event cursor, pricing
revision, or immutable artifact; unsupported and non-comparable results are not
converted into zeros or success.

**M70 gate:** exact complete, partial, stale, failed, unsupported, and
incomparable fixture states render distinctly, and an operator can reproduce
each displayed aggregate from linked source records.

## M71 — Canvas release and provenance view (planned)

Display current and candidate identities, builder/candidate distinction,
provenance graph, smoke/golden results, staging state, approval scope/expiry,
canary policy and observations, promotion, rollback, and retained prior
version. Never collapse missing, stale, contradictory, or failed evidence into
a generic ready state.

**M71 gate:** schema-driven UI fixtures prove the exact action availability and
status for complete, stale, missing, contradictory, failed, rolling-back, and
promoted records; every release decision input links to immutable evidence.

## M72 — Canonical trigger normalization and admission core (planned)

Define one trigger envelope and adapter contract that resolves actor identity,
origin, repository, requested task, policy profile, idempotency key, and source
URL into a validated canonical `TaskManifest`. The public SDK and every trigger
adapter invoke the same authenticated task-admission handler implemented in
M53 and qualified by M54; that shared handler always enters the fenced
control-plane scheduler path. Trigger handlers cannot invoke schedulers,
workers, sessions, or tools directly.

**M72 gate:** SDK and trigger-envelope fixtures representing the same request
reach the exact same admission function and produce equivalent task, policy,
workspace, event, artifact, and report records. Invalid provenance fails before
admission, and duplicate envelopes create only one run.

## M73 — Manual, issue-label, and PR-comment triggers (planned)

Implement manual runbook, issue-label, and pull-request-comment adapters on
M72. Bind each platform-specific actor and repository event to the canonical
envelope; comments and labels cannot smuggle a manifest, prompt patch, broader
profile, or foreign repository authority.

**M73 gate:** signed offline webhook/manual fixtures admit authorized requests
once, reject replay, spoofed actor/repository, edited event, patch-bearing
prompt, and unsupported action, and yield the same run as an equivalent SDK
request.

## M74 — Unattended-run governance semantics (planned)

Define deduplication, coalescing, retry, cancellation, quiet-period, concurrency,
budget reservation, expiry, escalation, and human-review requirements before
adding unattended event sources. These semantics live in the canonical
admission/scheduler domain; there is no second workflow engine in Canvas or a
trigger service.

**M74 gate:** deterministic clock and failure fixtures prove retries cannot
duplicate a run or side effect, coalescing cannot drop a higher-risk request,
quiet periods cannot evade urgent policy, reservations cannot reset or exceed
budgets, and unattended work cannot bypass review or release approval.

## M75 — Scheduled and reactive trigger adapters (planned)

Add scheduled maintenance, dependency update, CI failure, and monitoring alert
adapters on M72 and M74. Each adapter has a versioned source contract,
authentication, repository/environment scope, canonical task mapping, and
explicit unsupported-event behavior.

**M75 gate:** offline source fixtures route all four adapters through canonical
ingress and the same queue, while duplicate, reordered, stale, spoofed,
cross-repository, and storm inputs cannot broaden authority, duplicate a run,
evade a budget, or bypass escalation.

## M76 — Full self-building release rehearsal (planned)

Exercise the complete platform-development loop:

```text
issue → Planner → policy → sandbox allocation → Builder → verification
      → Reviewer → pull request → independent CI → immutable candidate
      → non-authoritative clean comparison rebuild → staging → golden tasks
      → Release approval → canary → promote or roll back
```

The human still merges source and approves production. The prior platform
version remains available throughout, and all task, model, tool, protocol,
workspace, decision, test, artifact, image, and approval evidence is linked to
the release record.

**M76 / program gate:** platform version N builds and safely proposes N+1 from
a canonical manifest; N+1 performs a non-authoritative comparison rebuild in
the M62 isolated worker and passes staging gates, while only the authoritative
N-built digest for N+1 produced through the M61 path is eligible for promotion.
An approved healthy canary promotes or an unhealthy one rolls back; no actor
touches `main` or production beyond its recorded authority. Machine-readable
evidence shows an unbroken qualified-builder chain from M18 through the current
release, with no milestone completed by a fallback or break-glass run.

## Explicit non-goals (M0–M76)

- No microservice decomposition of the kernel; it remains a library behind
  service and provider adapters.
- No Rust, Go, or Python service without a new manifest and a reproducible
  numeric profile meeting the reopening criteria in `ARCHITECTURE.md`.
- No privileged Canvas or client shortcut. CLI, TUI, web, and CI use the same
  public API, generated SDK, policy decisions, and committed event stream.
- No live Kubernetes executor before `DockerWorkspace`, the remote Agent
  Server, `DockerExecutor`, and Compose admission pass their isolation and
  lifecycle gates. The M4 Kubernetes base remains a non-executing topology
  until M56.
- M8–M10 add no model-facing capability. M11–M18 expose exactly `fs.read`,
  `fs.list`, `fs.write`, `process.exec`, and `git.diff` to the model. Later MCP,
  ACP, secret, and deployment capabilities
  are narrow adapters through the same policy and audit path; there is no
  unrestricted browser, cloud, production-machine, cluster-admin, or arbitrary
  shell capability.
- No host home directory, Docker socket, SSH agent, generic control-plane
  credential, or long-lived model-visible secret enters an untrusted workspace.
- No autonomous mutation of `main` or autonomous merge. M18 returns a patch
  for human review; M38 may create a PR, but a human still approves merge and
  production promotion.
- No second workflow engine for automation. Every interactive or unattended
  trigger resolves to the same canonical `TaskManifest` and scheduler path.
- No Kafka, NATS, Redis, or Temporal until a measured requirement justifies it;
  Postgres leases remain the initial queue.
- No third authoritative JSONL session database; JSONL is a validated
  portability/audit format over SQLite and Postgres.
- No unversioned pricing lookup, silent zero-cost assumption, or budget reset
  on retry.
- No ACP-backed harness authors a roadmap milestone; OpenCode, Goose, and other
  providers remain compatibility/evaluation targets for this program.
- No community Agent Canvas Helm chart is treated as multi-tenant identity or
  isolation, and no warm sandbox pool is enabled without measured provisioning
  evidence plus scrub-and-reattest semantics.

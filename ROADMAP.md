# ROADMAP.md

## M0 — Foundation  ✅ (this commit)
- pnpm workspaces, TS strict, vitest across the board
- `packages/events` — schema, round-trip, typed error gates
- `packages/kernel` — agent loop, budgets, event emission
- `packages/models` — protocol + `FakeModel`
- `packages/policy` — pure decision engine
- `packages/sdk` — task manifest in, run report out
- `packages/{tools,sessions,workspace,mcp,acp}` — protocol surfaces
- `apps/cli` — `harness validate | run` (the exit gate)
- `tasks/kernel-0001.yaml` — first dogfooded task contract
- `skills/platform-builder` — operational skill
- Infra: Docker dev image + compose (MinIO). No Kubernetes.

## M1 — Operator loop  ✅ (branch chain `tasks/m1-*`)
- CI: `pnpm test` + `pnpm typecheck` + `harness run tasks/kernel-0001.yaml`
  as a required gate on every PR (dogfooding begins here)
  → `tasks/m1-ci-gate`, workflow in `.github/workflows/ci.yaml`
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

## M4 — Control plane & scale
- `services/control-plane`: scheduling, task state, artifact registry
- Postgres for sessions/events; S3 (or MinIO in production) for artifacts
- Audit log exported from the event stream to object storage; signed URLs
- `infra/kubernetes/` manifests replace compose for the service mesh
- Replay-safe session restore (see SECURITY.md open questions)

## M5 — Polyglot review (conditional)
- Only if M3–M4 profiling produces a hard, measured reason do we add a
  second runtime. The justification is a profile + a task manifest + a
  design note in `ARCHITECTURE.md`, per the language strategy there.

## Explicit non-goals (M0–M5)
- No microservice decomposition of the kernel (it is a library)
- No Rust/Go/Python services just because a reference uses them
- No custom web framework before `apps/web` v0.1 is actually used
- No K8s before the control plane exists and we have >2 long-lived
  containers that need to be scheduled

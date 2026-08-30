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

## M1 — Operator loop  ⏳
- CI: `pnpm test` + `pnpm typecheck` + `harness run tasks/kernel-0001.yaml`
  as a required gate on every PR (dogfooding begins here)
- `apps/tui`: read-only session/event viewer
- `evals/scenarios` runner + first scenario against the golden kernel
- SQLite persistence for session logs (`packages/sessions`)
- Run report: add `deliverables.pull_request` URL when CI provides it
- `SECURITY.md` open question: exec egress pattern → rule compiler

## M2 — Eval credibility
- `evals/golden-repositories/hello-service` — first calibration target
- Scenario DSL validation in `@harness/sdk` (YAML → invariants)
- `apps/web`: minimal task board (manifests + reports, no real-time)
- OpenTelemetry wiring end-to-end (kernel → CLI → local collector)
- `packages/mcp`: live stdio client, 1 third-party server in CI
  (network-gated job, not in the default lane)

## M3 — Services
- `services/agent-server`: ACP server over WS; one kernel run per session
- `services/sandbox-runner`: Docker-per-run, policy-enforced boundaries,
  fs mounts scoped by `allowed_paths`, network namespace default-deny
- Provider model adapter (OpenAI-compatible) behind `packages/models`
- `apps/tui`: interactive; permission `ask` flows

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

# AGENTS.md

Rules of engagement for AI agents (and humans) working in this repo.
This file is read by the harness itself: the skill
[`skills/platform-builder`](skills/platform-builder/SKILL.md)
encodes the same invariants as agent guidance.

## What this repo is

The harness platform: a dogfooding system in which **the agent builds
the harness that runs the agent**. One language (TypeScript / Node 22 /
pnpm workspaces) until profiling proves otherwise.

## Layout (load-bearing map)

```
packages/events      Event schema + (de)serialization  ← the wire format
packages/kernel      Agent loop: goal + model + tools + budget → events
packages/models      Model protocol + FakeModel (offline default)
packages/tools       Tool interface + registry
packages/policy      Pure policy engine (decides, never acts)
packages/sessions    Append-only session/event logs (SQLite + Postgres)
packages/workspace   Path scoping (escape-safe resolution)
packages/mcp         MCP wire shapes + initialize-era stdio client (M2)
packages/acp         Agent Client Protocol types (server in M3)
packages/otel        Event stream -> OTel spans/metrics (M2; kernel/CLI -> collector)
packages/sdk         Task manifest + normal/preflight report contracts
apps/cli             Exit-gate CLI: harness validate | run | bootstrap
apps/tui             Session viewer + interactive ACP permission client
apps/web             UI client (task board; M2)
services/*           control-plane, agent-server, sandbox-runner (M3+)
tasks/               Task manifests (one per dogfooded task) + reports
evals/               Scenario runner + golden-kernel scenarios (M1)
infra/               Docker for local development; Kubernetes production base
skills/              Agent skills for operating this platform
```

## Hard rules

1. **Every dogfooded task ships as a manifest in `tasks/`** — the same
   file that later feeds policy, scheduler, UI, audit, and evals.
   No task without a manifest.
2. **`allowed_paths` is a hard boundary.** Changed files outside it
   block the run. New scope ⇒ new manifest.
3. **Events first.** New observable behavior is an event type in
   `packages/events` before any code renders or consumes it.
4. **Unknown input is a typed error, never a silent fallback.**
5. **Budgets are hard stops** with a `budget.warning` trail.
6. **Policy (`@harness/policy`) is pure functions.** Enforce elsewhere.
7. **Offline-friendly everything.** FakeModel + no network in tests.
   A test that needs the internet fails in CI by design.
8. **One PR per task**, branch `tasks/<id>`, with the **run report
   attached as evidence**.

## Commands

```bash
pnpm test                      # vitest, all packages
pnpm typecheck                 # tsc strict across the workspace
pnpm harness validate tasks/<id>.yaml
pnpm harness run tasks/<id>.yaml
pnpm harness bootstrap tasks/<id>.yaml --approve-write
```

`run` requires the canonical `tasks/<id>.yaml` path and verifies that its
validated id agrees with the exact `tasks/<id>` identity. Local mode switches
to or creates that branch; only trusted CI tuple verification permits detached
HEAD. When the manifest is itself changed, that path is checked against
`allowed_paths` like every other changed path.
`bootstrap` follows canonical task path + exact branch identity → validated
manifest → TaskAgent → pre-test and post-test path gates → report. The
production TaskAgent adapter targets upstream Pi. Deterministic integration
tests inject a builder and exercise the streaming adapter with a spawned
Pi-protocol fixture; they do not execute Pi or a live provider. `--approve-write`
is the explicit resolution for `fs.write: ask`; Pi is launched without a shell in
offline-startup, non-interactive mode, with only the fixed file tools `read`,
`grep`, `find`, `ls`, `edit`, and `write`. Test commands also execute as argv
without a shell.

The Git gate records committed, staged, unstaged, ordinary untracked, and
non-operational ignored changes, plus raw tracked byte/type/mode differences.
It retains both endpoints of detected renames and copies, then rechecks scope
after tests. `tasks/runs/**` is reserved evidence and is outside task scope even
if `allowed_paths` contains `tasks/**`. PR CI selects the manifest matching the
`tasks/<id>` head branch and must pass `--ci-head-ref`, `--head-sha`, and
`--base-ref` together. Normal
outcomes are `run-report/v2` (`run-report/v1` is legacy/read-only);
malformed-manifest and early-Git failures are
`run-preflight-report/v1`.

## Definition of done (for every task, no exceptions)

- [ ] manifest in `tasks/` validated by `harness validate`
- [ ] changes stay inside `allowed_paths`
- [ ] `pnpm test` and `pnpm typecheck` are green
- [ ] exit gate: `harness run` (or the gate in `bootstrap`) → status `passed`
- [ ] run report (`tasks/runs/*.json`) linked in the PR description
- [ ] event stream of the change documented in `EVENTS.md` if new types added

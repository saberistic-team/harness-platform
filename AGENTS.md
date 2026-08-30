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
packages/sessions    Append-only session/event logs (SQLite, node:sqlite)
packages/workspace   Path scoping (escape-safe resolution)
packages/mcp         MCP wire-shape types (client in M2)
packages/acp         Agent Client Protocol types (server in M3)
packages/otel        Event stream -> OTel spans/metrics (M2; kernel/CLI -> collector)
packages/sdk         Task manifest (input contract) + run report (output contract)
apps/cli             Exit-gate CLI:  harness validate | harness run
apps/tui             Read-only session/event viewer (harness-view; M1)
apps/web             UI client (task board; M2)
services/*           control-plane, agent-server, sandbox-runner (M3+)
tasks/               Task manifests (one per dogfooded task) + reports
evals/               Scenario runner + golden-kernel scenarios (M1)
infra/               Docker now, Kubernetes in M4
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
```

## Definition of done (for every task, no exceptions)

- [ ] manifest in `tasks/` validated by `harness validate`
- [ ] changes stay inside `allowed_paths`
- [ ] `pnpm test` and `pnpm typecheck` are green
- [ ] exit gate run: `harness run` → status `passed`
- [ ] run report (`tasks/runs/*.json`) linked in the PR description
- [ ] event stream of the change documented in `EVENTS.md` if new types added

# harness-platform

A dogfooding system in which **the agent builds the harness that runs
the agent**. Every task is a manifest, every run is an event stream, and
every merge is gated by the harness itself.

One language (TypeScript / Node 22 / pnpm workspaces) until profiling
proves otherwise.

## Quick start

```bash
# Node 22+ and a recent pnpm required
pnpm install
pnpm test                       # vitest, all packages
pnpm typecheck                  # tsc strict across the workspace

# The exit gate:
pnpm harness validate tasks/kernel-0001.yaml
pnpm harness run tasks/kernel-0001.yaml
```

## What's here

| Path                 | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `packages/events`    | Event schema + (de)serialization — the wire format          |
| `packages/kernel`    | Agent loop: goal + model + tools + budget → events         |
| `packages/models`    | Model protocol + `FakeModel` (offline default)             |
| `packages/tools`     | Tool interface + registry                                  |
| `packages/policy`    | Pure policy engine (decides, never acts)                   |
| `packages/sessions`  | Append-only session/event logs                             |
| `packages/workspace` | Path scoping (escape-safe resolution)                      |
| `packages/mcp`       | MCP wire shapes + initialize-era stdio client             |
| `packages/acp`       | Agent Client Protocol types                                |
| `packages/otel`      | Event stream → OpenTelemetry spans and metrics             |
| `packages/sdk`       | Task manifest (input) + run report (output) contracts      |
| `apps/cli`           | Exit-gate CLI: `harness validate` \| `harness run`         |
| `apps/tui`           | Read-only session and run-report viewer                    |
| `apps/web`           | Read-only task board                                       |
| `tasks/`             | Task manifests + run reports (evidence)                    |
| `evals/`             | Golden repos + scenarios                                   |
| `skills/`            | Agent skills for operating this platform                   |

## Docs

- [`AGENTS.md`](AGENTS.md) — rules of engagement (read this first)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the package contract
- [`EVENTS.md`](EVENTS.md) — the event stream reference
- [`ROADMAP.md`](ROADMAP.md) — milestones (M0–M2 ✅)
- [`SECURITY.md`](SECURITY.md) — sandbox and boundary model

## Definition of done

Every task, no exceptions:

- [ ] manifest in `tasks/` passes `harness validate`
- [ ] changes stay inside `allowed_paths`
- [ ] `pnpm test` and `pnpm typecheck` green
- [ ] exit gate: `harness run` → status `passed`
- [ ] run report (`tasks/runs/*.json`) linked in the PR
- [ ] new event types documented in `EVENTS.md`

## Status

M0–M2 are complete: foundation, operator loop, and eval credibility.
See [ROADMAP](ROADMAP.md) for the services milestone (M3) and what follows.

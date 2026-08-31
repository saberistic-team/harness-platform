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
| `packages/models`    | Model protocol, `FakeModel`, OpenAI-compatible adapter      |
| `packages/tools`     | Tool interface + registry                                  |
| `packages/policy`    | Pure policy engine (decides, never acts)                   |
| `packages/sessions`  | Append-only session/event logs                             |
| `packages/workspace` | Path scoping (escape-safe resolution)                      |
| `packages/mcp`       | MCP wire shapes + initialize-era stdio client             |
| `packages/acp`       | Agent Client Protocol types                                |
| `packages/otel`      | Event stream → OpenTelemetry spans and metrics             |
| `packages/sdk`       | Task manifest (input) + run report (output) contracts      |
| `apps/cli`           | Exit-gate CLI: `harness validate` \| `harness run`         |
| `apps/tui`           | Session viewer + interactive ACP permission client         |
| `apps/web`           | Read-only task board                                       |
| `services/agent-server` | ACP JSON-RPC over WebSocket; one run per session       |
| `services/sandbox-runner` | Hardened Docker-per-run execution boundary          |
| `tasks/`             | Task manifests + run reports (evidence)                    |
| `evals/`             | Golden repos + scenarios                                   |
| `skills/`            | Agent skills for operating this platform                   |

## Docs

- [`AGENTS.md`](AGENTS.md) — rules of engagement (read this first)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the package contract
- [`EVENTS.md`](EVENTS.md) — the event stream reference
- [`ROADMAP.md`](ROADMAP.md) — milestones (M0–M3 ✅)
- [`SECURITY.md`](SECURITY.md) — sandbox and boundary model

## Definition of done

Every task, no exceptions:

- [ ] manifest in `tasks/` passes `harness validate`
- [ ] changes stay inside `allowed_paths`
- [ ] `pnpm test` and `pnpm typecheck` green
- [ ] exit gate: `harness run` → status `passed`
- [ ] run report (`tasks/runs/*.json`) linked in the PR
- [ ] new event types documented in `EVENTS.md`

## M3 local service loop

The server binds to loopback by default and uses `FakeModel` until provider
configuration is supplied at its process boundary:

```bash
node services/agent-server/bin/agent-server.js --root . --port 8765
node apps/tui/bin/view.js connect ws://127.0.0.1:8765/acp \
  --workspace . --task m3-services "Inspect the task"
```

Set `HARNESS_MODEL_ID` and `HARNESS_MODEL_BASE_URL` together to advertise an
OpenAI-compatible provider model. Optional server-side `OPENAI_API_KEY`,
`OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID` values are treated as opaque header
credentials: blank, padded, or unsafe values fail startup. Keys never enter ACP
requests, manifests, events, or sandbox environments.

Set `HARNESS_SANDBOX_IMAGE` to an immutable `@sha256:` image reference to add
the built-in `sandbox_exec` tool for task-backed sessions. For a reviewed local
development tag only, also set `HARNESS_SANDBOX_TRUST_LOCAL_IMAGE=true`.
`HARNESS_DOCKER_HOST` may select a local `unix:///...` socket; remote Docker
contexts are rejected.

Remote listeners require `HARNESS_AGENT_TOKEN` and
`HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE=true`. The acknowledgement does not
encrypt traffic: put the listener behind a TLS reverse proxy, connect through
`wss://`, and configure the proxy not to log query strings. The TUI reads the
same token from its environment.

## Status

M0–M3 are complete: foundation, operator loop, eval credibility, and the
permissioned service boundary. See [ROADMAP](ROADMAP.md) for the M4 control
plane and scale milestone.

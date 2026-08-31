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
| `packages/sessions`  | Append-only SQLite/Postgres session and event stores       |
| `packages/workspace` | Path scoping (escape-safe resolution)                      |
| `packages/mcp`       | MCP wire shapes + initialize-era stdio client             |
| `packages/acp`       | Agent Client Protocol types                                |
| `packages/otel`      | Event stream → OpenTelemetry spans and metrics             |
| `packages/sdk`       | Task manifest (input) + run report (output) contracts      |
| `apps/cli`           | Exit-gate CLI: `harness validate` \| `harness run`         |
| `apps/tui`           | Session viewer + interactive ACP permission client         |
| `apps/web`           | Read-only task board                                       |
| `services/agent-server` | ACP JSON-RPC over WebSocket; one run per session       |
| `services/control-plane` | Fenced scheduler, task state, artifacts, audit export  |
| `services/sandbox-runner` | Hardened Docker-per-run execution boundary          |
| `infra/kubernetes`   | Production service topology and sandbox Job contract       |
| `tasks/`             | Task manifests + run reports (evidence)                    |
| `evals/`             | Golden repos + scenarios                                   |
| `skills/`            | Agent skills for operating this platform                   |

## Docs

- [`AGENTS.md`](AGENTS.md) — rules of engagement (read this first)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the package contract
- [`EVENTS.md`](EVENTS.md) — the event stream reference
- [`ROADMAP.md`](ROADMAP.md) — milestones (M0–M4 ✅)
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

## M4 control-plane loop

For explicit offline development, start the control plane with its in-memory
repository and object store:

```bash
HARNESS_CONTROL_PLANE_IN_MEMORY=true \
  node services/control-plane/bin/control-plane.js --host 127.0.0.1 --port 8780
```

Production mode requires `HARNESS_DATABASE_URL` (or `DATABASE_URL`) plus the
`HARNESS_ARTIFACT_*` endpoint, bucket, region, and credentials. Postgres is the
shared source for sessions, events, tasks, runs, leases, and the transactional
event outbox. Object bytes live in S3-compatible storage; signed URLs are
generated on demand and never persisted. Point agent-server at the same
database to enable cross-replica ACP restore, but use a distinct least-privilege
runtime role and therefore a distinct credential-bearing URL in production.

Render the production reference topology without contacting a cluster:

```bash
kubectl kustomize infra/kubernetes
```

The checked-in Kubernetes base deliberately contains invalid image, secret,
and storage-class placeholders. Follow
[`infra/kubernetes/README.md`](infra/kubernetes/README.md) to build a reviewed
environment overlay; do not apply the base directly.

## Status

M0–M4 are complete: foundation, operator loop, eval credibility, the
permissioned service boundary, and the durable control plane. See
[ROADMAP](ROADMAP.md) for the conditional M5 polyglot review.

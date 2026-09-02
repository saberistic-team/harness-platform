# harness-platform

A dogfooding system in which **the agent builds the harness that runs
the agent**. Every task is a manifest, every run is an event stream, and
every task produces harness gate evidence. Pull-request CI is designed to gate
merges when repository branch protection marks its gate job as required.

One language (TypeScript / Node 22 / pnpm workspaces) until profiling
proves otherwise.

## Quick start

```bash
# Node 22+, a recent pnpm, and a Pi CLI using JSON protocol v3 for bootstrap
pnpm install
pnpm test                       # vitest, all packages
pnpm typecheck                  # tsc strict across the workspace

# Validate or gate work that already exists:
pnpm harness validate tasks/<id>.yaml
pnpm harness run tasks/<id>.yaml

# Build with upstream Pi, then run the same gate:
pnpm harness bootstrap tasks/<id>.yaml --approve-write
```

`bootstrap` follows one auditable contract: canonical task path + exact
`tasks/<id>` identity → authoritative validated manifest → TaskAgent builder →
pre-test and post-test scope gates → structured report. Its production adapter
targets upstream Pi and validates JSON protocol v3. Pi 0.84.x is the documented
compatibility target, not an executable-version check. Deterministic tests prove
the harness composition and production streaming-adapter contract with an
injected TaskAgent and a spawned Pi-protocol fixture. They do not execute the
installed Pi binary or call a live model provider.
`--approve-write` explicitly resolves a manifest
`fs.write: ask` decision for that attempt. The Pi adapter starts in Pi's
offline-startup, non-interactive mode without a shell and exposes only the
fixed file tools `read`, `grep`, `find`, `ls`, `edit`, and `write`. A configured
model provider may still require network access. Test commands are likewise
parsed into a single executable plus argv and are never interpreted by a shell.

Both `run` and `bootstrap` require the canonical `tasks/<id>.yaml` manifest and
derive `tasks/<id>` from it; a free-form branch label is not accepted. Local
mode switches to or creates that exact branch. A detached checkout is accepted
only in CI when the head ref, head object ID, and base supplied by trusted CI
event data all verify. A changed manifest is checked against `allowed_paths`
like every other changed path. Their stable Git samples cover committed,
staged, unstaged, ordinary untracked, and non-operational ignored changes,
including raw tracked byte, type, and executable-mode differences.
Detected renames and copies retain their source and destination, and the path
gate is rerun after tests so a test cannot leave an out-of-scope write behind.
`tasks/runs/**` is reserved for harness evidence and is never writable task
scope, even when a manifest otherwise allows `tasks/**`.

Pull-request CI chooses `tasks/<id>.yaml` from the `tasks/<id>` head branch and
supplies the trusted Git tuple together:

```bash
pnpm harness run tasks/<id>.yaml \
  --ci-head-ref tasks/<id> \
  --head-sha <full-head-sha> \
  --base-ref <full-base-sha>
```

Normal gated outcomes use the attestable `run-report/v2`. Historical
`run-report/v1` artifacts remain readable but are not accepted as current gate
evidence. An attempt that cannot establish a
valid manifest or Git preflight uses `run-preflight-report/v1`, so even an
early failure leaves structured evidence. Reports are committed by atomic
rename. Durable-session or report-write failure can never return `passed`; a
failed preferred write falls back to a temporary artifact, and
`deliverables.reportWritten` distinguishes a committed artifact from the
validated in-memory last resort. New normal reports also reject contradictory
branch, scope, test, failure, Git, or `run.recorded` receipt evidence.

## What's here

| Path                 | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `packages/events`    | Event schema + (de)serialization — the wire format          |
| `packages/kernel`    | Agent loop: goal + model + tools + budget → events         |
| `packages/models`    | Model protocol, `FakeModel`, OpenAI-compatible adapter      |
| `packages/tools`     | Tool interface + registry                                  |
| `packages/policy`    | Pure policy engine (decides, never acts)                   |
| `packages/sessions`  | SQLite/Postgres session stores, append-only event logs, fenced checkpoints |
| `packages/workspace` | Canonical operational contract plus the legacy lexical path-scope helper; adapters begin in M9 |
| `packages/mcp`       | MCP wire shapes + initialize-era stdio client             |
| `packages/acp`       | Harness ACP-shaped protocol/client; official stdio ACP is planned |
| `packages/otel`      | Event stream → OpenTelemetry spans and metrics             |
| `packages/sdk`       | Task manifest + normal/preflight report contracts          |
| `apps/cli`           | Exit-gate CLI: `harness validate` \| `run` \| `bootstrap` |
| `apps/tui`           | Session viewer + interactive ACP permission client         |
| `apps/web`           | Read-only task board                                       |
| `services/agent-server` | `harness/acp/1` JSON-RPC over WebSocket; legacy run seam |
| `services/control-plane` | Fenced scheduler, task state, artifacts, audit export  |
| `services/sandbox-runner` | Hardened Docker-per-run execution boundary          |
| `infra/kubernetes`   | Fail-closed service topology and suspended sandbox Job contract |
| `tasks/`             | Task manifests + run reports (evidence)                    |
| `evals/`             | Golden repos + scenarios                                   |
| `skills/`            | Agent skills for operating this platform                   |

## Docs

- [`AGENTS.md`](AGENTS.md) — rules of engagement (read this first)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the package contract
- [`EVENTS.md`](EVENTS.md) — the event stream reference
- [`ROADMAP.md`](ROADMAP.md) — milestones (M0–M8 complete; M9–M76 planned)
- [`SECURITY.md`](SECURITY.md) — sandbox and boundary model

## Definition of done

Every task, no exceptions:

- [ ] manifest in `tasks/` passes `harness validate`
- [ ] changes stay inside `allowed_paths`
- [ ] `pnpm test` and `pnpm typecheck` green
- [ ] exit gate: `harness run` (or the gate in `harness bootstrap`) → `passed`
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
`HARNESS_MODEL_TIMEOUT_MS` may raise the default 60-second provider deadline
for large local models; it must be a positive decimal integer and is accepted
only when both provider selectors are configured.

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

M0–M8 are complete: foundation, operator-loop governance, eval credibility,
service/isolation seams, the durable control-plane domain and deployment
contracts, the conditional language review, runtime contracts, and the
deterministic minimal session loop, followed by the enforced operational
workspace capability boundary. M5 found no measured reason to add a second
runtime, so the platform remains TypeScript / Node ≥ 22. M9–M76 remain planned.
See
[ROADMAP](ROADMAP.md) for the milestone record and
[ARCHITECTURE](ARCHITECTURE.md#m5-decision--retain-typescriptnode) for the
language decision and reopening criteria. M16 integrates the native self-host
path offline, M17 proves its authorship attestation, M18 activates it with a
live repository change, and every M19+ implementation milestone must then be
authored by the latest qualified platform revision through the progressively
ratcheted path.

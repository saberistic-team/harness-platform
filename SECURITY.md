# SECURITY.md

## Threat model (short version)

The system runs models (potentially adversarial or buggy) that can
propose tool calls and shell commands. Their output is **data, never
control**, until explicitly elevated by policy.

Trusted:
- task manifest authors (humans, reviewed)
- the harness code itself
- policy decisions

Untrusted:
- model output (prompt content, tool arguments)
- unreviewed task manifests
- third-party MCP servers
- anything arriving over the network

## Policy semantics (the load-bearing part)

```
effect:  allow | ask | deny
default when NO rule exists ..........: ask    (never silent allow)
subject with pattern, no * ..........: deny   (closed for exec)
```

- `ask` in headless runs blocks unless the operator pre-approves;
  in interactive runs it prompts. There is no mode where `ask`
  silently becomes `allow`.
- Manifest `permissions` are the **only** place rules live. The
  sandbox-runner enforces decisions; it adds no private rules of its own.
- Patterns are enforced through the **rule compiler**
  (`compileRules()` in `@harness/policy`): one compiled regex per
  pattern, one decision table per manifest — the CLI and the
  sandbox-runner enforce the same table, never per-check
  string rescans.

## Enforcement layers (defense in depth)

1. **Kernel loop** — enforces budgets; refuses to run tools not in the
   registry; validates tool input schemas before execution.
2. **CLI / agent-server** — task scope and reviewed tool boundaries. The CLI
   gates changed paths before test/exec; the service admits only pure,
   workspace-read, or Docker-sandboxed tools with matching boundaries.
3. **Sandbox-runner (M3, shipped)** — one container per run; network namespace
   isolated by default (`network: deny` unless the manifest has a rule);
   filesystem mounts scoped by `allowed_paths`; no host secrets in env.
4. **Infrastructure** — service and sandbox images are referenced immutably;
   Kubernetes defaults to deny ingress and egress, grants only named service
   edges, and gives no M4 workload Kubernetes API credentials. The suspended
   sandbox Job template is a contract, not an executor. A future executor
   overlay must add narrowly scoped Job permissions explicitly. The model
   sandbox never receives a Docker socket or Kubernetes token.

## Secrets

- Never commit populated secret values to manifests, events, or run reports.
  The Kubernetes `secret.*.example.yaml` files are excluded key contracts with
  fail-closed sentinel values, not deployable credentials.
- Provider keys are injected at the process boundary of
  `agent-server` from environment/secret store — not from the kernel.
- Event payloads of type `tool.call`/`tool.result` are **redacted**
  before they leave the process boundary: `packages/events` supplies the
  deterministic redaction pass and agent-server applies it before SQLite or
  ACP WebSocket output. Provider errors are sanitized before becoming events.

## M3 container boundary

- The host workspace is mounted read-only. Only exact files or explicit
  `directory/**` entries from `allowed_paths` may become writable submounts.
- Traversal, absolute paths, wildcard shapes that require overgranting,
  symlinks, hard links, devices, sockets, and missing sources fail closed.
- Containers run as the non-root uid/gid that owns the workspace, with a
  read-only root filesystem, dropped capabilities, `no-new-privileges`, bounded
  PID/CPU/memory, and a constrained tmpfs. Root-owned workspaces are rejected.
  The Docker socket is never mounted into the sandbox.
- Network is `none` unless the compiled flat `network` rule resolves to allow.
  Docker bridge cannot express host-pattern egress; patterned rules are
  rejected rather than widened.
- The trusted Docker client receives a small allow-list of host variables;
  none are forwarded into the untrusted container.
- Docker image references require a digest. A mutable tag is accepted only with
  an explicit reviewed-local-image attestation; runs use `--pull never`.
- Only a local Unix Docker socket is accepted. The client runs with isolated
  `HOME`/`DOCKER_CONFIG`, so user contexts, credential helpers, and proxy
  injection do not cross the boundary.

The Docker daemon and reviewed sandbox image remain trusted infrastructure.
The image must not declare a `VOLUME` that can obscure a scoped mount. Mount
identity and contents are fingerprinted and synchronously rechecked immediately
before spawn, but a more privileged process concurrently mutating the workspace
is outside this local boundary's threat model.

When sandbox execution is enabled, the agent-server keeps its durable audit
store outside the mounted workspace (SQLite locally, Postgres when deployed)
and rejects an in-workspace SQLite override. This prevents an otherwise broad
`allowed_paths` entry from exposing the audit store to a model-controlled
container.

## M4 control-plane boundary

- Postgres events are append-only and use canonical per-session sequence
  numbers, a store-wide commit-ordered audit cursor, and unique event IDs.
  Run workers mutate state only with the current secret lease ID and fencing
  token; PostgreSQL time defines expiry, and general run reads redact those
  credentials. Expired or stale workers cannot commit results.
- Append-only triggers and immutable registry rows are effective only when the
  runtime database roles cannot alter their schema. The checked-in reference
  auto-migrates for development; a production overlay must run migrations with
  a separate credential, then use distinct control-plane and agent-server roles
  with no DDL or schema ownership, as described in `infra/kubernetes/README.md`.
- Control-plane state, artifact, and audit bookkeeping events enter a durable
  outbox in the same database transaction as the mutation. Publishing is
  idempotent by event ID and acknowledgement happens only after the canonical
  session store accepts the event.
- Task rows store a validated manifest snapshot and digest, and an admission
  key cannot be reused for different bytes. Keeping reviewed dogfooded task
  definitions in Git is an organizational/admission-gateway invariant; the
  control-plane API does not independently prove Git provenance.
- Artifacts are content-addressed and checksum-verified before immutable
  metadata is registered; Postgres rejects registry updates/deletes, and an S3
  conditional-conflict retry hashes the existing bytes instead of trusting
  custom metadata. The signing secret stays at the service boundary. SigV4
  URLs necessarily contain an access-key identifier and may contain a session
  token, so the full URL is a short-lived bearer capability; it is never stored
  in events, reports, logs, or the registry.
- Audit exports are automatically drained deterministic JSONL projections of
  the already-redacted canonical event stream. Oversized pages are split before
  commit. The checkpoint advances only after both object upload and registry
  commit succeed, so retrying cannot skip evidence.
- ACP restore accepts a last-seen sequence cursor and replays only committed
  later events. Appends, heartbeat renewal, and normal closure require the
  recorded owner and an unexpired lease. If the prior process died with an
  active nonterminal session, restoration records an interrupted outcome and
  closes it atomically. It never repeats an incomplete model request,
  permission grant, or tool side effect; retry is a new reviewed run with a new
  lease. External side effects still require provider idempotency keys or
  operator reconciliation—the harness does not claim arbitrary exactly-once
  execution.

## Control-plane transport and authorization

- Loopback is the default. A non-loopback control-plane listener requires its
  bearer token and must sit behind a TLS-terminating gateway whose logs redact
  `Authorization` and signed-URL query strings.
- M4 has one control-plane bearer-token trust domain. That token authenticates
  every non-health worker, operator, artifact, audit-export, and signed-URL
  route; it is not role-based authorization. Do not distribute it to mutually
  untrusted workers or tenants. A production gateway must constrain callers to
  that trust domain until route-scoped service identities are implemented.

## Agent-server transport

- Loopback is the default and browser origins are denied unless allow-listed.
- A non-loopback listener requires `HARNESS_AGENT_TOKEN` and the explicit
  `HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE=true` acknowledgement. That flag does
  not add encryption: terminate TLS at a reverse proxy and expose `wss://`.
- The current token is carried in the WebSocket upgrade query. Configure proxy
  access logs to redact query strings, and prefer `HARNESS_AGENT_TOKEN` in the
  TUI environment over the `--token` argument to avoid shell-history exposure.

## Supply chain

- Only `pnpm` workspaces; `pnpm-lock.yaml` is committed;
  `--frozen-lockfile` in CI and in Docker.
- No dynamic `require`/`import` of untrusted paths.
- Dependency changes require lockfile and provenance review. Automated registry
  vulnerability auditing remains release-pipeline work; the deterministic task
  lane itself has network access denied.

## Reporting

Security-relevant bugs: open a **private** issue on the owning repo,
tag `security`. Do not write the vulnerability in run reports, events,
or manifests. The audit log is *evidence of operations*, not a place to
disclose findings.

## Known open questions (tracked in ROADMAP.md)

- ~~Egress/exec rule compilation and sandbox enforcement (M3)~~ — shipped.
  `compileRules()` decides; sandbox-runner enforces. Network subject maps that
  Docker cannot represent are typed failures, never implicit bridge access.
- ~~Replay-safe session restore when an agent dies mid-turn (M4)~~ — shipped as
  cursor-based committed-event replay with fail-closed interrupted-turn
  reconciliation. Arbitrary tool execution is deliberately not claimed to be
  exactly-once.
- ~~Redaction pass before agent-server crosses a process boundary (M3)~~ —
  shipped in `@harness/events` and applied by agent-server.

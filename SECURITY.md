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
4. **Infrastructure** — the sandbox Dockerfile requires an immutable Node base
   reference; no `RUN` with
   network secrets; MinIO in the local compose file is dev-only and is
   not reachable from the model's sandbox.

## Secrets

- Never in manifests, never in events, never in run reports.
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

When sandbox execution is enabled, the agent-server keeps its SQLite audit
database outside the mounted workspace and rejects an in-workspace override.
This prevents an otherwise broad `allowed_paths` entry from exposing the audit
store to a model-controlled container.

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
- `npm audit` at publish time (M4); dependency review on any new dep.

## Reporting

Security-relevant bugs: open a **private** issue on the owning repo,
tag `security`. Do not write the vulnerability in run reports, events,
or manifests. The audit log is *evidence of operations*, not a place to
disclose findings.

## Known open questions (tracked in ROADMAP.md)

- ~~Egress/exec rule compilation and sandbox enforcement (M3)~~ — shipped.
  `compileRules()` decides; sandbox-runner enforces. Network subject maps that
  Docker cannot represent are typed failures, never implicit bridge access.
- Replay-safe session restore when an agent dies mid-turn (M4).
- ~~Redaction pass before agent-server crosses a process boundary (M3)~~ —
  shipped in `@harness/events` and applied by agent-server.

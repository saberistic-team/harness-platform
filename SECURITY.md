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
2. **CLI / agent-server** — path allow-list gate before test/exec
   (see `apps/cli/src/run.ts`); branch isolation per task.
3. **Sandbox-runner (M3)** — one container per run; network namespace
   isolated by default (`network: deny` unless the manifest has a rule);
   filesystem mounts scoped by `allowed_paths`; no host secrets in env.
4. **Infrastructure** — Docker images pin Node base; no `RUN` with
   network secrets; MinIO in the local compose file is dev-only and is
   not reachable from the model's sandbox.

## Secrets

- Never in manifests, never in events, never in run reports.
- Provider keys are injected at the process boundary of
  `agent-server` from environment/secret store — not from the kernel.
- Event payloads of type `tool.call`/`tool.result` are **redacted**
  before they leave the process boundary (M3): secret scanner on the
  serializer boundary, tests in `packages/events`.

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

- ~~Egress allow-list pattern for sandboxed `process.exec` (M3)~~
  — the pattern → rule **compiler** landed in M1
  (`compileRules()` in `@harness/policy`); container-level egress
  enforcement rides on it when the sandbox-runner ships in M3.
- Replay-safe session restore when an agent dies mid-turn (M4).
- Redaction pass on `tool.call` payloads (M3, before agent-server
  crosses a process boundary).

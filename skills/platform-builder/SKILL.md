---
name: platform-builder
description: Build, run, and extend the harness platform. Use when creating task manifests, running the exit gate, debugging kernel/event/policy behavior, or adding packages and services to the harness-platform monorepo.
---

# platform-builder

Operating skill for the `harness-platform` monorepo (dogfooding the
harness to build the harness).

## Invariants (do not break these)

1. **One task = one manifest = one branch = one PR.** Manifests live in
   `tasks/`; branch naming is `tasks/<id>`; the exit gate enforces the
   mapping. Never modify another task's manifest.
2. **`allowed_paths` is a hard boundary.** The runner
   (`apps/cli/src/run.ts`) blocks any run whose changed files escape
   the manifest's globs. A task that needs to touch more paths gets a
   new manifest, not a looser one.
3. **Policy decisions are pure.** `@harness/policy` decides; it never
   acts. Enforcement lives in the kernel loop, the CLI, and eventually
   the sandbox-runner boundary. Keep it that way.
4. **Events are the wire format.** Anything observable is a harness
   event from `@harness/events` with a fixed envelope
   (`v, type, eventId, at, actor?, data`). UIs, the audit log, and the
   eval harness all consume the same stream. New behavior → new event
   type first, rendering second.
5. **Unknown is typed, never silent.** `EventVersionError`,
   `UnknownEventTypeError`, `EventSchemaError`, `ManifestParseError` —
   if a parser can't recognize something, it throws a specific error
   and preserves the raw input.
6. **Budgets are hard.** Token and tool-call limits stop the loop with
   `budget_exceeded` and a `budget.warning` trail.
7. **One language until profiling says otherwise.** TypeScript/Node 22
   across the board. A new runtime must be justified by a profile, not
   by symmetry with a reference project.

## Commands

| What                          | Command                          |
| ----------------------------- | -------------------------------- |
| unit + integration tests      | `pnpm test`                      |
| typecheck                     | `pnpm typecheck`                 |
| validate a task manifest      | `pnpm harness validate tasks/<id>.yaml` |
| run the exit gate             | `pnpm harness run tasks/<id>.yaml`    |
| run a subset of tests         | `pnpm test <pkg-or-file-filter>`     |

## Workflow for a new platform task

1. Write the manifest under `tasks/` (see `tasks/README.md` for shape).
2. Validate it: `pnpm harness validate tasks/<id>.yaml`.
3. Work on `tasks/<id>`, only inside `allowed_paths`.
4. Green tests, then run the exit gate:
   `pnpm harness run tasks/<id>.yaml`.
5. Attach the current `run-report/v2` report and its patch/event artifacts
   as PR evidence. `run-report/v1` is legacy read-only data, never acceptable
   evidence for a new task.

## Native builder path (M15–M17)

`harness bootstrap tasks/<id>.yaml --native-image <image@sha256:digest>`
uses the exact `MinimalAgentRuntime` TaskAgent entrypoint. `HARNESS_NATIVE_IMAGE`
can supply the pinned image. Missing Docker/image configuration fails closed;
there is no local execution fallback. The default model is deterministic
FakeModel; injected reviewed model adapters use the same kernel. The offline
integration test supplies a deterministic Docker protocol executor. It does not
claim a live provider or Docker deployment gate.

The trusted CLI validates the canonical manifest, selects or creates exactly
`tasks/<id>`, checks pre/post scope, applies the sandbox patch, runs tests, and
writes the report. The model has only `fs.read`, `fs.list`, `fs.write`,
`process.exec`, and `git.diff`. It has no branch or commit tool. Resolve an
`fs.write: ask` with `--approve-write`; other unresolved asks remain denied.
The explicit `--pi-bin` option retains the legacy adapter for compatibility;
its free-form builder name cannot produce native authorship evidence.

Start native authorship from a clean base. The sole permitted pre-existing
change is `tasks/<id>.yaml`, whose immutable bytes are the manifest control
input. Pre-authored source, including staged and committed task changes, must
return to a clean input rather than being claimed by the builder. Generated
scope and tree are rechecked after tests.

Native reports include `native-builder/v1`, pre/post Git snapshots, a
content-addressed builder source revision (platform TypeScript sources and
lockfile), pinned image, manifest digest, input base, workspace snapshots,
model/session/run identities, and patch/event digests. They carry an Ed25519
seal over the whole v2 report. For portable PR/CI evidence, give the trusted
CLI `--native-signing-key <private.pem>` outside the sandbox. Without it the
process uses an ephemeral local key; its public key must be pinned separately
before verification. Never establish CI trust from the key inside a report.

Verify the candidate and accepted result with:

```
pnpm harness verify-native <report.json> --trusted-key <public.pem> --candidate <commit> --accepted <commit> --accepted-base <commit>
```

The candidate must equal the generated tree. Accepted merge/squash/rebase
output must have the exact attested patch relative to its trusted input base.
Archive the returned `native-acceptance/v1` binding with CI evidence. Human
conflict edits return the task to the builder. This mechanism qualifies the
path for M18; M17 is not a qualified self-hosted builder and does not activate
the ratchet.

For restart, `MinimalAgentRuntime.continue` requires a durable safe checkpoint,
unchanged tool definitions and workspace snapshot, and an expired owner lease.
SQLite/Postgres atomically fence the old owner and claim the safe cursor.
Original run/turn identities and counters survive. Any uncertain segment is
recorded interrupted and cannot execute again automatically. A new follow-up
after a completed turn uses `restoreSession` and a fresh run/turn identity.

## Gotchas

- `tasks/runs/*.json` reports are gitignored; they are build evidence,
  not source.
- The CLI's `--test-cmd` override is for CI/dev only; the manifest's
  `permissions["process.exec"]` still applies to it (a denied test
  command blocks the run).
- Event envelope version is `1`; adding a new major version requires
  updating `SUPPORTED_EVENT_VERSIONS` and the EVENTS.md table.
- FakeModel is the default model for everything offline. When you need
  a real provider, add an adapter in `packages/models` — never fork the
  kernel loop.

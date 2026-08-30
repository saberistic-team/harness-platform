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
5. The structured report (run-report/v1) is the PR's evidence — attach
   it, do not paraphrase it.

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

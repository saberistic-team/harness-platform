# Golden repositories

Small, self-contained target projects the eval system (and agents)
work on. Rules:

- One directory per golden repo, with a `SPEC.md` describing what a
  correct solution looks like.
- Each must build and test green with only `pnpm` + Node ≥ 22.
- No network at build/test time.
- Keep them tiny (< 500 LOC); they are calibration targets, not apps.

## Status

None yet. First candidate (M2): `hello-service/` — a single-file HTTP
server with an integration test, used to calibrate task→PR→report
throughput and event-stream fidelity.

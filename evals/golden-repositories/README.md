# Golden repositories

Small, self-contained target projects the eval system (and agents)
work on. Rules:

- One directory per golden repo, with a `SPEC.md` describing what a
  correct solution looks like.
- Each must build and test green with only `pnpm` + Node ≥ 22.
- No network at build/test time.
- Keep them tiny (< 500 LOC); they are calibration targets, not apps.

## Status

- `hello-service/` — **landed (M2)**. Single-file HTTP server
  (`node:http`, zero deps) with a `SPEC.md` contract and an offline
  integration test (`node --test`). The eval system's first
  calibration target for task→PR→report throughput and
  event-stream fidelity.
  - task: `tasks/m2-golden-hello-service.yaml`

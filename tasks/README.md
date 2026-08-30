# Tasks

Each dogfooded task is a YAML manifest (a **task contract**) in this
directory. The manifest is the single machine-readable source of truth
for that task and is consumed by:

| Consumer    | Uses                                                        |
| ----------- | ----------------------------------------------------------- |
| policy engine (`@harness/policy`) | `permissions`, `allowed_paths`   |
| scheduler / CLI     | `id`, `budget`, `delivery`, `goal`                        |
| UI (TUI/WUI)        | `title`, `goal`, `acceptance`, run reports                |
| audit log           | `id` links every `policy.decision` / `run.recorded` event |
| eval system         | `acceptance` + `evals/scenarios`                           |

## Shape

```yaml
id: kebab-case-identifier    # stable, kebab-case, unique per repo
title: Human readable title
goal: >
  What "done" means, in prose.
acceptance:
  - Concrete, testable acceptance criterion
allowed_paths:
  - packages/events/**       # globs the task may modify
permissions:                 # action -> effect | {subject glob -> effect}
  fs.read: allow
  process.exec:
    "pnpm test*": allow
    "*": deny
  network: deny
budget:
  max_model_tokens: 100000
  max_tool_calls: 100
delivery:
  type: pull_request         # pull_request | merge | artifact | none
```

## Run the exit gate

```bash
pnpm harness validate tasks/kernel-0001.yaml   # schema gate
pnpm harness run tasks/kernel-0001.yaml        # full gate: branch → policy → tests → report
```

The run report is written to `tasks/runs/<id>-<timestamp>.json` (see
`run-report/v1` in `@harness/sdk`).

## Rules of the road

- One task = one manifest = one branch (`tasks/<id>`) = one PR.
- `allowed_paths` is a hard boundary: the runner blocks runs whose
  changes escape it. No exceptions inside the engine.
- `network: deny` unless the task explicitly needs an egress rule.
- Budgets are hard: the kernel stops with `budget_exceeded` and a
  `budget.warning` event trail.
- Never edit a merged task's manifest; open a new one and reference the
  old id in `goal`.

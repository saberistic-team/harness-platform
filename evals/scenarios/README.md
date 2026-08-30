# Scenarios

Scenario files are the eval system's test cases: a task manifest plus
the observable invariants a correct run must produce.

Shape (YAML; the M1 runner implements this subset — the canonical
DSL validation lands in `@harness/sdk` in M2):

```yaml
id: scenario-event-roundtrip
uses_tasks:
  - kernel-0001
expect:
  run.status: passed
  events:
    - type: agent.stopped
      data.status: completed
  report:
    status: passed
```

## Rules

- A scenario asserts on **events and the report**, never on agent
  internals — that keeps evals stable across kernel refactors.
- `FakeModel` is the canonical model for deterministic scenarios.
- Flaky scenarios fail CI; they do not get retried.

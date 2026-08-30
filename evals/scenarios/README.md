# Scenarios

Scenario files are the eval system's test cases: a task manifest plus
the observable invariants a correct run must produce.

Shape (YAML, validated in M2 by `@harness/sdk`):

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

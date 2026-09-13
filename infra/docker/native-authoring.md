# Native authoring: diagnose failures before rewriting

Read the task manifest and relevant contracts before editing. This guide does
not supply the implementation: the native model authors the task source.

A minimal valid task manifest must include `delivery`:

```yaml
id: diagnostic-fixture
title: Diagnostic fixture
goal: Exercise manifest parsing offline
acceptance:
  - The fixture parses successfully
allowed_paths:
  - src/**
permissions:
  fs.read: allow
  fs.write: deny
delivery:
  type: none
```

`budget` is optional; `delivery` is required. Confirm fixtures using the real
SDK parser. An invalid fixture is not evidence that the diagnostic is broken.

When asserting a diagnostic status, include the entire diagnostic as the
assertion message, for example `expect(result.status, JSON.stringify(result))`.
This exposes the parser's field-level error instead of only “invalid vs valid”.
For database checks compare the complete file bytes, not just its size.

After a failed check:

1. Read the actual error and identify the violated contract. Do not guess at
   YAML indentation when the parser reports a missing field.
2. Make one targeted correction, preserving unrelated tests and behavior.
3. Run the same focused check immediately. Do not rewrite the same file again
   before checking the correction. Never weaken an assertion to hide a failure.
4. If the same failure remains, inspect the relevant contract once. If the task's
   check limit is exhausted, return the failure honestly and stop. Do not loop.

Keep source and tests compact. Cover every required edge case explicitly,
including whitespace-only configuration, untracked Git files, packed refs and
linked worktrees when requested. A copied tool-name array does not test the
canonical catalog; import the actual export. A status-only assertion with no
error details does not provide actionable failure feedback.

Use `fs.read` with `startLine` (1-based) and `maxLines` (1–400) to inspect
source excerpts. Start with about 80 lines and request another range only when
needed. Range results include `startLine`, `endLine`, `totalLines`, `totalSize`,
and `hasMore`; `size` counts returned UTF-8 bytes. Omit both range arguments only
when you need the full file, such as before replacing it with `fs.write`.
This limits model context, not filesystem authorization or workspace read limits.

For the manual Ollama Qwen3.8 lane, record the exact model digest and request
profile with the evidence. The model's thinking sampling profile is temperature
1.0 and top_p 0.95; use an explicitly supported reasoning effort such as medium.
The local Ollama API maps reasoning_effort none to disabled thinking. Do not
silently force temperature zero or assume that disabling thinking is required
for tool use. Confirm settings against the installed model and server:
https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/README.md

The compatible adapter retains Ollama's optional reasoning field in assistant
history and native durable checkpoints. Keep this provider state separate from
answer text. Verify a small denial → failed check → correction → passing check
fixture before a full live authoring run. A successful fixture establishes
adapter operation; it does not qualify the M18 builder or prove that sampling
settings alone fix an authoring failure. CI remains entirely offline.

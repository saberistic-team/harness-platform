# Native author test feedback

Build the test-capable image from an reviewed, immutable Node 22+ Alpine image:

```sh
node infra/docker/build-native-test.mjs node:22-alpine@sha256:<digest> harness-native-test:local
```

The build sends only tracked package manifests, the lockfile, workspace package
configuration and reviewed image helpers to Docker. It installs dependencies
at build time; it does not copy source, credentials or host node_modules.
Record the resulting image digest and pass that immutable reference to the
native builder. Building requires registry access; authoring remains offline.

Within the existing `process.exec` tool, the author may call:

```json
{"argv":["node","/opt/harness/native-check.mjs","apps/cli/test/doctor.test.ts"],"timeoutMs":30000}
```

The helper runs one test target and then strict typecheck of that test and its imported source graph with one shared
25-second deadline and 96 KiB output budget. Tests use one worker. A passing
test suite with compiler errors still fails the check. Missing tests fail. Dependencies reside outside the exported source;
workspace package links resolve to the current `/workspace` source. Vite caches
use disposable `/tmp`, and test-result caching is disabled. The normal native
workspace path gate still checks every returned source change. Tests remain
untrusted code inside the same non-networked container. This does not replace
the trusted exit gate's full tests, typecheck, signed evidence or human review.

For M18, begin writes after a small bounded inspection, use `fs.write` for new
files and avoid repeated shell-style escaping. Run the focused check after
writing the implementation and tests, correct reported failures, and stop after
at most three check attempts. A failed check is feedback, never permission to
expand scope or increase the budget. The immutable task manifest must state
these constraints before the clean authoring run begins.

This is prerequisite tooling, not an M18 authorship or qualification claim.

To exercise the optional real-container regression locally (CI skips it):

```sh
HARNESS_NATIVE_TEST_IMAGE=harness-native-test@sha256:<digest> pnpm test apps/cli/test/native-check.test.ts
```

It proves a failing assertion becomes passing after a source edit, missing tests
fail, workspace package imports use the live source, and check execution leaves
the source snapshot unchanged. It never starts a live model or enables network.

The next M18 manifest must also require the doctor to reject negative, blank,
fractional, old and future schema versions and validate every required column
in the actual session/event schema. Test a database with a removed required
column as well as a valid store whose bytes stay unchanged. These are reviewer
requirements for the live model; this prerequisite does not supply doctor source.


## Enforced M18 inspection profile

Copy `infra/docker/m18-permissions.json` into the new M18 manifest's permissions
before validation; the profile is not loaded implicitly. Native bootstrap accepts
path-specific read rules because the kernel authorizes every file-tool read.
Legacy adapters still reject subject rules. The profile denies unrelated reads,
listing, diffs, generic Node probes and extra command arguments. `pnpm test` is
retained exactly for the trusted full exit gate. Write scope remains the manifest's
exact allowed_paths. These are tool-policy limits, not a claim that untrusted
test code cannot read the source it compiles inside its isolated container.

For the focused command, **omit cwd** or use `"cwd":"."`. Never supply
`"cwd":"/workspace"`: tool paths are relative even though the helper executable
is an absolute path inside the image. The tool schema and validation error state
this explicitly. Invalid absolute cwd is rejected before workspace execution.

Before spending another M18 budget, run a tiny local-model fixture: read one
function and its test, invoke the exact helper, correct the deliberate failure,
run the helper again, and stop. Pin the tested image, preserve model responses
and kernel events, and cap model tokens at 40000. This smoke test validates the
feedback cycle only; it does not qualify M18 or author production doctor code.

The focused compiler config extends the repository tsconfig in disposable /tmp
with only the selected test as a root. This avoids loading every unrelated test
into the small sandbox. Full-repository typecheck remains a final gate requirement.

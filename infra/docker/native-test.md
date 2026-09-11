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

The helper runs one test target with a 25-second deadline, one worker and bounded
output. Missing tests fail. Dependencies reside outside the exported source;
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

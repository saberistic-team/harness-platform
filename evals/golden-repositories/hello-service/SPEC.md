# hello-service — SPEC

The first calibration target for the eval system (ROADMAP M2).
Deliberately tiny: a single-file HTTP service with an integration
test that exercises the real wire format.

Rules (see `../README.md`): builds and tests green with **only**
`pnpm`/Node ≥ 22, **no network at build/test time**, < 500 LOC.

## What a correct solution looks like

An HTTP service bound to `127.0.0.1` on an explicitly supplied port
(the integration test uses an ephemeral port), with exactly these
endpoints:

| method | path            | behavior                                                        |
| ------ | --------------- | --------------------------------------------------------------- |
| GET    | `/health`       | `200`, `application/json`, body `{"status":"ok"}`               |
| GET    | `/hello/:name`  | `200`, JSON `{"greeting":"hello <name>"}`; name is URL-decoded  |
| GET    | `/hello/` (no name) | falls through to `unknown path`                             |
| GET/anything else | `*`  | `404`, `application/json`, `{"error":"not found"}`           |
| any    | `/`             | `405`, `application/json`, `{"error":"method not allowed"}`    |

Additional contracts:

- **No other public state.** The service is stateless; there is no
  request log, no in-memory store, no headers it sets beyond
  `Content-Type`.
- **Unknown methods on a known path are 405**, unknown paths are 404 —
  in that order of discrimination (path first, then method).
- **The name is trimmed**; names consisting only of whitespace are
  sent as-is after URL-decoding (no server-side sanitization magic).
  The *test* pins the observable behaviour, the spec pins the
  semantics.
- **Deterministic JSON**: a single flat object, keys in the order
  shown above (tests compare parsed JSON, never raw text, for
  stability across engines).

## How it is used

- `node --test` (from the package root; equivalently the package's
  `test` script) runs the integration test: start the server on an
  ephemeral port, hit the endpoints with `fetch`, assert status + JSON
  bodies, shut down.
- The eval system (M2+) names `hello-service` from scenario/task
  manifests as the *calibration* target: task → PR → report
  throughput and event-stream fidelity are measured against runs of
  the same golden kernel over manifests that point here.

## Explicit non-goals

- No framework (no Express/Koa/Fastify). Node `node:http` only.
- No TLS, no logging framework, no dependency of any kind.

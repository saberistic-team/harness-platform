/**
 * Integration test for hello-service (SPEC.md): start the server on an
 * ephemeral port, drive the public contract with fetch, assert on
 * status codes and parsed JSON bodies, then shut down. Offline —
 * 127.0.0.1 loopback only, no external network.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { start } from "../server.mjs";

let server;
let base;

before(async () => {
  server = start({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function getJson(path, init) {
  const res = await fetch(base + path, init);
  const body = await res.json();
  return { status: res.status, body, type: res.headers.get("content-type") };
}

test("GET /health -> 200 {status:ok} JSON", async () => {
  const { status, body, type } = await getJson("/health");
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
  assert.match(type ?? "", /application\/json/);
});

test("GET /hello/:name -> greeting", async () => {
  const { status, body } = await getJson("/hello/world");
  assert.equal(status, 200);
  assert.deepEqual(body, { greeting: "hello world" });
});

test("GET /hello/:name URL-decodes the name", async () => {
  const { status, body } = await getJson(`/hello/${encodeURIComponent("a b")}`);
  assert.equal(status, 200);
  assert.deepEqual(body, { greeting: "hello a b" });
});

test("GET /hello/ without a name -> 404 unknown path", async () => {
  const { status, body } = await getJson("/hello/");
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "not found" });
});

test("unknown path -> 404 JSON", async () => {
  const { status, body } = await getJson("/nope");
  assert.equal(status, 404);
  assert.deepEqual(body, { error: "not found" });
});

test("non-GET on a known path -> 405 JSON", async () => {
  const { status, body } = await getJson("/health", { method: "POST" });
  assert.equal(status, 405);
  assert.deepEqual(body, { error: "method not allowed" });
});

test("GET / -> 405 method not allowed", async () => {
  const { status, body } = await getJson("/");
  assert.equal(status, 405);
  assert.deepEqual(body, { error: "method not allowed" });
});

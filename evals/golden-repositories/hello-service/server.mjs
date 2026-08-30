/**
 * hello-service — the golden-repo calibration target (M2).
 *
 * One file, zero dependencies, node:http only. See SPEC.md for the
 * exact contract; the integration test (test/hello.test.mjs) pins the
 * observable behaviour.
 */
import { createServer } from "node:http";

const JSON_HEADERS = { "content-type": "application/json" };

/** Build a request handler implementing the SPEC. Exported for tests. */
export function makeHandler() {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");

    const send = (status, body) => {
      res.writeHead(status, JSON_HEADERS);
      res.end(JSON.stringify(body));
    };

    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "health") {
      if (req.method === "GET") return send(200, { status: "ok" });
      return send(405, { error: "method not allowed" });
    }
    if (parts.length === 2 && parts[0] === "hello" && parts[1] !== "") {
      if (req.method === "GET") {
        const name = decodeURIComponent(parts[1]);
        return send(200, { greeting: `hello ${name.trim()}` });
      }
      return send(405, { error: "method not allowed" });
    }
    if (url.pathname === "/") {
      return send(405, { error: "method not allowed" });
    }
    return send(404, { error: "not found" });
  };
}

/**
 * Start the service. `port: 0` (the test default) binds an ephemeral
 * port on 127.0.0.1 and reports the real one. Returns the server.
 */
export function start({ port = 0, host = "127.0.0.1" } = {}) {
  const server = createServer(makeHandler());
  server.listen(port, host);
  return server;
}

function isMain() {
  return process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].trim());
}

if (isMain()) {
  const port = Number(process.env.PORT ?? 3000);
  const server = start({ port });
  server.on("listening", () => {
    const address = server.address();
    const real = typeof address === "object" && address ? address.port : port;
    console.log(`hello-service listening on http://127.0.0.1:${real}`);
  });
}

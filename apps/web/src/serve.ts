import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { validateRunReport } from "@harness/sdk";
import { readBoard, type BoardData } from "./board";

/**
 * The web app (ROADMAP M2: "minimal task board (manifests + reports,
 * no real-time)").
 *
 * Node `node:http` only — no framework, by the repo's explicit
 * non-goal ("no custom web framework before apps/web v0.1 is actually
 * used"). The board is a static page + three JSON endpoints over the
 * same read-only data layer the TUI uses. No websocket, no polling:
 * refresh is the button in the UI.
 *
 * Endpoints:
 *   GET /                     board page (static index.html)
 *   GET /api/board            BoardData (manifests + reports, typed)
 *   GET /api/tasks/:id        one task and its reports (404 if none)
 *   GET /api/reports/:file    one validated run report
 *   GET /api/health           liveness ({"status":"ok"})
 */

export interface WebServerOptions {
  /** Repo root: where tasks/ and tasks/runs/ live. */
  root: string;
  port?: number;
  host?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify({ error: message }, null, 2));
}

export function createBoardHandler(
  root: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const indexHtml = fileURLToPath(new URL("../static/index.html", import.meta.url));

  return async (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET") {
      return sendError(res, 405, "the task board is read-only (GET only)");
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);

    try {
      if (path === "/" || path === "/index.html") {
        const html = await readFile(indexHtml, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(html);
      }

      if (path === "/api/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (path === "/api/board") {
        const board = await readBoard(root);
        return sendJson(res, 200, board);
      }

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      const taskMatched = taskMatch?.[1];
      if (taskMatched !== undefined) {
        const board = await readBoard(root);
        const task = board.tasks.find((t) => t.manifest.id === taskMatched);
        if (!task) {
          return sendError(res, 404, `unknown task "${taskMatched}"`);
        }
        return sendJson(res, 200, task);
      }

      const reportMatch = path.match(/^\/api\/reports\/([^/]+)$/);
      const reportMatched = reportMatch?.[1];
      if (reportMatched !== undefined) {
        const file = reportMatched;
        if (file.includes("..") || file.includes("/")) {
          return sendError(res, 400, "invalid report path");
        }
        const dir = resolve(root, "tasks", "runs");
        const full = join(dir, file);
        if (!existsSync(full)) {
          return sendError(res, 404, `no such report: ${file}`);
        }
        try {
          return sendJson(res, 200, validateRunReport(JSON.parse(readFileSync(full, "utf8"))));
        } catch (err) {
          // Typed: an invalid report is a 422, never a silent fallback.
          return sendError(res, 422, `invalid run report: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return sendError(res, 404, `no route: ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(res, 500, `board error: ${message}`);
    }
  };
}

/** Start the board server. Resolves with the bound Server. */
export function startBoard(opts: WebServerOptions): Promise<Server> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(createBoardHandler(opts.root));
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolveP(server);
    });
  });
}

export type { BoardData };

import { cwd as processCwd } from "node:process";
import { pathToFileURL } from "node:url";
import { startBoard } from "../src/serve";

const HELP = `harness-web — the minimal task board (ROADMAP M2)

Usage:
  harness-web [options]

Options:
  --root <dir>   repo root containing tasks/ + tasks/runs/ (default: $PWD)
  --port <n>     listen port (default: $HARNESS_WEB_PORT or 4173)
  --host <h>     bind host (default: 127.0.0.1)

Read-only: GET / (board), /api/board, /api/tasks/:id,
/api/reports/:file, /api/health. No real-time channel — refresh is
a manual pull.
`;

async function main(argv: string[]): Promise<number> {
  let root: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "-h":
      case "--help":
        console.log(HELP);
        return 0;
      case "--root":
        root = argv[++i];
        break;
      case "--port":
        port = Number(argv[++i]);
        break;
      case "--host":
        host = argv[++i];
        break;
      default:
        if (flag !== undefined) {
          console.error(`harness-web: unknown option ${flag}`);
          console.error(HELP);
          return 2;
        }
    }
  }
  if (root !== undefined && !root) {
    console.error("harness-web: --root needs a path");
    return 2;
  }
  const absRoot = root ?? processCwd();
  const effPort =
    port ??
    (process.env.HARNESS_WEB_PORT ? Number(process.env.HARNESS_WEB_PORT) : 4173);
  const server = await startBoard({ root: absRoot, port: effPort, host });
  const address = server.address();
  const real = typeof address === "object" && address ? address.port : effPort;
  console.log(`harness-web: board for ${absRoot}`);
  console.log(`harness-web: http://${host ?? "127.0.0.1"}:${real}`);
  await new Promise(() => {}); // run until killed (SIGINT/SIGTERM default)
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

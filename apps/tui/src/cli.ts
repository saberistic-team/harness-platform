import { pathToFileURL } from "node:url";
import {
  runConnectCommand,
  type InteractiveContext,
} from "./interactive";
import { sanitizeTerminalText } from "./render";
import { runView, type ViewContext } from "./view";

/**
 * `harness-view` executable: stored-event viewer plus the M3 interactive
 * ACP client. Exit codes: 0 ok, 1 usage, 2 runtime/store error, 130 canceled.
 */
export async function main(
  argv: string[],
  ctx: InteractiveContext & ViewContext = {},
): Promise<number> {
  if (argv[0] === "connect") return runConnectCommand(argv.slice(1), ctx);
  return runView(argv, ctx);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  if (process.argv[2] === "connect") process.once("SIGINT", onInterrupt);

  main(process.argv.slice(2), { signal: abort.signal })
    .then(
      (code) => process.exit(code),
      (err) => {
        console.error(sanitizeTerminalText(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      },
    )
    .finally(() => process.removeListener("SIGINT", onInterrupt));
}

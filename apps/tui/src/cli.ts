import { pathToFileURL } from "node:url";
import { runView } from "./view";

/**
 * `harness-view` executable: read-only session/event viewer (M1).
 * Exit codes: 0 ok, 1 usage/unknown command, 2 store/report error.
 */
export async function main(argv: string[]): Promise<number> {
  return runView(argv);
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

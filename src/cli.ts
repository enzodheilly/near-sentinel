/**
 * NEAR Sentinel command line: `node src/cli.ts <command>` (wired as pnpm scripts).
 *
 *   demo                      replay the frozen scenarios, print decisions and record hashes
 *   verify <hash>... | --all  recompute records and check them; non-zero exit on any problem
 *   status                    positions, limits and today's PnL from the last recorded state
 *   explorer                  build explorer/dist/index.html from the records
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "./cli/demo.ts";
import { runStatus } from "./cli/status.ts";
import { runVerify } from "./cli/verify.ts";
import { runExplorer } from "./explorer/build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = (l: string) => process.stdout.write(`${l}\n`);
const [cmd, ...argv] = process.argv.slice(2);
const VALUED = new Set(["--records"]); // flags followed by a value
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]!) : fallback;
};
/** Positional arguments and bare flags, without the valued flags and their values. */
const args = argv.filter((a, i) => !VALUED.has(a) && !VALUED.has(argv[i - 1] ?? ""));

async function main(): Promise<number> {
  const out = flag("records", join(root, "records"));
  switch (cmd) {
    case "demo":
      return runDemo({ root, out, write, env: process.env, statePath: join(root, "state", "portfolio.json") });
    case "verify":
      return runVerify({ root, records: out, args, write });
    case "explorer":
      return runExplorer({ root, records: out, write });
    case "status":
      return runStatus({ statePath: join(root, "state", "portfolio.json"), records: out, write });
    default:
      write("usage: pnpm demo | pnpm verify <hash>|--all | pnpm status | pnpm explorer");
      return cmd === undefined || cmd === "help" ? 0 : 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);

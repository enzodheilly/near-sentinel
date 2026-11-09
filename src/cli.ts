/**
 * NEAR Sentinel command line: `node src/cli.ts <command>` (wired as pnpm scripts).
 *
 *   demo                      replay the frozen scenarios, print decisions and record hashes
 *   verify <hash>... | --all  recompute records and check them; non-zero exit on any problem
 *                             (--anchor <contract> --network testnet|mainnet: also check the on-chain anchor)
 *   status                    positions, limits and today's PnL from the last recorded state
 *   explorer                  build explorer/dist/index.html from the records
 *   paper                     run on the live market with dry quotes and simulated fills, until Ctrl+C
 *   live                      refused until live execution through NEAR Intents lands (#47)
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "./cli/demo.ts";
import { paperPaths, runPaper } from "./cli/run.ts";
import { runStatus } from "./cli/status.ts";
import { runVerify } from "./cli/verify.ts";
import { runExplorer } from "./explorer/build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = (l: string) => process.stdout.write(`${l}\n`);
const [cmd, ...argv] = process.argv.slice(2);
const VALUED = new Set(["--records", "--anchor", "--network"]); // flags followed by a value
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]!) : fallback;
};
/** Positional arguments and bare flags, without the valued flags and their values. */
const args = argv.filter((a, i) => !VALUED.has(a) && !VALUED.has(argv[i - 1] ?? ""));

/** The local .env (never committed), when present: keys for 1Click and NEAR AI. */
function loadEnv() {
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch {
    // no .env: unauthenticated quotes and the LLM fallback, both announced at start
  }
}

async function main(): Promise<number> {
  const out = flag("records", join(root, "records"));
  switch (cmd) {
    case "demo":
      return runDemo({ root, out, write, env: process.env, statePath: join(root, "state", "portfolio.json") });
    case "verify": {
      const i = argv.indexOf("--anchor");
      const contract = i >= 0 ? argv[i + 1] : undefined;
      if (!contract) return runVerify({ root, records: out, args, write });
      const n = argv.indexOf("--network");
      const network = (n >= 0 ? argv[n + 1] : "mainnet") as "mainnet" | "testnet";
      const { Near } = await import("near-kit");
      const { ContractAnchor } = await import("./execution/anchor.ts");
      const anchor = new ContractAnchor({ near: new Near({ network }) as never, contractId: contract, agentId: "" });
      return runVerify({ root, records: out, args, write, anchored: (h) => anchor.lookup(h) });
    }
    case "explorer":
      return runExplorer({ root, records: out, write });
    case "status":
      return args.includes("paper")
        ? runStatus({ statePath: paperPaths(root).state, heartbeatPath: paperPaths(root).heartbeat, records: out, write })
        : runStatus({ statePath: join(root, "state", "portfolio.json"), records: out, write });
    case "paper":
      loadEnv();
      return runPaper({ root, env: process.env, write });
    case "live":
      write("live mode is not available yet: live execution through NEAR Intents is ticket #47. Use pnpm paper.");
      return 2;
    default:
      write("usage: pnpm demo | pnpm verify <hash>|--all | pnpm status [paper] | pnpm explorer | pnpm paper");
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

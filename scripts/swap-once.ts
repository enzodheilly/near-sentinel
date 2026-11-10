/**
 * One real, small signed swap inside NEAR Intents (spike P4, #9): proves the live path end to end with the same
 * executor the agent uses. Run by the human, once, after `scripts/setup-live-key.ts`:
 *
 *   node scripts/swap-once.ts --usdc 5 --yes-real-funds
 *
 * USDC → NEAR inside the agent's Intents balance (nothing leaves NEAR Intents). The quote must pass the same
 * pre-trade checks as the agent's (§7.2), and the payload is checked before it is signed. The evidence (quote,
 * intent payload, intent hash, status; no secret) is saved to test/live/recorded/first-intent.json.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { Near } from "near-kit";
import { defaultRiskConfig as cfg } from "../src/config/default.ts";
import { runChecks } from "../src/decision/checks.ts";
import { LiveExecutor } from "../src/execution/live.ts";
import { OneClickClient } from "../src/execution/oneclick.ts";
import type { EntryProposal } from "../src/types.ts";

async function main(argv: string[]): Promise<number> {
  try {
    process.loadEnvFile(new URL("../.env", import.meta.url).pathname);
  } catch {
    // checked below
  }
  const i = argv.indexOf("--usdc");
  const usdc = Number(i >= 0 ? argv[i + 1] : 5);
  const account = process.env["AGENT_ACCOUNT"];
  const key = process.env["AGENT_PRIVATE_KEY"];
  if (!argv.includes("--yes-real-funds") || !account || !key || !(usdc > 0 && usdc <= 10)) {
    console.error("usage: node scripts/swap-once.ts --usdc <1..10> --yes-real-funds   (needs AGENT_ACCOUNT and AGENT_PRIVATE_KEY in .env)");
    return 2;
  }
  const client = new OneClickClient({ jwt: process.env["ONECLICK_JWT"] });
  const near = new Near({ network: "mainnet", keyStore: { [account]: key } });
  const log: Record<string, unknown> = { at: new Date().toISOString(), account, usdc };
  const spy: Pick<OneClickClient, "quote" | "toQuote" | "generateIntent" | "submitIntent" | "status"> = {
    quote: async (r) => ((log["quote"] = await client.quote(r)) as Awaited<ReturnType<OneClickClient["quote"]>>),
    toQuote: (r, q, at) => client.toQuote(r, q, at),
    generateIntent: async (d, s) => ((log["intent"] = await client.generateIntent(d, s)) as Awaited<ReturnType<OneClickClient["generateIntent"]>>),
    submitIntent: async (sd) => {
      log["signed"] = { standard: sd.standard, public_key: sd.public_key }; // never the signature's key
      return (log["submitted"] = await client.submitIntent(sd)) as Awaited<ReturnType<OneClickClient["submitIntent"]>>;
    },
    status: async (d, m) => ((log["status"] = await client.status(d, m)) as Awaited<ReturnType<OneClickClient["status"]>>),
  };
  const x = new LiveExecutor({ cfg, client: spy, near: near as never, account, maxNotionalUsd: 10 });
  const bal = await x.balances();
  console.log(`agent ${account} in NEAR Intents: ${Number(bal.USDC) / 1e6} USDC, ${Number(bal.NEAR) / 1e24} NEAR`);
  const price = (await client.tokens()).find((t) => t.assetId === cfg.assets.NEAR.assetId)!.price;
  const now = Date.now();
  const p: EntryProposal = { kind: "ENTRY", asset: "NEAR", barTime: now - 3_600_000, referencePrice: price, notionalUsd: usdc, quantity: usdc / price,
    stopPrice: price * 0.97, takeProfit: [price * 1.03, price * 1.05], riskUsd: usdc * 0.03, signals: [] };
  const q = await x.quote(p, cfg.execution.slippageBps.entry);
  const checks = runChecks(p, q, { now: Date.now(), originBalance: bal.USDC, executed: new Set() }, cfg);
  for (const c of checks.checks) console.log(`  check ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  if (!checks.ok) {
    console.error("quote refused by the pre-trade checks: nothing signed");
    return 1;
  }
  const r = await x.execute(p, q);
  log["report"] = { status: r.status, intentHash: r.intentHash, txRefs: r.txRefs, fill: r.fill, error: r.error };
  const out = new URL("../test/live/recorded/first-intent.json", import.meta.url).pathname;
  await mkdir(new URL("../test/live/recorded/", import.meta.url).pathname, { recursive: true });
  await writeFile(out, `${JSON.stringify(log, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  console.log(`${r.status}${r.fill ? `: ${r.fill.quantityIn} USDC → ${r.fill.quantityOut.toFixed(6)} NEAR at ${r.fill.price.toFixed(4)}` : ""}${r.error ? ` (${r.error})` : ""}`);
  if (r.intentHash) console.log(`intent ${r.intentHash} · txs ${r.txRefs.slice(1).join(", ") || "none"} · evidence in test/live/recorded/first-intent.json`);
  return r.status === "SUCCESS" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

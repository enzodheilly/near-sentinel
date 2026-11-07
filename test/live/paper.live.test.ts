/**
 * Live paper check (network, pnpm test:live): a real dry 1Click quote USDC → NEAR, made by the paper executor,
 * passes the §7.2 pre-trade checks against the current 1Click reference price. Nothing is signed or spent.
 */
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { runChecks } from "../../src/decision/checks.ts";
import { OneClickClient } from "../../src/execution/oneclick.ts";
import { MemoryBalanceStore, PaperExecutor } from "../../src/execution/paper.ts";
import type { EntryProposal } from "../../src/types.ts";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // no .env: unauthenticated quote
}

describe("paper executor live", () => {
  it("a real dry USDC → NEAR quote passes the §7.2 checks", async () => {
    const client = new OneClickClient({ jwt: process.env["ONECLICK_JWT"] });
    const near = (await client.tokens()).find((t) => t.assetId === cfg.assets.NEAR.assetId)!;
    const x = await PaperExecutor.open({ cfg, client, store: new MemoryBalanceStore() });
    const now = Date.now();
    const p: EntryProposal = {
      kind: "ENTRY", asset: "NEAR", barTime: now - 3_600_000, referencePrice: near.price, notionalUsd: 25, quantity: 25 / near.price,
      stopPrice: near.price * 0.98, takeProfit: [near.price * 1.03, near.price * 1.045], riskUsd: 0.5, signals: [],
    };
    const q = await x.quote(p, cfg.execution.slippageBps.entry);
    const out = runChecks(p, q, { now: Date.now(), originBalance: (await x.balances()).USDC, executed: new Set() }, cfg);
    console.log(`paper quote: 25 USDC → ${Number(q.amountOut) / 1e24} NEAR at ${out.priceQuoted} (ref ${near.price}); checks ${out.ok ? "OK" : `FAILED ${"reason" in out ? out.reason : ""}`}`);
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.ok).toBe(true);
    const r = await x.execute(p, q);
    expect(r.status).toBe("SIMULATED");
  }, 30_000);
});

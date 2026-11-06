/**
 * Live 1Click check (network, pnpm test:live). Uses ONECLICK_JWT from the environment if set; a dry quote
 * never signs or spends anything. Records the exact request and response to test/live/recorded/quote-dry.json,
 * which the offline suite then replays (test/execution/oneclick.test.ts). The key is never written.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { OneClickClient, type QuoteRequest } from "../../src/execution/oneclick.ts";

const OUT = new URL("./recorded/quote-dry.json", import.meta.url).pathname;

// Vitest does not read .env: load the local one (never committed) so ONECLICK_JWT is used when present.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // no .env: run unauthenticated (1Click then adds 0.25% to the fee)
}

describe("1Click live", () => {
  it("tokens list our three assets with the configured decimals", async () => {
    const tokens = await new OneClickClient({ jwt: process.env["ONECLICK_JWT"] }).tokens();
    for (const a of [cfg.assets.BTC, cfg.assets.NEAR, cfg.assets.USDC]) expect(tokens.find((t) => t.assetId === a.assetId)?.decimals).toBe(a.decimals);
  }, 30_000);

  it("a dry quote 25 USDC → NEAR parses, and is recorded for the offline suite", async () => {
    const c = new OneClickClient({ jwt: process.env["ONECLICK_JWT"] });
    const req: QuoteRequest = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: cfg.execution.slippageBps.entry, originAsset: cfg.assets.USDC.assetId,
      destinationAsset: cfg.assets.NEAR.assetId, amount: "25000000", depositType: "INTENTS", recipient: "near-sentinel-demo.near",
      recipientType: "INTENTS", refundTo: "near-sentinel-demo.near", refundType: "INTENTS", deadline: new Date(Date.now() + 120_000).toISOString(),
    };
    const res = await c.quote(req);
    expect(BigInt(res.quote.amountOut)).toBeGreaterThan(0n);
    // printed so the owner sees which fee schedule applied; the key itself is never printed or written
    console.log(`1Click dry quote: 25 USDC → ${res.quote.amountOutFormatted} NEAR (${c.authenticated ? "partner key" : "NO partner key"}; USD in ${res.quote.amountInUsd}, out ${res.quote.amountOutUsd})`);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({ recordedAt: new Date().toISOString(), authenticated: c.authenticated, request: req, response: res }, null, 2)}\n`);
  }, 30_000);
});

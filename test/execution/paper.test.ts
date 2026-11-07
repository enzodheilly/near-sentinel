import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { runChecks } from "../../src/decision/checks.ts";
import { OneClickClient, type QuoteRequest, type QuoteResponse } from "../../src/execution/oneclick.ts";
import { FileBalanceStore, MemoryBalanceStore, PAPER_ACCOUNT, PaperExecutor, type BalanceStore } from "../../src/execution/paper.ts";
import type { EntryProposal, ExitProposal } from "../../src/types.ts";

const A = cfg.assets;
const NOW = Date.parse("2026-11-07T20:00:30Z");
const entry: EntryProposal = {
  kind: "ENTRY", asset: "NEAR", barTime: NOW - 3_630_000, referencePrice: 2.5, notionalUsd: 250, quantity: 100,
  stopPrice: 2.45, takeProfit: [2.575, 2.6125], riskUsd: 5, signals: [],
};

/** A fake 1Click that quotes at `price` USDC per unit, minus `feeBps`, and records the requests. */
function fakeOneClick(price: number, feeBps = 20) {
  const reqs: QuoteRequest[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as QuoteRequest;
    reqs.push(req);
    const buy = req.originAsset === A.USDC.assetId;
    const inDec = buy ? 6 : req.originAsset === A.NEAR.assetId ? 24 : 8;
    const outDec = buy ? (req.destinationAsset === A.NEAR.assetId ? 24 : 8) : 6;
    const inHuman = Number(BigInt(req.amount)) / 10 ** inDec;
    const outHuman = (buy ? inHuman / price : inHuman * price) * (1 - feeBps / 10_000);
    const out = BigInt(Math.round(outHuman * 1e6)) * 10n ** BigInt(outDec - 6);
    const body: QuoteResponse = {
      timestamp: new Date(NOW).toISOString(), quoteRequest: { ...req },
      quote: { amountIn: req.amount, amountInFormatted: String(inHuman), amountOut: out.toString(), amountOutFormatted: String(outHuman),
        minAmountOut: ((out * BigInt(10_000 - req.slippageTolerance)) / 10_000n).toString() },
    };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new OneClickClient({ jwt: "eyJ", fetch: f }), reqs };
}

const open = (price = 2.5, store: BalanceStore = new MemoryBalanceStore()) => {
  const one = fakeOneClick(price);
  return PaperExecutor.open({ cfg, client: one.client, store, clock: () => NOW }).then((x) => ({ x, ...one, store }));
};

describe("PaperExecutor", () => {
  it("first run starts at 1000 USDC and saves it", async () => {
    const { x, store } = await open();
    expect(await x.balances()).toEqual({ USDC: 1_000_000_000n, BTC: 0n, NEAR: 0n });
    expect(await store.load()).toEqual({ USDC: 1_000_000_000n, BTC: 0n, NEAR: 0n });
    expect(x.mode).toBe("paper");
  });

  it("entry: a dry INTENTS quote for the notional, never a live one", async () => {
    const { x, reqs } = await open();
    const q = await x.quote(entry, 50);
    expect(reqs[0]).toMatchObject({
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: A.USDC.assetId, destinationAsset: A.NEAR.assetId,
      amount: "250000000", depositType: "INTENTS", recipient: PAPER_ACCOUNT, refundTo: PAPER_ACCOUNT, deadline: new Date(NOW + 120_000).toISOString(),
    });
    expect(q).toMatchObject({ originAsset: A.USDC.assetId, amountIn: 250_000_000n, receivedAt: NOW });
  });

  it("the quote passes the §7.2 checks; a fill is simulated at amountOut (fees included) and persisted", async () => {
    const { x, store } = await open();
    const q = await x.quote(entry, 50);
    const checks = runChecks(entry, q, { now: NOW, originBalance: (await x.balances()).USDC, executed: new Set() }, cfg);
    expect(checks.ok).toBe(true);
    const r = await x.execute(entry, q);
    expect(r.status).toBe("SIMULATED");
    expect(r.fill!.quantityIn).toBe(250);
    expect(r.fill!.quantityOut).toBeCloseTo(99.8, 6); // 100 NEAR minus the 20 bps fee
    expect(r.fill!.price).toBeCloseTo(2.505, 3);
    expect(await store.load()).toEqual({ USDC: 750_000_000n, BTC: 0n, NEAR: q.amountOut });
  });

  it("full exit sells exactly what is held when float rounds a little above it", async () => {
    const { x, reqs } = await open();
    await x.execute(entry, await x.quote(entry, 50));
    const held = (await x.balances()).NEAR;
    const exit: ExitProposal = { kind: "EXIT", asset: "NEAR", barTime: NOW, reason: "TAKE_PROFIT_2", referencePrice: 2.6, quantity: Number(held) / 1e24 + 1e-12, fraction: 1 };
    const q = await x.quote(exit, 150);
    expect(reqs.at(-1)!.amount).toBe(held.toString());
    const r = await x.execute(exit, q);
    expect(r.status).toBe("SIMULATED");
    expect((await x.balances()).NEAR).toBe(0n);
  });

  it("refuses to spend more than the paper balance", async () => {
    const { x } = await open();
    const q = await x.quote({ ...entry, notionalUsd: 5000, quantity: 2000 }, 50);
    const r = await x.execute(entry, q);
    expect(r).toMatchObject({ status: "FAILED", error: "paper balance USDC too low" });
    expect((await x.balances()).USDC).toBe(1_000_000_000n);
  });

  it("a restart resumes the saved paper balances (file store)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper-"));
    const path = join(dir, "state", "paper-balances.json");
    const first = await open(2.5, new FileBalanceStore(path));
    await first.x.execute(entry, await first.x.quote(entry, 50));
    const again = await PaperExecutor.open({ cfg, client: fakeOneClick(2.5).client, store: new FileBalanceStore(path), start: { USDC: 1, BTC: 0, NEAR: 0 } });
    expect(await again.balances()).toEqual(await first.x.balances());
    expect(JSON.parse(await readFile(path, "utf8")).balances.USDC).toBe("750000000");
  });

  it("a corrupted balance file is refused, not silently reset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paper-"));
    const path = join(dir, "b.json");
    await writeFile(path, JSON.stringify({ balances: { USDC: "1.5", BTC: "0", NEAR: "0" } }));
    await expect(PaperExecutor.open({ cfg, client: fakeOneClick(2.5).client, store: new FileBalanceStore(path) })).rejects.toThrow(/USDC/);
  });
});

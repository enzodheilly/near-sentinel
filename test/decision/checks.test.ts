import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { firstTolerance, impliedPrice, quoteAndCheck, runChecks, type CheckContext } from "../../src/decision/checks.ts";
import { idempotencyKey, type EntryProposal, type ExitProposal, type Quote } from "../../src/types.ts";

const USDC = cfg.assets.USDC.assetId;
const NEAR = cfg.assets.NEAR.assetId;
const BTC = cfg.assets.BTC.assetId;
const T = Date.parse("2026-11-06T10:00:00Z");
const usdc = (x: number) => BigInt(Math.round(x * 1e6));
const near = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 18n; // 24 decimals, 6 significant

const entry: EntryProposal = {
  kind: "ENTRY", asset: "NEAR", barTime: T - 3_600_000, referencePrice: 2, notionalUsd: 100, quantity: 50,
  stopPrice: 1.95, takeProfit: [2.075, 2.15], riskUsd: 2.5, signals: [],
};
const exit: ExitProposal = { kind: "EXIT", asset: "NEAR", barTime: T - 3_600_000, reason: "STOP", referencePrice: 2, quantity: 50, fraction: 1 };

/** Buy: 100 USDC in, 100 / price NEAR out. Sell: 50 NEAR in, 50 × price USDC out. */
const buyQuote = (price: number, over: Partial<Quote> = {}): Quote => ({
  originAsset: USDC, destinationAsset: NEAR, amountIn: usdc(100), amountOut: near(100 / price), minAmountOut: 0n,
  deadline: new Date(T + 120_000).toISOString(), receivedAt: T, raw: {}, ...over,
});
const sellQuote = (price: number, over: Partial<Quote> = {}): Quote => ({
  originAsset: NEAR, destinationAsset: USDC, amountIn: near(50), amountOut: usdc(50 * price), minAmountOut: 0n,
  deadline: new Date(T + 120_000).toISOString(), receivedAt: T, raw: {}, ...over,
});
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ now: T + 5_000, originBalance: 10n ** 30n, executed: new Set(), ...over });

describe("impliedPrice", () => {
  it("buys: USDC in / asset out; sells: USDC out / asset in", () => {
    expect(impliedPrice(entry, buyQuote(2.01), cfg)).toBeCloseTo(2.01, 5);
    expect(impliedPrice(exit, sellQuote(1.98), cfg)).toBeCloseTo(1.98, 9);
  });

  it("null when the quote is for another pair or direction", () => {
    expect(impliedPrice(entry, sellQuote(2), cfg)).toBeNull();
    expect(impliedPrice(entry, buyQuote(2, { destinationAsset: BTC }), cfg)).toBeNull();
    expect(impliedPrice(entry, buyQuote(2, { amountOut: 0n }), cfg)).toBeNull();
  });
});

describe("runChecks (RISK_ENGINE.md §7.2)", () => {
  it("accepts a good entry quote and reports every check", () => {
    const r = runChecks(entry, buyQuote(2.004), ctx(), cfg);
    expect(r).toMatchObject({ ok: true, toleranceBps: 50 });
    expect(r.checks.map((c) => c.name)).toEqual(["idempotency", "price_sanity", "slippage", "quote_fresh", "balance"]);
  });

  it("rejects a 2% price deviation with QUOTE_PRICE_DEVIATION (entries both ways; exits on the first attempt)", () => {
    expect(runChecks(entry, buyQuote(2.04), ctx(), cfg)).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION" });
    expect(runChecks(entry, buyQuote(1.96), ctx(), cfg)).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION" });
    expect(runChecks(exit, sellQuote(1.96), ctx(), cfg)).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION" });
  });

  it("a quote for the wrong pair is a price-sanity failure, not a crash", () => {
    const r = runChecks(entry, sellQuote(2), ctx(), cfg);
    expect(r).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION", priceQuoted: null });
    expect(JSON.stringify(r.checks)).not.toContain("null"); // no NaN/null leaks into the record
  });

  it("slippage: 50 bps for entries, 150 bps for exits, measured against the trade direction", () => {
    expect(runChecks(entry, buyQuote(2.0098), ctx(), cfg)).toMatchObject({ ok: true });            // +49 bps
    expect(runChecks(entry, buyQuote(2.0104), ctx(), cfg)).toMatchObject({ ok: false, reason: "SLIPPAGE_TOO_HIGH" });
    expect(runChecks(entry, buyQuote(1.99), ctx(), cfg).ok).toBe(true);                           // cheaper: fine
    expect(runChecks(exit, sellQuote(1.972), ctx(), cfg).ok).toBe(true);                          // −140 bps on a sell
    const sell = runChecks(exit, sellQuote(1.968), ctx(), cfg);                                    // −160 bps
    expect(sell.ok).toBe(false);
    expect(sell.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["price_sanity", "slippage"]); // both at 1.5% for exits
    expect(firstTolerance(entry, cfg)).toBe(50);
    expect(firstTolerance(exit, cfg)).toBe(150);
  });

  it("QUOTE_EXPIRED at 30 s", () => {
    expect(runChecks(entry, buyQuote(2), ctx({ now: T + 29_999 }), cfg).ok).toBe(true);
    expect(runChecks(entry, buyQuote(2), ctx({ now: T + 30_000 }), cfg)).toMatchObject({ ok: false, reason: "QUOTE_EXPIRED" });
  });

  it("INSUFFICIENT_BALANCE when the Intents balance is below amountIn", () => {
    expect(runChecks(entry, buyQuote(2), ctx({ originBalance: usdc(99.99) }), cfg)).toMatchObject({ ok: false, reason: "INSUFFICIENT_BALANCE" });
    expect(runChecks(entry, buyQuote(2), ctx({ originBalance: usdc(100) }), cfg).ok).toBe(true);
  });

  it("DUPLICATE when the same (asset, bar, reason) already executed; another reason is not a duplicate", () => {
    expect(runChecks(exit, sellQuote(2), ctx({ executed: new Set([idempotencyKey(exit)]) }), cfg)).toMatchObject({ ok: false, reason: "DUPLICATE" });
    expect(runChecks(exit, sellQuote(2), ctx({ executed: new Set([idempotencyKey(entry)]) }), cfg).ok).toBe(true);
  });

  it("POLICY_DENIED (Tier 2) when the contract is paused or the amount exceeds its cap", () => {
    expect(runChecks(entry, buyQuote(2), ctx({ policy: { paused: true, maxAmountInUsd: 1000 } }), cfg)).toMatchObject({ reason: "POLICY_DENIED" });
    expect(runChecks(entry, buyQuote(2), ctx({ policy: { paused: false, maxAmountInUsd: 99 } }), cfg)).toMatchObject({ reason: "POLICY_DENIED" });
    expect(runChecks(entry, buyQuote(2), ctx({ policy: { paused: false, maxAmountInUsd: 100 } }), cfg).ok).toBe(true);
  });
});

describe("quoteAndCheck: retry rules", () => {
  const scripted = (...quotes: Quote[]) => {
    const asked: number[] = [];
    return { asked, get: async (bps: number) => (asked.push(bps), quotes[asked.length - 1] as Quote) };
  };

  it("entries are never re-quoted, whatever failed", async () => {
    for (const q of [buyQuote(2.04), buyQuote(2.0104), buyQuote(2, { receivedAt: T - 60_000 })]) {
      const s = scripted(q, buyQuote(2));
      const r = await quoteAndCheck(entry, s.get, () => ctx(), cfg);
      expect(s.asked).toEqual([50]);
      expect(r.outcome.ok).toBe(false);
      expect(r.attempts).toHaveLength(1);
      expect(r.exitStuck).toBe(false);
    }
  });

  it("an exit failing at 150 bps is re-quoted once at 250 bps and passes", async () => {
    const s = scripted(sellQuote(1.964), sellQuote(1.956)); // −180 bps, then −220 bps
    const r = await quoteAndCheck(exit, s.get, () => ctx(), cfg);
    expect(s.asked).toEqual([150, 250]);
    expect(r.attempts.map((a) => a.outcome.ok)).toEqual([false, true]);
    expect(r.outcome).toMatchObject({ ok: true, toleranceBps: 250 });
    expect(r.exitStuck).toBe(false);
  });

  it("exits: price sanity follows the tolerance (1.5%, then 2.5% on the retry); 3% fails both", async () => {
    const ok = await quoteAndCheck(exit, scripted(sellQuote(1.96), sellQuote(1.96)).get, () => ctx(), cfg);
    expect(ok.attempts[0]!.outcome).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION" });
    expect(ok.outcome.ok).toBe(true);
    const bad = await quoteAndCheck(exit, scripted(sellQuote(1.94), sellQuote(1.94)).get, () => ctx(), cfg);
    expect(bad.outcome).toMatchObject({ ok: false, reason: "QUOTE_PRICE_DEVIATION" });
    expect(bad.exitStuck).toBe(true);
  });

  it("an exit still failing after the retry is flagged stuck (pause entries, alert, keep retrying)", async () => {
    const r = await quoteAndCheck(exit, scripted(sellQuote(1.9), sellQuote(1.9)).get, () => ctx(), cfg);
    expect(r.attempts).toHaveLength(2);
    expect(r.exitStuck).toBe(true);
  });

  it("an exit is not re-quoted for failures a new quote cannot fix", async () => {
    const s = scripted(sellQuote(2), sellQuote(2));
    const r = await quoteAndCheck(exit, s.get, () => ctx({ executed: new Set([idempotencyKey(exit)]) }), cfg);
    expect(s.asked).toEqual([150]);
    expect(r.outcome).toMatchObject({ ok: false, reason: "DUPLICATE" });
    expect(r.exitStuck).toBe(false); // already executed: nothing is stuck
    const broke = await quoteAndCheck(exit, scripted(sellQuote(2)).get, () => ctx({ originBalance: 0n }), cfg);
    expect(broke).toMatchObject({ exitStuck: true, outcome: { reason: "INSUFFICIENT_BALANCE" } });
  });

  it("an expired exit quote is replaced by a fresh one", async () => {
    let clock = T + 40_000;
    const s = scripted(sellQuote(2), sellQuote(2, { receivedAt: T + 41_000 }));
    const r = await quoteAndCheck(exit, s.get, () => ({ ...ctx(), now: (clock += 1000) }), cfg);
    expect(r.attempts[0]!.outcome).toMatchObject({ reason: "QUOTE_EXPIRED" });
    expect(r.outcome.ok).toBe(true);
  });
});

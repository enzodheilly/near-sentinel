import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet, type FixtureSet } from "../../src/data/fixtures.ts";
import { computeSignals, type MarketWindow } from "../../src/signals/index.ts";
import { INTERVAL_MS, SIGNAL_KINDS, type Candle } from "../../src/types.ts";

async function fixture(name: "demo-entry" | "demo-refusal"): Promise<{ set: FixtureSet; w: MarketWindow; t: number }> {
  const set = await loadFixtureSet(new URL(`../../fixtures/${name}/`, import.meta.url).pathname);
  const sym = `${set.asset}USDT`;
  const w: MarketWindow = {
    asset: set.asset,
    candles1h: set.series[sym]!["1h"]!.candles,
    btc1h: set.series["BTCUSDT"]!["1h"]!.candles,
    btc4h: set.series["BTCUSDT"]!["4h"]!.candles,
  };
  return { set, w, t: w.candles1h.findIndex((c) => c.openTime === set.signalBarTime) };
}

const split = (signals: ReturnType<typeof computeSignals>) => ({
  kinds: signals.map((s) => s.kind),
  confirmations: signals.filter((s) => s.kind !== "BB_BREAKOUT" && s.direction === "bullish").map((s) => s.kind),
  vetoes: signals.filter((s) => s.direction === "veto").map((s) => s.kind),
});

describe("computeSignals — golden tests on the frozen fixtures", () => {
  it("demo-entry → breakout + RSI_MOMENTUM + FVG_SUPPORT + BTC_REGIME at 2026-07-20 09:00", async () => {
    const { set, w, t } = await fixture("demo-entry");
    expect(t).toBe(200);
    const sig = computeSignals(w, t, cfg);
    expect(sig.every((s) => s.barTime === Date.parse("2026-07-20T09:00:00Z") && s.asset === "NEAR")).toBe(true);
    const got = split(sig);
    expect(got.kinds).toEqual(["BB_BREAKOUT", "RSI_MOMENTUM", "FVG_SUPPORT", "BTC_REGIME"]);
    expect(got.confirmations).toEqual(set.expected.confirmations);
    expect(got.vetoes).toEqual(set.expected.vetoes);
  });

  it("demo-refusal → breakout + RSI_EXHAUSTION veto at 2026-09-20 16:00", async () => {
    const { set, w, t } = await fixture("demo-refusal");
    expect(t).toBe(200);
    const sig = computeSignals(w, t, cfg);
    expect(sig.every((s) => s.barTime === Date.parse("2026-09-20T16:00:00Z"))).toBe(true);
    const got = split(sig);
    expect(got.kinds).toEqual(["BB_BREAKOUT", "RSI_EXHAUSTION"]);
    expect(got.confirmations).toEqual(set.expected.confirmations);
    expect(got.vetoes).toEqual(set.expected.vetoes);
  });
});

describe("computeSignals — warm-up (RISK_ENGINE.md §2)", () => {
  it("evaluates t = 200 but not t = 199", async () => {
    const { w } = await fixture("demo-entry");
    expect(computeSignals(w, 199, cfg)).toEqual([]);
    expect(computeSignals(w, 200, cfg)).not.toEqual([]);
  });

  it("returns nothing with fewer than 60 closed 4h candles before the bar's close", async () => {
    const { w, t } = await fixture("demo-entry");
    const close = w.candles1h[t]!.openTime + INTERVAL_MS["1h"];
    const closed = w.btc4h.filter((c) => c.openTime + INTERVAL_MS["4h"] <= close);
    const keep = (n: number) => ({ ...w, btc4h: w.btc4h.slice(closed.length - n) });
    expect(computeSignals(keep(59), t, cfg)).toEqual([]);
    expect(computeSignals(keep(60), t, cfg)).not.toEqual([]);
  });

  it("returns nothing for an out-of-range or non-integer t", async () => {
    const { w } = await fixture("demo-entry");
    for (const t of [-1, 1e6, 200.5, w.candles1h.length]) expect(computeSignals(w, t, cfg)).toEqual([]);
  });
});

describe("computeSignals — determinism and no look-ahead", () => {
  it("output order follows SIGNAL_KINDS on every evaluable bar of both fixtures", async () => {
    for (const name of ["demo-entry", "demo-refusal"] as const) {
      const { w } = await fixture(name);
      for (let t = 200; t < w.candles1h.length; t++) {
        const idx = computeSignals(w, t, cfg).map((s) => SIGNAL_KINDS.indexOf(s.kind));
        expect(idx).toEqual([...idx].sort((a, b) => a - b));
      }
    }
  });

  it("property: replacing every candle after bar t with arbitrary data never changes the signals at t", async () => {
    const fixtures = await Promise.all([fixture("demo-entry"), fixture("demo-refusal")]);
    const scramble = (cs: readonly Candle[], after: number, step: number, seed: number[]) =>
      cs.map((c, i) => {
        if (c.openTime + step <= after) return c; // known at the close of bar t
        const p = c.close * (seed[i % seed.length] as number);
        return { ...c, open: p, high: p * 1.05, low: p * 0.95, close: p };
      });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }),
        fc.integer({ min: 200, max: 300 }),
        fc.array(fc.double({ min: 0.5, max: 2, noNaN: true }), { minLength: 1, maxLength: 8 }),
        (f, t, seed) => {
          const { w } = fixtures[f]!;
          const close = w.candles1h[t]!.openTime + INTERVAL_MS["1h"];
          const future: MarketWindow = {
            ...w,
            candles1h: scramble(w.candles1h, close, INTERVAL_MS["1h"], seed),
            btc1h: scramble(w.btc1h, close, INTERVAL_MS["1h"], seed),
            btc4h: scramble(w.btc4h, close, INTERVAL_MS["4h"], seed),
          };
          expect(computeSignals(future, t, cfg)).toEqual(computeSignals(w, t, cfg));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("truncating the series right after bar t gives the same signals", async () => {
    const { w, t } = await fixture("demo-entry");
    const close = w.candles1h[t]!.openTime + INTERVAL_MS["1h"];
    const cut: MarketWindow = {
      ...w,
      candles1h: w.candles1h.slice(0, t + 1),
      btc1h: w.btc1h.filter((c) => c.openTime < close),
      btc4h: w.btc4h.filter((c) => c.openTime + INTERVAL_MS["4h"] <= close),
    };
    expect(computeSignals(cut, t, cfg)).toEqual(computeSignals(w, t, cfg));
  });
});

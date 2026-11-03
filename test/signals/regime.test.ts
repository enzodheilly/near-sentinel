import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { computeIndicators } from "../../src/signals/indicators/index.ts";
import { btcRegime, btcTrend, corrAt, lastClosed4h, regimeContext } from "../../src/signals/regime.ts";
import type { SeriesAt } from "../../src/signals/signal.ts";
import type { Candle, TradableAsset } from "../../src/types.ts";

const H = 3_600_000;
const H4 = 4 * H;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const bar = (openTime: number, close: number): Candle => ({ openTime, open: close, high: close, low: close, close, volume: 1 });

/** 1h closes from log returns r[i] (bar 0 at 100). */
function fromReturns(r: readonly number[]): Candle[] {
  let p = 100;
  return r.map((x, i) => bar(T0 + i * H, (p = i === 0 ? p : p * Math.exp(x))));
}
const R = Array.from({ length: 60 }, (_, i) => 0.01 * Math.sin(i * 1.3));
/** 90 BTC 4h candles from T0 − 70 × 4h, trending up or down. */
const trend4h = (dir: 1 | -1) => Array.from({ length: 90 }, (_, i) => bar(T0 + (i - 70) * H4, 1000 + dir * 5 * i));

function setup(opts: { asset?: TradableAsset; trend: 1 | -1; nearR?: readonly number[] }) {
  const btc1h = fromReturns(R);
  const own = opts.asset === "BTC" ? btc1h : fromReturns(opts.nearR ?? R);
  const s: SeriesAt = { asset: opts.asset ?? "NEAR", candles: own, ind: computeIndicators(own, cfg.indicators), t: 55 };
  return { s, ctx: regimeContext(btc1h, trend4h(opts.trend), cfg) };
}

describe("lastClosed4h — the 4h candle in use must be closed at the end of bar t", () => {
  const c4 = trend4h(1); // c4[70] opens at T0
  it.each([
    [T0 + 4 * H, 70], // exactly when c4[70] closes
    [T0 + 4 * H - 1, 69], // a millisecond earlier, c4[70] is still open
    [T0 + 7 * H, 70],
    [T0 - 1000 * H, -1],
  ])("close time %i → index %i", (closeTime, idx) => {
    expect(lastClosed4h(c4, closeTime)).toBe(idx);
  });

  it("a 1h bar opened at 10:00 (closes 11:00) uses the 04:00 candle, not the open 08:00 one", () => {
    const ctx = regimeContext([], c4, cfg);
    expect(ctx.btc4h[btcTrend(ctx, T0 + 10 * H, cfg)!.index]!.openTime).toBe(T0 + 4 * H);
    expect(ctx.btc4h[btcTrend(ctx, T0 + 11 * H, cfg)!.index]!.openTime).toBe(T0 + 8 * H); // 11:00 bar closes 12:00
  });

  it("an unclosed 4h candle is never read: changing it (and later ones) does not change the signal", () => {
    const { s: s55, ctx } = setup({ trend: 1 });
    const s = { ...s55, t: 54 }; // bar 54 closes at T0 + 55h; the 4h candle opened at T0 + 52h is still open
    const before = btcRegime(s, ctx, cfg);
    expect(before?.evidence["regime4hOpenTime"]).toBe(T0 + 48 * H);
    const c4 = ctx.btc4h.map((c) => (c.openTime >= T0 + 52 * H ? bar(c.openTime, 1) : c)); // crash them
    expect(btcRegime(s, regimeContext(ctx.btc1h, c4, cfg), cfg)).toEqual(before);
    // …whereas at bar 55 (closes T0 + 56h) the 52h candle is closed and the crash is read.
    expect(btcRegime(s55, regimeContext(ctx.btc1h, c4, cfg), cfg)?.direction).toBe("veto");
  });
});

describe("BTC_REGIME table (RISK_ENGINE.md §3.5)", () => {
  const neg = R.map((x) => -x); // corr = −1

  it.each([
    ["corr ≥ 0.6", "bullish", R, 1, "bullish"],
    ["corr ≥ 0.6", "bearish", R, -1, "veto"],
    ["corr < 0.6", "bullish", neg, 1, null],
    ["corr < 0.6", "bearish", neg, -1, null],
  ] as const)("NEAR, %s, BTC %s → %s", (_c, _r, nearR, trend, expected) => {
    const { s, ctx } = setup({ trend, nearR });
    const sig = btcRegime(s, ctx, cfg);
    expect(sig?.direction ?? null).toBe(expected);
    if (sig) expect(sig).toMatchObject({ kind: "BTC_REGIME", asset: "NEAR", strength: 1, evidence: { corr: expect.closeTo(1, 12) } });
  });

  it("NEAR: an undefined correlation (flat NEAR) counts as < 0.6", () => {
    const { s, ctx } = setup({ trend: -1, nearR: R.map(() => 0) });
    expect(Number.isNaN(corrAt(s.candles, ctx.btc1h, s.t, 48))).toBe(true);
    expect(btcRegime(s, ctx, cfg)).toBeNull();
  });

  it("NEAR: a BTC bar missing from the correlation window → treated as undefined", () => {
    const { s, ctx } = setup({ trend: -1 });
    const btc1h = ctx.btc1h.filter((_, i) => i !== 30);
    expect(btcRegime(s, { ...ctx, btc1h }, cfg)).toBeNull();
  });

  it.each([
    [1, "bullish"],
    [-1, "veto"],
  ] as const)("BTC: trend %i → %s whatever the correlation", (trend, expected) => {
    const { s, ctx } = setup({ asset: "BTC", trend });
    expect(btcRegime(s, ctx, cfg)?.direction).toBe(expected);
  });

  it("returns null with fewer than 60 closed 4h candles", () => {
    const { s, ctx } = setup({ trend: -1 });
    const last = lastClosed4h(ctx.btc4h, s.candles[s.t]!.openTime + H);
    const short = ctx.btc4h.slice(last - 58); // 59 closed candles
    expect(btcRegime(s, regimeContext(ctx.btc1h, short, cfg), cfg)).toBeNull();
    const enough = ctx.btc4h.slice(last - 59); // 60
    expect(btcRegime(s, regimeContext(ctx.btc1h, enough, cfg), cfg)).not.toBeNull();
  });

  it("returns null when the correlation window is not covered (t < 48)", () => {
    const { s, ctx } = setup({ trend: 1 });
    expect(btcRegime({ ...s, t: 47 }, ctx, cfg)).toBeNull();
  });
});

describe("BTC_REGIME on the committed fixtures", () => {
  async function load(name: string) {
    const set = await loadFixtureSet(new URL(`../../fixtures/${name}/`, import.meta.url).pathname);
    const near = set.series["NEARUSDT"]!["1h"]!.candles;
    const t = near.findIndex((c) => c.openTime === set.signalBarTime);
    const s: SeriesAt = { asset: "NEAR", candles: near, ind: computeIndicators(near, cfg.indicators), t };
    return { s, ctx: regimeContext(set.series["BTCUSDT"]!["1h"]!.candles, set.series["BTCUSDT"]!["4h"]!.candles, cfg) };
  }

  it("demo-entry: bullish BTC, corr 0.665 → confirmation", async () => {
    const { s, ctx } = await load("demo-entry");
    const sig = btcRegime(s, ctx, cfg);
    expect(sig?.direction).toBe("bullish");
    expect(sig!.evidence["corr"]).toBeCloseTo(0.665268018623373, 12);
  });

  it("demo-refusal: BTC bullish but corr 0.30 → ignored", async () => {
    const { s, ctx } = await load("demo-refusal");
    expect(btcTrend(ctx, s.candles[s.t]!.openTime, cfg)?.regime).toBe("bullish");
    expect(corrAt(s.candles, ctx.btc1h, s.t, 48)).toBeCloseTo(0.30072572550424853, 12);
    expect(btcRegime(s, ctx, cfg)).toBeNull();
  });
});

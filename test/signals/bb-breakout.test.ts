import { describe, expect, it } from "vitest";
import { defaultRiskConfig } from "../../src/config/default.ts";
import { bbBreakout, lastSqueezeBar } from "../../src/signals/bb-breakout.ts";
import type { Candle } from "../../src/types.ts";
import { fixtureAt, k, quiet, seriesAt } from "./helpers.ts";

// Readable periods for crafted sequences. BB(10, 2): with fewer than ~7 bars, a single close can
// never exceed the upper band (max z-score of one point among n is (n − 1)/√n, below 2 for n = 5).
// ATR(14) keeps one spike bar from dominating the strength.
const IND = { ...defaultRiskConfig.indicators, atr: 14, bb: { n: 10, k: 2 } };
const CFG = { squeeze: { lookback: 10, percentile: 0.2, recentBars: 3 }, breakoutBodyRatio: 0.5 };

/** 30 wide bars, 12 tight ones (a squeeze), then the bar under test at index 42. */
function squeezeThen(last: (i: number) => Candle): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 30; i++) cs.push(quiet(i, 10, 1.0));
  for (let i = 30; i < 42; i++) cs.push(quiet(i, 10, 0.05));
  cs.push(last(42));
  return cs;
}
/** Volatility widening all the way, so bandwidth never sits in its lowest quintile: no squeeze. */
function wideningThen(last: (i: number) => Candle): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < 42; i++) cs.push(quiet(i, 10, 0.2 + i * 0.05));
  cs.push(last(42));
  return cs;
}
const strongBull = (i: number) => k(i, 10.0, 11.05, 9.98, 11.0); // body 1.00 of range 1.07

function conditions(cs: Candle[]) {
  const s = seriesAt(cs, cs.length - 1, IND);
  const c = cs[s.t]!;
  return { s, squeeze: lastSqueezeBar(s.ind.bb.bandwidth, s.t, CFG.squeeze) >= 0, aboveBand: c.close > s.ind.bb.upper[s.t]!, body: (c.close - c.open) / (c.high - c.low) };
}

describe("BB_BREAKOUT (RISK_ENGINE.md §3.1)", () => {
  it("fires on a squeeze followed by a full-bodied close above the upper band", () => {
    const { s, squeeze, aboveBand } = conditions(squeezeThen(strongBull));
    expect([squeeze, aboveBand]).toEqual([true, true]);
    const sig = bbBreakout(s, CFG);
    expect(sig).toMatchObject({ kind: "BB_BREAKOUT", direction: "bullish", asset: "NEAR", barTime: s.candles[s.t]!.openTime });
    expect(sig!.evidence["close"]).toBe(11);
    expect(sig!.strength).toBeGreaterThan(0);
  });

  it("does not fire without a squeeze, even on a clean breakout", () => {
    const { s, squeeze, aboveBand, body } = conditions(wideningThen((i) => k(i, 10.0, 16.1, 9.9, 16.0)));
    expect([squeeze, aboveBand, body >= 0.5]).toEqual([false, true, true]);
    expect(bbBreakout(s, CFG)).toBeNull();
  });

  it("does not fire on a wick-only spike (body below 50 % of the range)", () => {
    const { s, squeeze, aboveBand, body } = conditions(squeezeThen((i) => k(i, 10.8, 11.6, 9.5, 11.0)));
    expect([squeeze, aboveBand, body < 0.5]).toEqual([true, true, true]);
    expect(bbBreakout(s, CFG)).toBeNull();
  });

  it("does not fire when the close stays at or below the upper band", () => {
    const { s, squeeze, aboveBand } = conditions(squeezeThen((i) => k(i, 9.99, 10.03, 9.98, 10.02)));
    expect([squeeze, aboveBand]).toEqual([true, false]);
    expect(bbBreakout(s, CFG)).toBeNull();
  });

  it("returns null during warm-up instead of throwing", () => {
    const cs = squeezeThen(strongBull);
    for (let t = 0; t < 22; t++) expect(bbBreakout(seriesAt(cs, t, IND), CFG)).toBeNull();
  });

  it("caps strength at 1", () => {
    const sig = bbBreakout(seriesAt(squeezeThen((i) => k(i, 10.0, 30.1, 9.99, 30.0)), 42, IND), CFG);
    expect(sig!.strength).toBe(1);
  });
});

describe("lastSqueezeBar", () => {
  // Rising bandwidth: each bar is above all previous ones, so never in a squeeze …
  const bbw = Array.from({ length: 40 }, (_, i) => 1 + i * 0.01);
  bbw[20] = 0.1; // … except bar 20.

  it("finds a squeeze inside t − recentBars … t − 1", () => {
    expect(lastSqueezeBar(bbw, 22, CFG.squeeze)).toBe(20);
    expect(lastSqueezeBar(bbw, 23, CFG.squeeze)).toBe(20);
  });

  it("ignores one that is older than recentBars, and the bar t itself", () => {
    expect(lastSqueezeBar(bbw, 24, CFG.squeeze)).toBe(-1);
    expect(lastSqueezeBar(bbw, 20, CFG.squeeze)).toBe(-1);
  });

  it("treats a flat bandwidth as a squeeze (the rule is 'at or below' the percentile)", () => {
    expect(lastSqueezeBar(new Array(30).fill(1), 25, CFG.squeeze)).toBe(24);
  });

  it("returns −1 while the lookback window is incomplete or warming up", () => {
    expect(lastSqueezeBar(bbw, 10, CFG.squeeze)).toBe(-1);
    expect(lastSqueezeBar([...new Array(15).fill(Number.NaN), ...bbw], 30, CFG.squeeze)).toBe(-1);
  });
});

describe("BB_BREAKOUT on the committed fixtures (default config)", () => {
  const cfg = defaultRiskConfig.signals;

  it("demo-entry: fires at the signal bar with the strength recorded at freeze time (0.0711)", async () => {
    const s = bbBreakout(await fixtureAt("demo-entry"), cfg);
    expect(s?.kind).toBe("BB_BREAKOUT");
    // The freezing tool ran on the full history; the fixture starts 200 bars earlier, so Wilder ATR
    // still carries a ~3e-9 trace of its seed. Agreement to 1e-7 confirms the same formula.
    expect(s!.strength).toBeCloseTo(0.07106544150791813, 7);
  });

  it("demo-refusal: fires too (the refusal comes from the RSI veto, not from the trigger)", async () => {
    const s = bbBreakout(await fixtureAt("demo-refusal"), cfg);
    expect(s?.kind).toBe("BB_BREAKOUT");
    expect(s!.strength).toBe(1);
  });

  it("demo-entry: does not fire on the bar before the signal", async () => {
    const f = await fixtureAt("demo-entry");
    expect(bbBreakout({ ...f, t: f.t - 1 }, cfg)).toBeNull();
  });
});

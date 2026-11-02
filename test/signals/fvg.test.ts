import { describe, expect, it } from "vitest";
import { defaultRiskConfig } from "../../src/config/default.ts";
import { findSupportingGap, fvgSupport } from "../../src/signals/fvg.ts";
import type { Candle } from "../../src/types.ts";
import { fixtureAt, k } from "./helpers.ts";

const CFG = defaultRiskConfig.signals.fvg; // maxAgeBars 24, minSizeAtr 0.25, maxDistanceAtr 1.5
const flat = (i: number) => k(i, 10, 10.05, 9.95, 10);

/**
 * Flat bars, then a gap whose third bar is at index `gapAt`: bar gapAt−2 has high 10.05,
 * bar gapAt has low 10.20 → zone [10.05, 10.20], size 0.15. Bars after it hover at `after`.
 */
function withGap(gapAt: number, length: number, after = 10.25): Candle[] {
  const cs: Candle[] = [];
  for (let i = 0; i < length; i++) {
    if (i < gapAt - 1) cs.push(flat(i));
    else if (i === gapAt - 1) cs.push(k(i, 10, 10.3, 9.98, 10.28)); // impulse
    else if (i === gapAt) cs.push(k(i, 10.28, 10.35, 10.2, 10.3)); // low 10.20 > high[i−2] 10.05
    else cs.push(k(i, after, after + 0.03, after - 0.03, after));
  }
  return cs;
}
const atrOf = (cs: Candle[], v = 0.1) => cs.map(() => v);

describe("FVG_SUPPORT (RISK_ENGINE.md §3.4)", () => {
  it("finds an unfilled, meaningful, recent gap just under the price", () => {
    const cs = withGap(30, 35);
    expect(findSupportingGap(cs, atrOf(cs), 34, CFG)).toEqual({ i: 30, bottom: 10.05, top: 10.2 });
  });

  it("ignores a gap that was filled by a later close below its bottom", () => {
    const cs = withGap(30, 35);
    cs[32] = k(32, 10.2, 10.22, 9.9, 10.0); // close 10.00 < 10.05
    expect(findSupportingGap(cs, atrOf(cs), 34, CFG)).toBeNull();
  });

  it("a wick below the bottom does not fill it — only a close does", () => {
    const cs = withGap(30, 35);
    cs[32] = k(32, 10.25, 10.28, 9.9, 10.24); // low 9.90, close 10.24
    expect(findSupportingGap(cs, atrOf(cs), 34, CFG)).not.toBeNull();
  });

  it("ignores a gap smaller than 0.25 × ATR at its bar", () => {
    const cs = withGap(30, 35);
    const atr = atrOf(cs);
    atr[30] = 0.7; // 0.25 × 0.7 = 0.175 > 0.15
    expect(findSupportingGap(cs, atr, 34, CFG)).toBeNull();
    atr[30] = 0.5; // 0.25 × 0.5 = 0.125 ≤ 0.15
    expect(findSupportingGap(cs, atr, 34, CFG)).not.toBeNull();
  });

  it("accepts a gap aged 23 bars and ignores one aged 24", () => {
    const cs = withGap(30, 60);
    expect(findSupportingGap(cs, atrOf(cs), 53, CFG)?.i).toBe(30); // age 23
    expect(findSupportingGap(cs, atrOf(cs), 54, CFG)).toBeNull(); // age 24
  });

  it("ignores a gap whose top is more than 1.5 ATR under the close", () => {
    const cs = withGap(30, 35); // ATR 0.02: close 10.25 − 1.5 × 0.02 = 10.22 > top 10.20
    expect(findSupportingGap(cs, atrOf(cs, 0.02), 34, CFG)).toBeNull();
  });

  it("ignores a gap whose top is above the close", () => {
    const cs = withGap(30, 35, 10.15); // still unfilled (10.15 > 10.05) but top 10.20 > close
    expect(findSupportingGap(cs, atrOf(cs), 34, CFG)).toBeNull();
  });

  it("reports the most recent qualifying gap", () => {
    const cs = withGap(30, 40);
    cs[34] = k(34, 10.2, 10.22, 10.18, 10.21); // high[i−2] for a second gap at i = 36
    cs[35] = k(35, 10.26, 10.4, 10.25, 10.38);
    cs[36] = k(36, 10.38, 10.42, 10.3, 10.36); // low 10.30 > 10.22; both gaps qualify at ATR 0.2
    for (let i = 37; i < 40; i++) cs[i] = k(i, 10.36, 10.39, 10.33, 10.36);
    expect(findSupportingGap(cs, atrOf(cs, 0.2), 39, CFG)).toEqual({ i: 36, bottom: 10.22, top: 10.3 });
  });

  it("returns null when ATR is still warming up", () => {
    const cs = withGap(30, 35);
    expect(findSupportingGap(cs, cs.map(() => Number.NaN), 34, CFG)).toBeNull();
  });
});

describe("FVG_SUPPORT on the committed fixtures", () => {
  const cfg = defaultRiskConfig.signals;

  it("demo-entry: the gap 1.912–1.918, one bar old, as recorded at freeze time", async () => {
    const s = fvgSupport(await fixtureAt("demo-entry"), cfg);
    expect(s).toMatchObject({ kind: "FVG_SUPPORT", direction: "bullish", strength: 1 });
    expect(s!.evidence).toMatchObject({ fvgBottom: 1.912, fvgTop: 1.918, ageBars: 1 });
  });

  it("demo-refusal: no supporting gap", async () => {
    expect(fvgSupport(await fixtureAt("demo-refusal"), cfg)).toBeNull();
  });
});

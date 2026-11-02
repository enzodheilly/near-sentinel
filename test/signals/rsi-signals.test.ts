import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig } from "../../src/config/default.ts";
import { computeIndicators } from "../../src/signals/indicators/index.ts";
import { rsiExhaustion, rsiMomentum } from "../../src/signals/rsi-signals.ts";
import type { SeriesAt } from "../../src/signals/signal.ts";
import { fixtureAt, k } from "./helpers.ts";

const cfg = defaultRiskConfig.signals;

/** A series whose RSI at bar 20 is exactly `value` (the RSI array is injected; candles only carry time). */
function withRsi(value: number): SeriesAt {
  const candles = Array.from({ length: 21 }, (_, i) => k(i, 1, 1, 1, 1));
  const ind = computeIndicators(candles, defaultRiskConfig.indicators);
  const rsi = [...new Array(20).fill(Number.NaN), value];
  return { asset: "NEAR", candles, ind: { ...ind, rsi }, t: 20 };
}

describe("RSI_MOMENTUM (RISK_ENGINE.md §3.2)", () => {
  it.each([
    [54.999, false],
    [55, true],
    [65, true],
    [75, true],
    [75.001, false],
  ])("RSI %f → fires: %s (band [55, 75] is inclusive)", (r, fires) => {
    const s = rsiMomentum(withRsi(r), cfg);
    expect(s !== null).toBe(fires);
    if (s) expect(s).toMatchObject({ kind: "RSI_MOMENTUM", direction: "bullish", strength: 1, evidence: { rsi: r, low: 55, high: 75 } });
  });
});

describe("RSI_EXHAUSTION (RISK_ENGINE.md §3.3)", () => {
  it.each([
    [79.999, false],
    [80, false],
    [80.001, true],
    [99, true],
  ])("RSI %f → veto: %s (strictly above 80)", (r, fires) => {
    const s = rsiExhaustion(withRsi(r), cfg);
    expect(s !== null).toBe(fires);
    if (s) expect(s).toMatchObject({ kind: "RSI_EXHAUSTION", direction: "veto", strength: 1, evidence: { rsi: r, threshold: 80 } });
  });
});

describe("RSI signals", () => {
  it("return null during warm-up", () => {
    const s = withRsi(Number.NaN);
    expect(rsiMomentum(s, cfg)).toBeNull();
    expect(rsiExhaustion(s, cfg)).toBeNull();
  });

  it("property: momentum and exhaustion never fire on the same bar", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (r) => {
      const s = withRsi(r);
      expect(rsiMomentum(s, cfg) !== null && rsiExhaustion(s, cfg) !== null).toBe(false);
    }));
  });

  // The freezing tool ran on the full history; the fixtures start 200 bars earlier, so Wilder RSI still
  // carries a ~1e-6 trace of its seed. Agreement to 1e-4 confirms the same formula.
  it("demo-entry: momentum at the signal bar (RSI 58.10), no veto", async () => {
    const f = await fixtureAt("demo-entry");
    expect(rsiMomentum(f, cfg)?.evidence["rsi"]).toBeCloseTo(58.10085401846159, 4);
    expect(rsiExhaustion(f, cfg)).toBeNull();
  });

  it("demo-refusal: exhaustion veto at the signal bar (RSI 82.45), no momentum", async () => {
    const f = await fixtureAt("demo-refusal");
    expect(rsiExhaustion(f, cfg)?.evidence["rsi"]).toBeCloseTo(82.45445552062321, 4);
    expect(rsiMomentum(f, cfg)).toBeNull();
  });
});

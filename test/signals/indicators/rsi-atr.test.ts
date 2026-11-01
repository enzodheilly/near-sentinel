import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atr, trueRange } from "../../../src/signals/indicators/atr.ts";
import { rsi } from "../../../src/signals/indicators/rsi.ts";

const isNan = (x: number | undefined) => x !== undefined && Number.isNaN(x);

describe("rsi", () => {
  it("matches a hand-computed series (n = 3)", () => {
    // changes: +1, −0.5, +1, −0.5, +1
    // i=3: avgGain = 2/3, avgLoss = 1/6            → RS 4    → 80
    // i=4: avgGain = 4/9, avgLoss = 5/18           → RS 1.6  → 61.538…
    // i=5: avgGain = 17/27, avgLoss = 5/27         → RS 3.4  → 77.272…
    const r = rsi([10, 11, 10.5, 11.5, 11, 12], 3);
    expect(r.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(r[3]).toBeCloseTo(80, 10);
    expect(r[4]).toBeCloseTo(100 - 100 / 2.6, 10);
    expect(r[5]).toBeCloseTo(100 - 100 / 4.4, 10);
  });

  // Not used as a reference: the widely quoted StockCharts RSI(14) example (first value 70.53).
  // Its published closes are rounded to 2 decimals while the source spreadsheet was not, so the
  // rounded closes give 70.46 with an exact implementation. Instead, the property below checks the
  // recursive smoothing against its closed form, computed independently.

  it("property: equals the closed form of Wilder smoothing", () => {
    // avg_t = (1 − a)^(t−n) · seed + Σ_{k=n+1..t} a (1 − a)^(t−k) · x_k, with a = 1/n
    const closedForm = (closes: number[], n: number, t: number) => {
      const a = 1 / n;
      const parts = (sign: 1 | -1) => {
        const x = (i: number) => Math.max(sign * ((closes[i] as number) - (closes[i - 1] as number)), 0);
        let seed = 0;
        for (let i = 1; i <= n; i++) seed += x(i) / n;
        let sum = (1 - a) ** (t - n) * seed;
        for (let k = n + 1; k <= t; k++) sum += a * (1 - a) ** (t - k) * x(k);
        return sum;
      };
      const g = parts(1);
      const l = parts(-1);
      return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    };
    fc.assert(
      fc.property(fc.array(fc.double({ min: 1, max: 100, noNaN: true }), { minLength: 30, maxLength: 60 }), fc.integer({ min: 2, max: 14 }), (closes, n) => {
        const r = rsi(closes, n);
        for (let t = n; t < closes.length; t++) expect(r[t]).toBeCloseTo(closedForm(closes, n, t), 8);
      }),
    );
  });

  it("is 100 on a strictly rising series and 50 on a flat one", () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1), 14)[20]).toBe(100);
    expect(rsi(new Array(30).fill(2), 14)[20]).toBe(50);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14)[20]).toBe(0);
  });

  it("returns all NaN when there is not enough history", () => {
    expect(rsi([1, 2, 3], 3).every(Number.isNaN)).toBe(true);
    expect(rsi([], 14)).toEqual([]);
  });

  it("rejects an invalid period", () => {
    expect(() => rsi([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => rsi([1, 2, 3], 1.5)).toThrow(RangeError);
  });

  const closesArb = fc.array(fc.double({ min: 0.01, max: 1e6, noNaN: true }), { minLength: 20, maxLength: 120 });

  it("property: stays within [0, 100], NaN exactly before index n", () => {
    fc.assert(
      fc.property(closesArb, fc.integer({ min: 2, max: 18 }), (closes, n) => {
        const r = rsi(closes, n);
        r.forEach((v, i) => {
          if (i < n) expect(v).toBeNaN();
          else expect(v >= 0 && v <= 100).toBe(true);
        });
      }),
    );
  });

  it("property: invariant to price scale and translation", () => {
    fc.assert(
      fc.property(closesArb, fc.double({ min: 0.1, max: 100, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }), (closes, k, b) => {
        const base = rsi(closes, 14);
        const moved = rsi(closes.map((c) => c * k + b), 14);
        base.forEach((v, i) => (isNan(v) ? expect(moved[i]).toBeNaN() : expect(moved[i]).toBeCloseTo(v, 6)));
      }),
    );
  });

  it("property: causal — the value at i never depends on later closes", () => {
    fc.assert(
      fc.property(closesArb, fc.integer({ min: 15, max: 19 }), (closes, cut) => {
        const full = rsi(closes, 14);
        const prefix = rsi(closes.slice(0, cut + 1), 14);
        expect(prefix).toEqual(full.slice(0, cut + 1));
      }),
    );
  });
});

describe("atr", () => {
  const c = (high: number, low: number, close: number) => ({ high, low, close });

  it("matches a hand-computed series (n = 3), including a gap down", () => {
    const candles = [
      c(10, 9, 9.5),
      c(10.5, 9.6, 10.2), // TR = |10.5 − 9.5|       = 1.0
      c(10.4, 9.9, 10), //  TR = 10.4 − 9.9          = 0.5
      c(11, 10.1, 10.8), // TR = |11 − 10|           = 1.0   → ATR = 2.5 / 3
      c(10.9, 9.8, 10), //  TR = 10.9 − 9.8          = 1.1   → ATR = (2.5/3 × 2 + 1.1) / 3
      c(9.5, 9.0, 9.2), //  TR = |9.0 − 10| (gap)    = 1.0   → ATR = (prev × 2 + 1.0) / 3
    ];
    const a = atr(candles, 3);
    expect(a.slice(0, 3).every(Number.isNaN)).toBe(true);
    const a3 = 2.5 / 3;
    const a4 = (a3 * 2 + 1.1) / 3;
    expect(a[3]).toBeCloseTo(a3, 12);
    expect(a[4]).toBeCloseTo(a4, 12);
    expect(a[5]).toBeCloseTo((a4 * 2 + 1.0) / 3, 12);
  });

  it("trueRange uses the previous close on gaps", () => {
    expect(trueRange(c(12, 11, 11.5), 10)).toBe(2); // gap up: high − prevClose
    expect(trueRange(c(9, 8, 8.5), 10)).toBe(2); // gap down: prevClose − low
    expect(trueRange(c(10.5, 9.5, 10), 10)).toBe(1); // inside bar: high − low
  });

  it("returns all NaN when there is not enough history, and rejects an invalid period", () => {
    expect(atr([c(1, 1, 1), c(1, 1, 1)], 2).every(Number.isNaN)).toBe(true);
    expect(() => atr([], -1)).toThrow(RangeError);
  });

  const candlesArb = fc
    .array(fc.tuple(fc.double({ min: 1, max: 1000, noNaN: true }), fc.double({ min: 0, max: 0.1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })), { minLength: 20, maxLength: 120 })
    .map((rows) => rows.map(([mid, spread, pos]) => { const low = mid * (1 - spread); const high = mid * (1 + spread); return { high, low, close: low + (high - low) * pos }; }));

  it("property: non-negative, NaN exactly before index n", () => {
    fc.assert(
      fc.property(candlesArb, fc.integer({ min: 2, max: 18 }), (candles, n) => {
        atr(candles, n).forEach((v, i) => (i < n ? expect(v).toBeNaN() : expect(v).toBeGreaterThanOrEqual(0)));
      }),
    );
  });

  it("property: scales with price and ignores translation", () => {
    fc.assert(
      fc.property(candlesArb, fc.double({ min: 0.1, max: 100, noNaN: true }), fc.double({ min: 0, max: 1000, noNaN: true }), (candles, k, b) => {
        const base = atr(candles, 14);
        const scaled = atr(candles.map((x) => c(x.high * k, x.low * k, x.close * k)), 14);
        const shifted = atr(candles.map((x) => c(x.high + b, x.low + b, x.close + b)), 14);
        base.forEach((v, i) => {
          if (isNan(v)) return;
          expect(scaled[i]).toBeCloseTo(v * k, 6);
          expect(shifted[i]).toBeCloseTo(v, 6);
        });
      }),
    );
  });

  it("property: causal — the value at i never depends on later candles", () => {
    fc.assert(
      fc.property(candlesArb, fc.integer({ min: 15, max: 19 }), (candles, cut) => {
        expect(atr(candles.slice(0, cut + 1), 14)).toEqual(atr(candles, 14).slice(0, cut + 1));
      }),
    );
  });
});

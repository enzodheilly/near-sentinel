import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bollinger } from "../../../src/signals/indicators/bollinger.ts";
import { logReturns, pearson } from "../../../src/signals/indicators/correlation.ts";
import { ema } from "../../../src/signals/indicators/ema.ts";
import { percentile } from "../../../src/signals/indicators/percentile.ts";

const pricesArb = fc.array(fc.double({ min: 0.01, max: 1e5, noNaN: true }), { minLength: 25, maxLength: 120 });

describe("bollinger", () => {
  it("matches a hand-computed window (n = 3, k = 2)", () => {
    // window [1, 2, 3]: mean 2, population variance 2/3, σ = √(2/3)
    const b = bollinger([1, 2, 3, 4], 3, 2);
    const sd = Math.sqrt(2 / 3);
    expect([b.middle[0], b.middle[1]].every(Number.isNaN)).toBe(true);
    expect(b.middle[2]).toBe(2);
    expect(b.upper[2]).toBeCloseTo(2 + 2 * sd, 12);
    expect(b.lower[2]).toBeCloseTo(2 - 2 * sd, 12);
    expect(b.bandwidth[2]).toBeCloseTo((4 * sd) / 2, 12);
    expect(b.middle[3]).toBe(3); // window [2, 3, 4]
  });

  it("uses the population (÷ n), not the sample (÷ n − 1), standard deviation", () => {
    const b = bollinger([2, 4], 2, 1); // σ_pop = 1, σ_sample = √2
    expect(b.upper[1]).toBe(4);
  });

  it("has zero bandwidth on a flat series", () => {
    const b = bollinger(new Array(25).fill(3), 20, 2);
    expect(b.bandwidth[24]).toBe(0);
    expect(b.upper[24]).toBe(3);
  });

  it("rejects invalid parameters", () => {
    expect(() => bollinger([1, 2], 0, 2)).toThrow(RangeError);
    expect(() => bollinger([1, 2], 2, 0)).toThrow(RangeError);
  });

  it("property: lower <= middle <= upper, bandwidth >= 0, NaN exactly before n − 1", () => {
    fc.assert(
      fc.property(pricesArb, fc.integer({ min: 2, max: 20 }), (closes, n) => {
        const b = bollinger(closes, n, 2);
        for (let i = 0; i < closes.length; i++) {
          if (i < n - 1) {
            expect(b.middle[i]).toBeNaN();
            continue;
          }
          const tol = 1e-9 * Math.abs(b.middle[i]!);
          expect(b.lower[i]! <= b.middle[i]! + tol && b.middle[i]! <= b.upper[i]! + tol).toBe(true);
          expect(b.bandwidth[i]).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("property: bandwidth is scale invariant; bands are causal", () => {
    fc.assert(
      fc.property(pricesArb, fc.double({ min: 0.1, max: 100, noNaN: true }), (closes, k) => {
        const base = bollinger(closes, 20, 2);
        const scaled = bollinger(closes.map((c) => c * k), 20, 2);
        base.bandwidth.forEach((v, i) => (Number.isNaN(v) ? expect(scaled.bandwidth[i]).toBeNaN() : expect(scaled.bandwidth[i]).toBeCloseTo(v, 9)));
        expect(bollinger(closes.slice(0, 22), 20, 2).upper).toEqual(base.upper.slice(0, 22));
      }),
    );
  });
});

describe("ema", () => {
  it("matches a hand-computed series (n = 3, α = 0.5)", () => {
    // seed = (1 + 2 + 3) / 3 = 2; then 0.5·4 + 0.5·2 = 3; then 0.5·5 + 0.5·3 = 4
    const e = ema([1, 2, 3, 4, 5], 3);
    expect([e[0], e[1]].every(Number.isNaN)).toBe(true);
    expect(e.slice(2)).toEqual([2, 3, 4]);
  });

  it("is constant on a constant series, and all NaN when too short", () => {
    expect(ema(new Array(60).fill(7), 50)[59]).toBe(7);
    expect(ema([1, 2], 3).every(Number.isNaN)).toBe(true);
  });

  it("property: stays within the range of the values seen so far; causal", () => {
    fc.assert(
      fc.property(pricesArb, fc.integer({ min: 2, max: 20 }), (values, n) => {
        const e = ema(values, n);
        for (let i = n - 1; i < values.length; i++) {
          const seen = values.slice(0, i + 1);
          const lo = Math.min(...seen);
          const hi = Math.max(...seen);
          expect(e[i]! >= lo - 1e-9 * hi && e[i]! <= hi * (1 + 1e-12)).toBe(true);
        }
        expect(ema(values.slice(0, n + 3), n)).toEqual(e.slice(0, n + 3));
      }),
    );
  });
});

describe("percentile (nearest-rank)", () => {
  it("returns sorted[floor(p × (len − 1))]", () => {
    const xs = [5, 1, 4, 2, 3]; // sorted 1 2 3 4 5
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 0.2)).toBe(1); // floor(0.8) = 0
    expect(percentile(xs, 0.5)).toBe(3); // floor(2) = 2
    expect(percentile(xs, 0.99)).toBe(4); // floor(3.96) = 3
    expect(percentile(xs, 1)).toBe(5);
  });

  it("does not mutate its input", () => {
    const xs = [3, 1, 2];
    percentile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("rejects empty windows, non-finite values and p outside [0, 1]", () => {
    expect(() => percentile([], 0.5)).toThrow(/empty/);
    expect(() => percentile([1, Number.NaN], 0.5)).toThrow(/non-finite/);
    expect(() => percentile([1], 1.2)).toThrow(RangeError);
  });

  it("property: always returns an observed value, monotone in p", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 50 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (xs, p, q) => {
        expect(xs).toContain(percentile(xs, p));
        const [lo, hi] = p <= q ? [p, q] : [q, p];
        expect(percentile(xs, lo)).toBeLessThanOrEqual(percentile(xs, hi));
      }),
    );
  });
});

describe("correlation", () => {
  it("logReturns computes ln(p_i / p_{i−1}) and rejects non-positive prices", () => {
    expect(logReturns([1, Math.E, 1])).toEqual([1, -1]);
    expect(() => logReturns([1, 0])).toThrow(RangeError);
  });

  it("pearson gives +1, −1 and 0 on known cases", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 2, 3], [1, 0, 1])).toBeCloseTo(0, 12);
  });

  it("pearson is NaN when undefined, so it never passes the `corr >= 0.6` test", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(pearson([1], [1])).toBeNaN();
    expect(pearson([1, 1, 1], [1, 2, 3]) >= 0.6).toBe(false);
  });

  it("stays defined on tiny but non-constant series (no variance underflow)", () => {
    // Found by fast-check: deviations ~1e-162 square to 0 without normalisation.
    expect(pearson([0, 2.36e-162, 0], [0, 0, -4.7e-162])).toBeCloseTo(0.5, 9);
    expect(pearson([0, 1e-300, 2e-300], [0, 2e-300, 4e-300])).toBeCloseTo(1, 12);
  });

  it("rejects series of different lengths", () => {
    expect(() => pearson([1, 2], [1])).toThrow(RangeError);
  });

  // Values on a 1e-6 grid in [−1, 1]: realistic for log returns, and an affine map cannot underflow
  // them to a constant (the tiny-magnitude case has its own regression test above).
  const unit = fc.integer({ min: -1_000_000, max: 1_000_000 }).map((x) => x / 1_000_000);
  const pairArb = fc
    .array(fc.tuple(unit, unit), { minLength: 3, maxLength: 60 })
    .map((rows) => [rows.map((r) => r[0]), rows.map((r) => r[1])] as const);

  it("property: in [−1, 1], symmetric, invariant to positive affine maps, flips sign on negation", () => {
    fc.assert(
      fc.property(pairArb, fc.double({ min: 0.1, max: 10, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), ([a, b], k, c) => {
        const r = pearson(a, b);
        fc.pre(Number.isFinite(r));
        expect(r >= -1 && r <= 1).toBe(true);
        expect(pearson(b, a)).toBeCloseTo(r, 9);
        expect(pearson(a.map((x) => k * x + c), b)).toBeCloseTo(r, 6);
        expect(pearson(a.map((x) => -x), b)).toBeCloseTo(-r, 9);
      }),
    );
  });
});

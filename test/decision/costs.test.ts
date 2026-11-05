import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { costFilter, feeFraction } from "../../src/decision/costs.ts";

const C = { costs: cfg.costs, exits: cfg.exits };

describe("costFilter (RISK_ENGINE.md §5.5)", () => {
  it("fee rates: 0.20% with the partner JWT, 0.45% without", () => {
    expect(feeFraction(true, cfg.costs)).toBeCloseTo(0.002, 15);
    expect(feeFraction(false, cfg.costs)).toBeCloseTo(0.0045, 15);
  });

  it("computes cost_frac = 2 × fee + 2 × slippage and cost_px = cost_frac × P_ref", () => {
    const r = costFilter({ pRef: 2, stop: 1.9, authenticated: true, entrySlippageFrac: 0.001 }, C);
    expect(r.costFrac).toBeCloseTo(0.006, 15);
    expect(r.costPx).toBeCloseTo(0.012, 15);
    expect(r.limitPx).toBeCloseTo(0.0375, 15); // 0.25 × 1.5 × 0.1
    expect(r.ok).toBe(true);
  });

  it("exact threshold: cost equal to 25% of the TP1 distance passes, a hair above is COST_TOO_HIGH", () => {
    const noFee = { costs: { ...cfg.costs, feePctAuthenticated: 0, feePctUnauthenticated: 0 }, exits: { ...cfg.exits, tp1R: 2 } }; // binary-exact
    // P_ref 1, stop 0 → R 1, TP1 distance 2, limit 0.5; slippage 0.25 each way → cost exactly 0.5
    expect(costFilter({ pRef: 1, stop: 0, authenticated: true, entrySlippageFrac: 0.25 }, noFee)).toMatchObject({ ok: true, costPx: 0.5, limitPx: 0.5 });
    const above = costFilter({ pRef: 1, stop: 0, authenticated: true, entrySlippageFrac: 0.25 + 2 ** -40 }, noFee);
    expect(above).toMatchObject({ ok: false, reason: "COST_TOO_HIGH" });
  });

  it("dropping the JWT flips a borderline case to COST_TOO_HIGH", () => {
    // R 0.04 → limit 0.25 × 1.5 × 0.04 = 0.015. JWT: 2 × (0.0020 + 0.001) × 2 = 0.012 ✓   no JWT: 2 × (0.0045 + 0.001) × 2 = 0.022 ✗
    const trade = { pRef: 2, stop: 1.96, entrySlippageFrac: 0.001 };
    expect(costFilter({ ...trade, authenticated: true }, C).ok).toBe(true);
    const r = costFilter({ ...trade, authenticated: false }, C);
    expect(r).toMatchObject({ ok: false, reason: "COST_TOO_HIGH" });
    expect(r.checks[0]?.detail).toContain("no JWT");
  });

  it("a favourable quote (negative slippage) does not lower the estimate", () => {
    const a = costFilter({ pRef: 2, stop: 1.9, authenticated: true, entrySlippageFrac: -0.004 }, C);
    const b = costFilter({ pRef: 2, stop: 1.9, authenticated: true, entrySlippageFrac: 0 }, C);
    expect(a.costPx).toBe(b.costPx);
  });

  it("demo-entry passes with the JWT (fees 0.30 R ≤ 0.375 R), and fails without it (0.68 R)", () => {
    // P_ref 1.936, stop 1.91037659 (sizing test) → R 0.025623, limit 0.25 × 1.5 R = 0.009609
    const trade = { pRef: 1.936, stop: 1.9103765940117474 };
    const ok = costFilter({ ...trade, authenticated: true, entrySlippageFrac: 0 }, C);
    expect(ok.ok).toBe(true);
    expect(ok.costPx).toBeCloseTo(0.007744, 12);
    // headroom: up to ~0.047% slippage each way still passes
    expect(costFilter({ ...trade, authenticated: true, entrySlippageFrac: 0.00047 }, C).ok).toBe(true);
    expect(costFilter({ ...trade, authenticated: true, entrySlippageFrac: 0.00049 }, C).ok).toBe(false);
    expect(costFilter({ ...trade, authenticated: false, entrySlippageFrac: 0 }, C)).toMatchObject({ ok: false, reason: "COST_TOO_HIGH" });
  });

  it("refuses nonsense inputs loudly", () => {
    expect(() => costFilter({ pRef: 2, stop: 2, authenticated: true, entrySlippageFrac: 0 }, C)).toThrow(RangeError);
    expect(() => costFilter({ pRef: 2, stop: 1, authenticated: true, entrySlippageFrac: Number.NaN }, C)).toThrow(RangeError);
  });

  it("property: more slippage or no JWT never turns a rejection into an acceptance", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1e5, noNaN: true }),
        fc.double({ min: 1e-4, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 0.02, noNaN: true }),
        fc.double({ min: 0, max: 0.02, noNaN: true }),
        (pRef, d, s, extra) => {
          const base = { pRef, stop: pRef * (1 - d), entrySlippageFrac: s };
          const ok = costFilter({ ...base, authenticated: true }, C).ok;
          if (!ok) {
            expect(costFilter({ ...base, authenticated: false }, C).ok).toBe(false);
            expect(costFilter({ ...base, authenticated: true, entrySlippageFrac: s + extra }, C).ok).toBe(false);
          }
        },
      ),
    );
  });
});

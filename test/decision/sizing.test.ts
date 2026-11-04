import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { equityUsd, placeStop, sizePosition, targets, type SizingInput } from "../../src/decision/sizing.ts";
import { computeSignals } from "../../src/signals/index.ts";
import type { Position } from "../../src/types.ts";

const S = cfg.sizing;

describe("placeStop (RISK_ENGINE.md §5.2)", () => {
  it("uses 1.5 ATR without a gap", () => {
    expect(placeStop(10, 0.2, undefined, S)).toMatchObject({ ok: true, stop: 9.7, source: "ATR", widened: false });
  });

  it("uses the gap bottom − 0.1 ATR when it is higher than the ATR stop", () => {
    const r = placeStop(10, 0.2, 9.85, S); // 9.85 − 0.02 = 9.83 > 9.70
    expect(r.ok && r.source).toBe("FVG");
    expect(r.ok && r.stop).toBeCloseTo(9.83, 12);
  });

  it("keeps the ATR stop when the gap stop is lower", () => {
    expect(placeStop(10, 0.2, 9.6, S)).toMatchObject({ ok: true, stop: 9.7, source: "ATR" });
  });

  it("moves a too-tight stop down to 0.5 ATR instead of rejecting", () => {
    const r = placeStop(10, 0.2, 9.99, S); // gap stop 9.97: distance 0.03 < 0.10
    expect(r).toMatchObject({ ok: true, widened: true });
    expect(r.ok && r.distance).toBeCloseTo(0.1, 12);
  });

  it("rejects a stop wider than 3 ATR with STOP_TOO_WIDE", () => {
    const wide = { ...S, stopAtrMult: 3.5 }; // the only way past 3 ATR: max(...) caps it at stopAtrMult
    expect(placeStop(10, 0.2, undefined, wide)).toMatchObject({ ok: false, reason: "STOP_TOO_WIDE" });
    expect(placeStop(10, 0.2, undefined, { ...S, stopAtrMult: 3 }).ok).toBe(true); // exactly 3 ATR passes
  });

  it("refuses nonsense inputs loudly", () => {
    expect(() => placeStop(10, 0, undefined, S)).toThrow(RangeError);
    expect(() => placeStop(Number.NaN, 0.2, undefined, S)).toThrow(RangeError);
  });

  it("demo-entry: the stop recorded at freeze time", async () => {
    const set = await loadFixtureSet(new URL("../../fixtures/demo-entry/", import.meta.url).pathname);
    const w = { asset: set.asset, candles1h: set.series["NEARUSDT"]!["1h"]!.candles, btc1h: set.series["BTCUSDT"]!["1h"]!.candles, btc4h: set.series["BTCUSDT"]!["4h"]!.candles };
    const sig = computeSignals(w, 200, cfg);
    const bo = sig.find((s) => s.kind === "BB_BREAKOUT")!.evidence;
    const r = placeStop(bo["close"]!, bo["atr"]!, sig.find((s) => s.kind === "FVG_SUPPORT")?.evidence["fvgBottom"], S);
    expect(r.ok && r.stop).toBeCloseTo(Number(set.manifest.event["stop"]), 8); // ATR seed trace ≈ 1e-9, see fixtures README
  });
});

const prices = { BTC: 100_000, NEAR: 2 };
const base = (over: Partial<SizingInput> = {}): SizingInput => ({
  asset: "NEAR", pRef: 2, stop: 1.95, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, prices, positions: [], feeBufferPct: 0.45, ...over,
});
const pos = (asset: Position["asset"], quantity: number): Position => ({
  asset, quantity, entryPrice: prices[asset], entryBarTime: 0, initialStop: 0, stopPrice: 0, takeProfit: [0, 0], tp1Hit: false, highestCloseSinceEntry: 0,
});
const check = (r: ReturnType<typeof sizePosition>, name: string) => r.checks.find((c) => c.name === name);

describe("sizePosition (RISK_ENGINE.md §5.3)", () => {
  it("risks exactly 1% of equity when no cap binds", () => {
    const r = sizePosition(base({ stop: 1.8 }), S); // R = $10, dist 0.2 → 50 NEAR = $100
    expect(r).toMatchObject({ ok: true, equityUsd: 1000 });
    expect(r.ok && r.riskUsd).toBeCloseTo(10, 9);
    expect(r.ok && r.notionalUsd).toBeCloseTo(100, 9);
  });

  it("caps at 25% of equity per position", () => {
    const r = sizePosition(base(), S); // full risk: $10 / 0.05 × 2 = $400 → $250
    expect(r.ok && r.notionalUsd).toBeCloseTo(250, 9);
    expect(check(r, "cap_position")?.detail).toBe("binding");
    expect(r.ok && r.riskUsd).toBeLessThan(10);
  });

  it("caps at the remaining total exposure (50% of equity)", () => {
    // $600 USDC + 0.004 BTC ($400) = $1000 equity, $400 already exposed → $100 left
    const r = sizePosition(base({ balances: { USDC: 600, BTC: 0.004, NEAR: 0 }, positions: [pos("BTC", 0.004)] }), S);
    expect(r.ok && r.notionalUsd).toBeCloseTo(100, 9);
    expect(check(r, "cap_exposure")?.detail).toBe("binding");
  });

  it("caps at free USDC minus the fee buffer", () => {
    // equity $1000 but only $60 USDC free (BTC held outside any tracked position)
    const r = sizePosition(base({ balances: { USDC: 60, BTC: 0.0094, NEAR: 0 } }), S);
    expect(r.ok && r.notionalUsd).toBeCloseTo(60 * (1 - 0.0045), 9);
    expect(check(r, "cap_free_usdc")?.detail).toBe("binding");
  });

  it("applies the on-chain cap, then the LLM multiplier", () => {
    const r = sizePosition(base({ onChainCapUsd: 80, llmMultiplier: 0.5 }), S);
    expect(r.ok && r.notionalUsd).toBeCloseTo(40, 9);
    expect(r.checks.map((c) => c.name)).toEqual(["risk_budget", "cap_position", "cap_exposure", "cap_free_usdc", "cap_onchain", "llm_multiplier", "min_notional"]);
  });

  it("an LLM reject (× 0) is LLM_VETO, not a size problem (§8)", () => {
    expect(sizePosition(base({ llmMultiplier: 0 }), S)).toMatchObject({ ok: false, reason: "LLM_VETO" });
  });

  it("rejects below $10 with BELOW_MIN_NOTIONAL", () => {
    expect(sizePosition(base({ onChainCapUsd: 9.99 }), S)).toMatchObject({ ok: false, reason: "BELOW_MIN_NOTIONAL" });
    expect(sizePosition(base({ onChainCapUsd: 19.98, llmMultiplier: 0.5 }), S)).toMatchObject({ ok: false, reason: "BELOW_MIN_NOTIONAL" });
    expect(sizePosition(base({ onChainCapUsd: 10 }), S).ok).toBe(true);
  });

  it("an over-exposed portfolio leaves no room rather than a negative size", () => {
    const r = sizePosition(base({ balances: { USDC: 300, BTC: 0.007, NEAR: 0 }, positions: [pos("BTC", 0.007)] }), S);
    expect(r).toMatchObject({ ok: false, reason: "BELOW_MIN_NOTIONAL" });
    expect(check(r, "cap_exposure")?.limit).toBe(0);
  });

  it("equity counts every balance at its last close", () => {
    expect(equityUsd({ USDC: 100, BTC: 0.001, NEAR: 50 }, prices)).toBe(300);
  });

  it("property: risk ≤ 1% of equity, position ≤ 25%, exposure ≤ 50%, never more than free USDC", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e6, noNaN: true }), // USDC
        fc.double({ min: 0, max: 5, noNaN: true }), // BTC held
        fc.double({ min: 0, max: 1e5, noNaN: true }), // NEAR held
        fc.double({ min: 0.01, max: 1e5, noNaN: true }), // P_ref
        fc.double({ min: 1e-4, max: 0.99, noNaN: true }), // stop distance as a fraction of P_ref
        fc.boolean(), // the held BTC is a tracked position
        fc.constantFrom<1 | 0.5 | 0>(1, 0.5, 0),
        (usdc, btc, near, pRef, d, tracked, llm) => {
          const px = { BTC: 100_000, NEAR: pRef };
          const positions = tracked && btc > 0 ? [pos("BTC", btc)] : [];
          const r = sizePosition({ asset: "NEAR", pRef, stop: pRef * (1 - d), balances: { USDC: usdc, BTC: btc, NEAR: near }, prices: px, positions, feeBufferPct: 0.45, llmMultiplier: llm }, S);
          if (!r.ok) return;
          const eq = r.equityUsd;
          const tol = 1e-9 * Math.max(1, eq);
          const exposureBefore = positions.reduce((s, p) => s + p.quantity * px[p.asset], 0);
          expect(r.riskUsd).toBeLessThanOrEqual(0.01 * eq + tol);
          expect(r.notionalUsd).toBeLessThanOrEqual(0.25 * eq + tol);
          expect(r.notionalUsd).toBeLessThanOrEqual(Math.max(0, 0.5 * eq - exposureBefore) + tol);
          expect(r.notionalUsd).toBeLessThanOrEqual(usdc + tol);
          expect(r.notionalUsd).toBeGreaterThanOrEqual(10);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("targets (RISK_ENGINE.md §5.4)", () => {
  it("TP1 at 1.5 R, TP2 at 3 R", () => {
    const [tp1, tp2] = targets(10, 9.8, cfg.exits);
    expect(tp1).toBeCloseTo(10.3, 12);
    expect(tp2).toBeCloseTo(10.6, 12);
  });
});

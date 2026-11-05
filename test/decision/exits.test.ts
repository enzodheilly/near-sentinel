import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { barsHeld, manageExit } from "../../src/decision/exits.ts";
import { targets } from "../../src/decision/sizing.ts";
import { atr } from "../../src/signals/indicators/atr.ts";
import type { Candle, Position } from "../../src/types.ts";

const X = cfg.exits; // tp1R 1.5, tp1Fraction 0.5, trailAtr 2, tp2R 3, timeStopBars 48
const H = 3_600_000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const bar = (n: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: T0 + n * H, open: o, high: h, low: l, close: c, volume: 1 });

// Entry 10, stop 9 → R 1, TP1 11.5, TP2 13.
const open: Position = {
  asset: "NEAR", quantity: 100, entryPrice: 10, entryBarTime: T0, initialStop: 9, stopPrice: 9,
  takeProfit: targets(10, 9, X), tp1Hit: false, highestCloseSinceEntry: 10,
};
const afterTp1: Position = { ...open, quantity: 50, tp1Hit: true, stopPrice: 10, highestCloseSinceEntry: 11.6 };

describe("manageExit (RISK_ENGINE.md §5.4)", () => {
  it("nothing happens inside the range; the highest close is tracked", () => {
    const r = manageExit(open, bar(1, 10, 10.6, 9.6, 10.5), 0.3, X);
    expect(r.exits).toEqual([]);
    expect(r.position).toMatchObject({ quantity: 100, stopPrice: 9, highestCloseSinceEntry: 10.5 });
  });

  it("STOP: low touches the stop → everything sold at the stop", () => {
    const r = manageExit(open, bar(1, 9.8, 9.9, 9, 9.2), 0.3, X);
    expect(r.position).toBeNull();
    expect(r.exits).toEqual([{ kind: "EXIT", asset: "NEAR", barTime: T0 + H, reason: "STOP", referencePrice: 9, quantity: 100, fraction: 1 }]);
  });

  it("STOP on a gap down fills at the open, not at the stop", () => {
    expect(manageExit(open, bar(1, 8.5, 8.8, 8.2, 8.6), 0.3, X).exits[0]).toMatchObject({ reason: "STOP", referencePrice: 8.5 });
  });

  it("stop first when a bar touches both the stop and TP1 (conservative)", () => {
    const r = manageExit(open, bar(1, 10, 11.6, 8.9, 10), 0.3, X);
    expect(r.exits.map((e) => e.reason)).toEqual(["STOP"]);
  });

  it("TAKE_PROFIT_1: sells 50% at TP1 and raises the stop to breakeven", () => {
    const r = manageExit(open, bar(3, 11, 11.6, 10.9, 11.4), 0.3, X);
    expect(r.exits).toEqual([{ kind: "EXIT", asset: "NEAR", barTime: T0 + 3 * H, reason: "TAKE_PROFIT_1", referencePrice: 11.5, quantity: 50, fraction: 0.5 }]);
    expect(r.position).toMatchObject({ quantity: 50, tp1Hit: true });
    expect(r.position!.stopPrice).toBeGreaterThanOrEqual(10);
  });

  it("TP1 on a gap up fills at the open", () => {
    expect(manageExit(open, bar(1, 11.8, 12, 11.7, 11.9), 0.3, X).exits[0]).toMatchObject({ reason: "TAKE_PROFIT_1", referencePrice: 11.8 });
  });

  it("a stop raised on this bar applies from the next one", () => {
    // TP1 bar dips to 9.95, below the new breakeven stop, but it was 9 when the bar started.
    const r = manageExit(open, bar(1, 10.1, 11.6, 9.95, 11.2), 0.3, X);
    expect(r.exits.map((e) => e.reason)).toEqual(["TAKE_PROFIT_1"]);
    // …where the stop is breakeven raised by the chandelier on the TP1 bar: 11.2 − 2 × 0.3 = 10.6
    const next = manageExit(r.position!, bar(2, 11, 11.1, 9.9, 10), 0.3, X).exits[0]!;
    expect(next.reason).toBe("STOP");
    expect(next.referencePrice).toBeCloseTo(10.6, 12);
  });

  it("TP1 and TP2 on the same bar → two exits, position closed", () => {
    const r = manageExit(open, bar(1, 10, 13.2, 9.9, 13), 0.3, X);
    expect(r.exits.map((e) => [e.reason, e.referencePrice, e.quantity, e.fraction])).toEqual([
      ["TAKE_PROFIT_1", 11.5, 50, 0.5],
      ["TAKE_PROFIT_2", 13, 50, 1],
    ]);
    expect(r.position).toBeNull();
  });

  it("TAKE_PROFIT_2 sells the remainder at 3R", () => {
    const r = manageExit(afterTp1, bar(10, 12.5, 13.1, 12.4, 12.9), 0.3, X);
    expect(r.exits).toEqual([{ kind: "EXIT", asset: "NEAR", barTime: T0 + 10 * H, reason: "TAKE_PROFIT_2", referencePrice: 13, quantity: 50, fraction: 1 }]);
    expect(r.position).toBeNull();
  });

  it("chandelier trailing after TP1: highest close − 2 ATR, ratcheted up", () => {
    const r = manageExit(afterTp1, bar(10, 12, 12.4, 11.9, 12.3), 0.3, X);
    expect(r.position!.stopPrice).toBeCloseTo(12.3 - 0.6, 12);
    // a lower close and a bigger ATR would put the chandelier lower: the stop stays
    const r2 = manageExit(r.position!, bar(11, 12.2, 12.25, 11.8, 11.9), 0.5, X);
    expect(r2.position!.stopPrice).toBeCloseTo(11.7, 12);
    // trailing stop hit
    const hit = manageExit(r2.position!, bar(12, 11.8, 11.85, 11.6, 11.65), 0.3, X).exits[0]!;
    expect(hit).toMatchObject({ reason: "STOP", quantity: 50 });
    expect(hit.referencePrice).toBeCloseTo(11.7, 12);
  });

  it("no trailing before TP1", () => {
    const r = manageExit(open, bar(5, 11, 11.4, 10.9, 11.3), 0.3, X); // chandelier would be 10.7
    expect(r.position!.stopPrice).toBe(9);
  });

  it("TIME_STOP at the close after 48 bars without TP1; not at 47", () => {
    expect(manageExit(open, bar(47, 10.2, 10.4, 10, 10.3), 0.3, X).exits).toEqual([]);
    const r = manageExit(open, bar(48, 10.2, 10.4, 10, 10.3), 0.3, X);
    expect(r.exits).toEqual([{ kind: "EXIT", asset: "NEAR", barTime: T0 + 48 * H, reason: "TIME_STOP", referencePrice: 10.3, quantity: 100, fraction: 1 }]);
    expect(r.position).toBeNull();
  });

  it("no time stop once TP1 has been hit: the trailing stop takes over", () => {
    expect(manageExit(afterTp1, bar(60, 11.8, 12, 11.7, 11.9), 0.3, X).exits).toEqual([]);
  });

  it("a closed position produces nothing", () => {
    expect(manageExit({ ...open, quantity: 0 }, bar(1, 8, 8, 8, 8), 0.3, X)).toEqual({ position: null, exits: [] });
  });

  it("barsHeld counts 1h bars from the entry bar", () => {
    expect(barsHeld(open, bar(17, 1, 1, 1, 1))).toBe(17);
  });

  it("property: the stop never moves down and sold quantities add up to the position", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.double({ min: -0.04, max: 0.04, noNaN: true }), fc.double({ min: 0, max: 0.03, noNaN: true }), fc.double({ min: 0.05, max: 1, noNaN: true })), { minLength: 1, maxLength: 80 }),
        (moves) => {
          let p: Position | null = open;
          let price = 10;
          let sold = 0;
          for (let i = 0; p && i < moves.length; i++) {
            const [ret, wick, a] = moves[i]!;
            const o = price;
            price = Math.max(0.01, price * (1 + ret));
            const r = manageExit(p, bar(i + 1, o, Math.max(o, price) * (1 + wick), Math.min(o, price) * (1 - wick), price), a, X);
            sold += r.exits.reduce((s, e) => s + e.quantity, 0);
            for (const e of r.exits) expect(e.fraction).toBeGreaterThan(0), expect(e.fraction).toBeLessThanOrEqual(1);
            if (r.position) expect(r.position.stopPrice).toBeGreaterThanOrEqual(p.stopPrice);
            p = r.position;
          }
          expect(sold + (p?.quantity ?? 0)).toBeCloseTo(100, 9);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("manageExit on demo-entry", () => {
  it("replays the frozen outcome: TP1 after 3 bars, TP2 after 17, +2.25 R", async () => {
    const set = await loadFixtureSet(new URL("../../fixtures/demo-entry/", import.meta.url).pathname);
    const c = set.series["NEARUSDT"]!["1h"]!.candles;
    const A = atr(c, cfg.indicators.atr);
    const entry = c[200]!.close;
    const stop = 1.9103765940117474; // placeStop on this bar (sizing test)
    let p: Position | null = { ...open, quantity: 100, entryPrice: entry, entryBarTime: c[200]!.openTime, initialStop: stop, stopPrice: stop, takeProfit: targets(entry, stop, X), highestCloseSinceEntry: entry };
    const log: [string, number][] = [];
    let r = 0;
    for (let t = 201; p && t < c.length; t++) {
      const step = manageExit(p, c[t]!, A[t]!, X);
      for (const e of step.exits) {
        log.push([e.reason, t - 200]);
        r += (e.quantity / 100) * ((e.referencePrice - entry) / (entry - stop));
      }
      p = step.position;
    }
    const sim = set.manifest.event["sim"] as { exit: string; barsHeld: number; resultR: number };
    expect(log).toEqual([["TAKE_PROFIT_1", 3], ["TAKE_PROFIT_2", sim.barsHeld]]);
    expect(sim.exit).toBe("TP2");
    expect(r).toBeCloseTo(sim.resultR, 9);
  });
});

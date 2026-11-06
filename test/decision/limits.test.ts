import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { evaluateConvergence } from "../../src/decision/convergence.ts";
import { manageExit } from "../../src/decision/exits.ts";
import {
  applyKillSwitch, entryGate, recordEntry, resetKillSwitch, rollPortfolio, startCooldown, utcDay, type SeriesFreshness,
} from "../../src/decision/limits.ts";
import type { Candle, PortfolioSnapshot, Position, Signal } from "../../src/types.ts";

const L = cfg.limits; // dailyLossPct 3, maxDrawdownPct 10, maxEntriesPerDay 6, cooldownBars 3, staleBars 1.5
const H = 3_600_000;
const DAY = 24 * H;
const D0 = Date.parse("2026-11-06T00:00:00Z");
const pos = (asset: Position["asset"], quantity: number): Position => ({
  asset, quantity, entryPrice: 2, entryBarTime: D0, initialStop: 1.9, stopPrice: 1.9, takeProfit: [2.15, 2.3], tp1Hit: false, highestCloseSinceEntry: 2,
});
const snap = (over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  at: D0 + 10 * H, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000, peakEquityUsd: 1000,
  dayStartEquityUsd: 1000, entriesToday: 0, cooldownUntil: {}, killSwitch: false, ...over,
});
const now = D0 + 10 * H + 60_000; // just after the close of the 09:00 bar
const fresh: SeriesFreshness[] = [
  { name: "NEAR 1h", interval: "1h", lastOpenTime: D0 + 9 * H },
  { name: "BTC 4h", interval: "4h", lastOpenTime: D0 + 4 * H },
];

describe("entryGate (RISK_ENGINE.md §6)", () => {
  it("allows entries when every rule passes", () => {
    expect(entryGate(snap(), fresh, now, L)).toMatchObject({ ok: true });
  });

  it("DAILY_LOSS_LIMIT at −3% of start-of-day equity (inclusive), not at −2.99%", () => {
    expect(entryGate(snap({ equityUsd: 970 }), fresh, now, L)).toMatchObject({ ok: false, reason: "DAILY_LOSS_LIMIT" });
    expect(entryGate(snap({ equityUsd: 970.1 }), fresh, now, L).ok).toBe(true);
  });

  it("MAX_TRADES_PER_DAY after 6 entries", () => {
    expect(entryGate(snap({ entriesToday: 5 }), fresh, now, L).ok).toBe(true);
    expect(entryGate(snap({ entriesToday: 6 }), fresh, now, L)).toMatchObject({ ok: false, reason: "MAX_TRADES_PER_DAY" });
  });

  it("STALE_DATA when a series' last candle ended more than 1.5 bars ago, naming it", () => {
    const late = now + 1.5 * H + 60_000; // NEAR 1h last closed at 10:00 → 1.5 h + 2 min ago
    const r = entryGate(snap(), fresh, late, L);
    expect(r).toMatchObject({ ok: false, reason: "STALE_DATA" });
    expect(r.checks.find((c) => c.name === "fresh_data")?.detail).toBe("NEAR 1h");
    expect(entryGate(snap(), fresh, D0 + 10 * H + 1.5 * H, L).ok).toBe(true); // exactly 1.5 bars: still fresh
    expect(entryGate(snap(), [{ name: "NEAR 1h", interval: "1h", lastOpenTime: undefined }], now, L)).toMatchObject({ reason: "STALE_DATA" });
  });

  it("KILL_SWITCH blocks first, and every rule is still reported", () => {
    const r = entryGate(snap({ killSwitch: true, equityUsd: 900, entriesToday: 6 }), fresh, now + 10 * H, L);
    expect(r).toMatchObject({ ok: false, reason: "KILL_SWITCH" });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["kill_switch", false], ["fresh_data", false], ["daily_loss", false], ["entries_today", false]]);
  });
});

describe("day roll at 00:00 UTC", () => {
  it("resets start-of-day equity and the entry count on the first tick of a new UTC day", () => {
    const evening = snap({ at: D0 + 23 * H + 1000, equityUsd: 960, entriesToday: 6 });
    expect(entryGate(evening, fresh, evening.at, L).ok).toBe(false);
    const sameDay = rollPortfolio(evening, D0 + DAY - 1, 955);
    expect(sameDay).toMatchObject({ dayStartEquityUsd: 1000, entriesToday: 6 });
    const midnight = rollPortfolio(sameDay, D0 + DAY, 955);
    expect(midnight).toMatchObject({ dayStartEquityUsd: 955, entriesToday: 0, equityUsd: 955, at: D0 + DAY });
    const f: SeriesFreshness[] = [{ name: "NEAR 1h", interval: "1h", lastOpenTime: D0 + 23 * H }];
    expect(entryGate(midnight, f, D0 + DAY + 1000, L).ok).toBe(true);
  });

  it("tracks the peak", () => {
    expect(rollPortfolio(snap(), now, 1100).peakEquityUsd).toBe(1100);
    expect(rollPortfolio(snap({ peakEquityUsd: 1200 }), now, 1100).peakEquityUsd).toBe(1200);
    expect(() => rollPortfolio(snap(), now, Number.NaN)).toThrow(RangeError);
  });

  it("utcDay floors to midnight UTC", () => {
    expect(utcDay(D0 + 23 * H + 59 * 60_000)).toBe(D0);
    expect(utcDay(D0 + DAY)).toBe(D0 + DAY);
  });
});

describe("kill switch (max drawdown)", () => {
  const prices = { BTC: 100_000, NEAR: 1.8 };

  it("trips at equity ≤ 90% of peak: closes every open position and asks to pause", () => {
    const p = snap({ equityUsd: 900, peakEquityUsd: 1000, positions: [pos("NEAR", 50), pos("BTC", 0.001), pos("NEAR", 0)] });
    const r = applyKillSwitch(p, D0 + 9 * H, prices, L);
    expect(r.tripped).toBe(true);
    expect(r.portfolio.killSwitch).toBe(true);
    expect(r.exits).toEqual([
      { kind: "EXIT", asset: "NEAR", barTime: D0 + 9 * H, reason: "KILL_SWITCH", referencePrice: 1.8, quantity: 50, fraction: 1 },
      { kind: "EXIT", asset: "BTC", barTime: D0 + 9 * H, reason: "KILL_SWITCH", referencePrice: 100_000, quantity: 0.001, fraction: 1 },
    ]);
    expect(r.check).toMatchObject({ name: "max_drawdown", ok: false, limit: 10 });
    expect(r.check.value).toBeCloseTo(10, 9);
  });

  it("does not trip at 90.01% of peak", () => {
    expect(applyKillSwitch(snap({ equityUsd: 900.1 }), D0, prices, L)).toMatchObject({ tripped: false, exits: [] });
  });

  it("trips once: later ticks keep it on without new exits", () => {
    const tripped = applyKillSwitch(snap({ equityUsd: 850, positions: [pos("NEAR", 5)] }), D0, prices, L).portfolio;
    const again = applyKillSwitch({ ...tripped, positions: [] }, D0 + H, prices, L);
    expect(again).toMatchObject({ tripped: false, exits: [] });
    expect(again.portfolio.killSwitch).toBe(true);
    expect(again.check.ok).toBe(false);
  });

  it("never resets automatically: not by a new day, a recovery, or many ticks", () => {
    let p = applyKillSwitch(snap({ equityUsd: 880 }), D0, prices, L).portfolio;
    for (let k = 1; k <= 24 * 10; k++) p = applyKillSwitch(rollPortfolio(p, D0 + k * H, 2000), D0 + k * H, prices, L).portfolio;
    expect(p.killSwitch).toBe(true);
    expect(entryGate(p, [], p.at, L)).toMatchObject({ ok: false, reason: "KILL_SWITCH" });
  });

  it("only an explicit owner reset clears it, and restarts the peak at current equity", () => {
    const p = applyKillSwitch(snap({ equityUsd: 880 }), D0, prices, L).portfolio;
    const r = resetKillSwitch(p, { confirmedByOwner: true });
    expect(r).toMatchObject({ killSwitch: false, peakEquityUsd: 880 });
    expect(applyKillSwitch(r, D0 + H, prices, L).tripped).toBe(false); // no instant re-trip
    expect(() => resetKillSwitch(p, {} as never)).toThrow(/owner/);
  });

  it("property: once on, no sequence of equity values or days turns it off", () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 1, max: 1e6, noNaN: true }), { maxLength: 50 }), (eqs) => {
      let p: PortfolioSnapshot = { ...snap(), killSwitch: true };
      eqs.forEach((e, k) => { p = applyKillSwitch(rollPortfolio(p, D0 + k * 7 * H, e), D0 + k * 7 * H, prices, L).portfolio; });
      expect(p.killSwitch).toBe(true);
    }));
  });
});

describe("cooldown after a stop-out", () => {
  it("blocks the next 3 bars of that asset, not the 4th, nor other assets", () => {
    const stopBar = D0 + 9 * H;
    const p = startCooldown(snap(), "NEAR", stopBar, L);
    expect(p.cooldownUntil.NEAR).toBe(stopBar + 4 * H);
    const sig = (barTime: number, asset: Signal["asset"] = "NEAR"): Signal[] =>
      (["BB_BREAKOUT", "RSI_MOMENTUM", "FVG_SUPPORT"] as const).map((kind) => ({ kind, asset, barTime, direction: "bullish", strength: 1, evidence: {} }));
    for (const k of [1, 2, 3]) {
      expect(evaluateConvergence("NEAR", stopBar + k * H, sig(stopBar + k * H), p, cfg)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    }
    expect(evaluateConvergence("NEAR", stopBar + 4 * H, sig(stopBar + 4 * H), p, cfg).ok).toBe(true);
    expect(evaluateConvergence("BTC", stopBar + H, sig(stopBar + H, "BTC"), p, cfg).ok).toBe(true);
  });

  it("never shortens an existing cooldown", () => {
    const p = startCooldown(startCooldown(snap(), "NEAR", D0 + 9 * H, L), "NEAR", D0 + 2 * H, L);
    expect(p.cooldownUntil.NEAR).toBe(D0 + 13 * H);
  });
});

describe("exits are never blocked by any limit", () => {
  it("with every limit active, the exit machine still produces its exits", () => {
    const worst = snap({
      killSwitch: true, equityUsd: 800, dayStartEquityUsd: 1000, entriesToday: 99, cooldownUntil: { NEAR: D0 + 99 * H },
    });
    expect(entryGate(worst, [{ name: "NEAR 1h", interval: "1h", lastOpenTime: D0 - 10 * DAY }], now, L).ok).toBe(false);
    // the exit path does not take the portfolio at all: a stop is a stop, whatever the limits say
    const bar: Candle = { openTime: D0 + 10 * H, open: 1.95, high: 1.96, low: 1.85, close: 1.87, volume: 1 };
    const r = manageExit(pos("NEAR", 50), bar, 0.02, cfg.exits);
    expect(r.exits.map((e) => e.reason)).toEqual(["STOP"]);
    expect(recordEntry(worst).entriesToday).toBe(100); // bookkeeping only, no gate
  });
});

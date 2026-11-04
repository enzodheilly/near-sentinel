import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { evaluateConvergence } from "../../src/decision/convergence.ts";
import { computeSignals } from "../../src/signals/index.ts";
import type { PortfolioSnapshot, Position, Signal, SignalKind } from "../../src/types.ts";

const BAR = Date.parse("2026-07-20T09:00:00Z");
const H = 3_600_000;
const sig = (kind: SignalKind, direction: Signal["direction"] = "bullish", over: Partial<Signal> = {}): Signal => ({
  kind, asset: "NEAR", barTime: BAR, direction, strength: 1, evidence: {}, ...over,
});
const BO = sig("BB_BREAKOUT");
const RSI = sig("RSI_MOMENTUM");
const FVG = sig("FVG_SUPPORT");
const REG = sig("BTC_REGIME");
const flat: Pick<PortfolioSnapshot, "positions" | "cooldownUntil"> = { positions: [], cooldownUntil: {} };
const pos = (asset: Position["asset"], quantity = 10): Position => ({
  asset, quantity, entryPrice: 2, entryBarTime: BAR - 5 * H, initialStop: 1.9, stopPrice: 1.9, takeProfit: [2.15, 2.3], tp1Hit: false, highestCloseSinceEntry: 2,
});
const run = (signals: Signal[], portfolio = flat) => evaluateConvergence("NEAR", BAR, signals, portfolio, cfg);

describe("evaluateConvergence (RISK_ENGINE.md §4)", () => {
  it("accepts a breakout with 2 confirmations and no veto", () => {
    const r = run([BO, RSI, FVG]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.confirmations.map((s) => s.kind)).toEqual(["RSI_MOMENTUM", "FVG_SUPPORT"]);
  });

  it("NO_SIGNAL without a breakout, even with every confirmation", () => {
    expect(run([RSI, FVG, REG])).toMatchObject({ ok: false, reason: "NO_SIGNAL" });
  });

  it("INSUFFICIENT_CONFLUENCE with a single confirmation", () => {
    const r = run([BO, RSI]);
    expect(r).toMatchObject({ ok: false, reason: "INSUFFICIENT_CONFLUENCE" });
    expect(r.checks.find((c) => c.name === "confirmations")).toMatchObject({ value: 1, limit: 2, detail: "RSI_MOMENTUM" });
  });

  it("VETO_RSI_EXHAUSTION beats any number of confirmations", () => {
    expect(run([BO, RSI, FVG, REG, sig("RSI_EXHAUSTION", "veto")])).toMatchObject({ ok: false, reason: "VETO_RSI_EXHAUSTION" });
  });

  it("VETO_BTC_REGIME when the regime vetoes; a vetoing regime is not a confirmation", () => {
    const r = run([BO, RSI, FVG, sig("BTC_REGIME", "veto")]);
    expect(r).toMatchObject({ ok: false, reason: "VETO_BTC_REGIME" });
    expect(r.checks.find((c) => c.name === "confirmations")?.value).toBe(2);
  });

  it("POSITION_OPEN when a position in the same asset is open", () => {
    expect(run([BO, RSI, FVG], { ...flat, positions: [pos("NEAR")] })).toMatchObject({ ok: false, reason: "POSITION_OPEN" });
  });

  it("a position in another asset, or a fully closed one, does not block", () => {
    expect(run([BO, RSI, FVG], { ...flat, positions: [pos("BTC"), pos("NEAR", 0)] }).ok).toBe(true);
  });

  it("COOLDOWN until the first allowed bar, not on it", () => {
    expect(run([BO, RSI, FVG], { ...flat, cooldownUntil: { NEAR: BAR + H } })).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(run([BO, RSI, FVG], { ...flat, cooldownUntil: { NEAR: BAR } }).ok).toBe(true);
    expect(run([BO, RSI, FVG], { ...flat, cooldownUntil: { BTC: BAR + H } }).ok).toBe(true);
  });

  it("ignores signals of another asset or another bar", () => {
    const r = run([BO, RSI, sig("FVG_SUPPORT", "bullish", { asset: "BTC" }), sig("BTC_REGIME", "bullish", { barTime: BAR - H })]);
    expect(r).toMatchObject({ ok: false, reason: "INSUFFICIENT_CONFLUENCE" });
  });

  it("reports the first failure in the documented order and always returns every check", () => {
    const r = run([BO, sig("RSI_EXHAUSTION", "veto")], { positions: [pos("NEAR")], cooldownUntil: { NEAR: BAR + H } });
    expect(r).toMatchObject({ ok: false, reason: "POSITION_OPEN" });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["breakout", true],
      ["no_open_position", false],
      ["no_cooldown", false],
      ["no_rsi_exhaustion_veto", false],
      ["no_btc_regime_veto", true],
      ["confirmations", false],
    ]);
  });
});

describe("evaluateConvergence on the fixtures", () => {
  async function decide(name: "demo-entry" | "demo-refusal") {
    const set = await loadFixtureSet(new URL(`../../fixtures/${name}/`, import.meta.url).pathname);
    const w = {
      asset: set.asset,
      candles1h: set.series["NEARUSDT"]!["1h"]!.candles,
      btc1h: set.series["BTCUSDT"]!["1h"]!.candles,
      btc4h: set.series["BTCUSDT"]!["4h"]!.candles,
    };
    const t = w.candles1h.findIndex((c) => c.openTime === set.signalBarTime);
    return { set, r: evaluateConvergence(set.asset, set.signalBarTime, computeSignals(w, t, cfg), flat, cfg) };
  }

  it("demo-entry → entry allowed, 3 confirmations", async () => {
    const { set, r } = await decide("demo-entry");
    expect(set.expected.decision).toBe("ENTRY");
    expect(r.ok && r.confirmations.map((s) => s.kind)).toEqual(set.expected.confirmations);
  });

  it("demo-refusal → the manifest's reason (VETO_RSI_EXHAUSTION)", async () => {
    const { set, r } = await decide("demo-refusal");
    expect(r).toMatchObject({ ok: false, reason: set.expected.reason });
    expect(set.expected.reason).toBe("VETO_RSI_EXHAUSTION");
  });
});

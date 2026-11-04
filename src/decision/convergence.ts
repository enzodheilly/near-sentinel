/**
 * Entry convergence (RISK_ENGINE.md §4): may an entry be proposed for this asset on this bar?
 *
 * Every condition is always evaluated and returned as a CheckResult, so a record shows all of
 * them. When several fail, the reason reported is the first failing one in this order:
 *
 *   1. no BB_BREAKOUT            → NO_SIGNAL (a HOLD, not a rejection)
 *   2. position already open     → POSITION_OPEN
 *   3. cooldown active           → COOLDOWN
 *   4. RSI_EXHAUSTION veto       → VETO_RSI_EXHAUSTION
 *   5. bearish BTC_REGIME veto   → VETO_BTC_REGIME
 *   6. < minConfirmations        → INSUFFICIENT_CONFLUENCE
 */

import type { RiskConfig } from "../config/schema.ts";
import type { CheckResult, PortfolioSnapshot, RejectReason, Signal, SignalKind, TradableAsset } from "../types.ts";

const CONFIRMATIONS: readonly SignalKind[] = ["RSI_MOMENTUM", "FVG_SUPPORT", "BTC_REGIME"];

export type ConvergenceResult =
  | { readonly ok: true; readonly breakout: Signal; readonly confirmations: readonly Signal[]; readonly checks: readonly CheckResult[] }
  | { readonly ok: false; readonly reason: RejectReason | "NO_SIGNAL"; readonly checks: readonly CheckResult[] };

export function evaluateConvergence(
  asset: TradableAsset,
  barTime: number,
  signals: readonly Signal[],
  portfolio: Pick<PortfolioSnapshot, "positions" | "cooldownUntil">,
  cfg: Pick<RiskConfig, "convergence">,
): ConvergenceResult {
  const own = signals.filter((s) => s.asset === asset && s.barTime === barTime);
  const breakout = own.find((s) => s.kind === "BB_BREAKOUT");
  const confirmations = own.filter((s) => CONFIRMATIONS.includes(s.kind) && s.direction === "bullish");
  const vetoed = (kind: SignalKind) => own.some((s) => s.kind === kind && s.direction === "veto");
  const open = portfolio.positions.some((p) => p.asset === asset && p.quantity > 0);
  const until = portfolio.cooldownUntil[asset];
  const cooling = until !== undefined && barTime < until;

  const rules: readonly [RejectReason | "NO_SIGNAL", CheckResult][] = [
    ["NO_SIGNAL", { name: "breakout", ok: breakout !== undefined }],
    ["POSITION_OPEN", { name: "no_open_position", ok: !open }],
    ["COOLDOWN", cooling ? { name: "no_cooldown", ok: false, value: barTime, limit: until } : { name: "no_cooldown", ok: true }],
    ["VETO_RSI_EXHAUSTION", { name: "no_rsi_exhaustion_veto", ok: !vetoed("RSI_EXHAUSTION") }],
    ["VETO_BTC_REGIME", { name: "no_btc_regime_veto", ok: !vetoed("BTC_REGIME") }],
    [
      "INSUFFICIENT_CONFLUENCE",
      {
        name: "confirmations",
        ok: confirmations.length >= cfg.convergence.minConfirmations,
        value: confirmations.length,
        limit: cfg.convergence.minConfirmations,
        detail: confirmations.map((s) => s.kind).join(",") || "none",
      },
    ],
  ];
  const checks = rules.map(([, c]) => c);
  const failed = rules.find(([, c]) => !c.ok);
  if (failed) return { ok: false, reason: failed[0], checks };
  return { ok: true, breakout: breakout as Signal, confirmations, checks };
}

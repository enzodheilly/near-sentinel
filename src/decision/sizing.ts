/**
 * Stop placement and position sizing (RISK_ENGINE.md §5.2, §5.3).
 *
 * Stop:  stop_atr = P_ref − stopAtrMult × ATR;  stop_fvg = fvgBottom − stopFvgBufferAtr × ATR.
 *        stop = max(stop_atr, stop_fvg) when FVG_SUPPORT fired, else stop_atr.
 *        Distance < minStopAtr × ATR → stop moved down to P_ref − minStopAtr × ATR (no rejection).
 *        Distance > maxStopAtr × ATR → STOP_TOO_WIDE. (With the defaults, max(...) keeps the stop
 *        within 1.5 ATR, so this only triggers with a config where stopAtrMult > maxStopAtr.)
 *
 * Size:  R_usd = riskPerTradePct × equity; notional = R_usd / distance × P_ref; then capped, in
 *        order, by: position cap, remaining exposure, free USDC minus fee buffer, on-chain cap,
 *        LLM multiplier (× 0 → LLM_VETO). Caps only ever reduce. Final notional < minNotionalUsd →
 *        BELOW_MIN_NOTIONAL.
 *        Hence risk ≤ riskPerTradePct × equity, always.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { AssetSymbol, CheckResult, Position, TradableAsset } from "../types.ts";

type Sizing = RiskConfig["sizing"];

export type StopResult =
  | {
      readonly ok: true;
      readonly stop: number;
      readonly distance: number;
      readonly source: "ATR" | "FVG";
      readonly widened: boolean; // moved down to the minimum distance
      readonly checks: readonly CheckResult[];
    }
  | { readonly ok: false; readonly reason: "STOP_TOO_WIDE"; readonly checks: readonly CheckResult[] };

export function placeStop(pRef: number, atr: number, fvgBottom: number | undefined, cfg: Sizing): StopResult {
  if (!(pRef > 0) || !(atr > 0) || !Number.isFinite(pRef) || !Number.isFinite(atr)) {
    throw new RangeError(`placeStop: P_ref and ATR must be finite and > 0 (got ${pRef}, ${atr})`);
  }
  const stopAtr = pRef - cfg.stopAtrMult * atr;
  const stopFvg = fvgBottom === undefined ? -Infinity : fvgBottom - cfg.stopFvgBufferAtr * atr;
  const source = stopFvg > stopAtr ? "FVG" : "ATR";
  let stop = Math.max(stopAtr, stopFvg);
  const minDist = cfg.minStopAtr * atr;
  const widened = pRef - stop < minDist;
  if (widened) stop = pRef - minDist;
  const distance = pRef - stop;
  const checks: CheckResult[] = [
    { name: "stop_min_distance", ok: true, value: distance / atr, limit: cfg.minStopAtr, detail: widened ? "widened" : source },
    { name: "stop_max_distance", ok: distance <= cfg.maxStopAtr * atr, value: distance / atr, limit: cfg.maxStopAtr },
  ];
  if (!(distance <= cfg.maxStopAtr * atr)) return { ok: false, reason: "STOP_TOO_WIDE", checks };
  return { ok: true, stop, distance, source, widened, checks };
}

export interface SizingInput {
  readonly asset: TradableAsset;
  readonly pRef: number;
  readonly stop: number;
  readonly balances: Readonly<Record<AssetSymbol, number>>;
  /** Last close of each tradable asset, used for equity and exposure. */
  readonly prices: Readonly<Record<TradableAsset, number>>;
  readonly positions: readonly Position[];
  /** Share of free USDC kept aside for fees, in percent (e.g. 0.45). */
  readonly feeBufferPct: number;
  /** Tier 2 contract `max_amount_per_trade`, in USD. Absent on Tier 1. */
  readonly onChainCapUsd?: number;
  readonly llmMultiplier?: 1 | 0.5 | 0;
}

export type SizeResult =
  | {
      readonly ok: true;
      readonly quantity: number;
      readonly notionalUsd: number;
      readonly riskUsd: number;
      readonly equityUsd: number;
      readonly checks: readonly CheckResult[];
    }
  | { readonly ok: false; readonly reason: "BELOW_MIN_NOTIONAL" | "LLM_VETO"; readonly checks: readonly CheckResult[] };

/** equity = USDC + Σ asset balance × last close (§5.3). */
export function equityUsd(balances: Readonly<Record<AssetSymbol, number>>, prices: Readonly<Record<TradableAsset, number>>): number {
  return balances.USDC + balances.BTC * prices.BTC + balances.NEAR * prices.NEAR;
}

export function sizePosition(input: SizingInput, cfg: Sizing): SizeResult {
  const { pRef, stop } = input;
  const distance = pRef - stop;
  if (!(distance > 0) || !Number.isFinite(distance)) throw new RangeError(`sizePosition: stop ${stop} must be below P_ref ${pRef}`);

  const equity = equityUsd(input.balances, input.prices);
  const riskBudget = Math.max(0, (cfg.riskPerTradePct / 100) * equity);
  const exposure = input.positions.reduce((sum, p) => sum + p.quantity * input.prices[p.asset], 0);

  const caps: readonly [string, number][] = [
    ["cap_position", (cfg.maxPositionPct / 100) * equity],
    ["cap_exposure", (cfg.maxExposurePct / 100) * equity - exposure],
    ["cap_free_usdc", input.balances.USDC * (1 - input.feeBufferPct / 100)],
    ...(input.onChainCapUsd === undefined ? [] : ([["cap_onchain", input.onChainCapUsd]] as [string, number][])),
  ];

  let notional = (riskBudget / distance) * pRef;
  const checks: CheckResult[] = [{ name: "risk_budget", ok: true, value: notional, limit: riskBudget, detail: "notional at full risk" }];
  for (const [name, raw] of caps) {
    const cap = Math.max(0, raw);
    const binding = notional > cap;
    checks.push({ name, ok: true, value: notional, limit: cap, detail: binding ? "binding" : "not binding" });
    if (binding) notional = cap;
  }
  const mult = input.llmMultiplier ?? 1;
  checks.push({ name: "llm_multiplier", ok: mult > 0, value: mult, detail: mult < 1 ? "binding" : "not binding" });
  if (mult === 0) return { ok: false, reason: "LLM_VETO", checks }; // §8: an LLM reject is its own reason
  notional *= mult;

  const enough = notional >= cfg.minNotionalUsd;
  checks.push({ name: "min_notional", ok: enough, value: notional, limit: cfg.minNotionalUsd });
  if (!enough) return { ok: false, reason: "BELOW_MIN_NOTIONAL", checks };

  const quantity = notional / pRef;
  return { ok: true, quantity, notionalUsd: notional, riskUsd: quantity * distance, equityUsd: equity, checks };
}

/** TP1 and TP2 prices for a stop distance (§5.4): P + tp1R × R_dist, P + tp2R × R_dist. */
export function targets(price: number, stop: number, cfg: Pick<RiskConfig["exits"], "tp1R" | "tp2R">): readonly [number, number] {
  const r = price - stop;
  return [price + cfg.tp1R * r, price + cfg.tp2R * r];
}

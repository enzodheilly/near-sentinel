/**
 * Reward-to-cost filter (RISK_ENGINE.md §5.5).
 *
 *   cost_frac = 2 × fee_frac + entry_slippage_frac + exit_slippage_frac
 *   cost_px   = cost_frac × P_ref
 *   COST_TOO_HIGH if cost_px > maxCostFractionOfTarget × tp1R × R_dist   (equality passes)
 *
 * i.e. costs may eat at most a quarter of the distance to TP1. (Measuring against R_dist alone
 * refused most breakouts: a breakout follows a squeeze, when ATR and so R_dist are smallest.)
 *
 * fee_frac is feePctAuthenticated / 100 with a partner JWT, feePctUnauthenticated / 100 without.
 * Exit slippage is assumed equal to entry slippage. A favourable quote (negative measured slippage)
 * counts as zero: a good entry fill says nothing about the exit, so it may not shrink the estimate.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { CheckResult } from "../types.ts";

type Cfg = Pick<RiskConfig, "costs" | "exits">;

export interface CostInput {
  readonly pRef: number;
  readonly stop: number;
  /** Partner JWT present: the authenticated fee schedule applies. */
  readonly authenticated: boolean;
  /** (P_q − P_ref) / P_ref measured on the entry quote (§7.2), as a fraction. */
  readonly entrySlippageFrac: number;
}

export type CostResult =
  | { readonly ok: true; readonly costFrac: number; readonly costPx: number; readonly limitPx: number; readonly checks: readonly CheckResult[] }
  | { readonly ok: false; readonly reason: "COST_TOO_HIGH"; readonly costFrac: number; readonly costPx: number; readonly limitPx: number; readonly checks: readonly CheckResult[] };

export function feeFraction(authenticated: boolean, cfg: RiskConfig["costs"]): number {
  return (authenticated ? cfg.feePctAuthenticated : cfg.feePctUnauthenticated) / 100;
}

export function costFilter(input: CostInput, cfg: Cfg): CostResult {
  const { pRef, stop } = input;
  const rDist = pRef - stop;
  if (!(pRef > 0) || !(rDist > 0) || !Number.isFinite(rDist) || !Number.isFinite(input.entrySlippageFrac)) {
    throw new RangeError(`costFilter: need P_ref > stop > −∞ and a finite slippage (got ${pRef}, ${stop}, ${input.entrySlippageFrac})`);
  }
  const fee = feeFraction(input.authenticated, cfg.costs);
  const slip = Math.max(0, input.entrySlippageFrac);
  const costFrac = 2 * fee + 2 * slip;
  const costPx = costFrac * pRef;
  const targetPx = cfg.exits.tp1R * rDist;
  const limitPx = cfg.costs.maxCostFractionOfTarget * targetPx;
  const ok = costPx <= limitPx;
  const checks: CheckResult[] = [
    {
      name: "reward_to_cost",
      ok,
      value: costPx / targetPx, // share of the TP1 distance eaten by costs
      limit: cfg.costs.maxCostFractionOfTarget,
      detail: `fee ${(fee * 100).toFixed(2)}% ${input.authenticated ? "(partner JWT)" : "(no JWT)"}, slippage ${(slip * 100).toFixed(3)}% each way`,
    },
  ];
  return ok ? { ok, costFrac, costPx, limitPx, checks } : { ok, reason: "COST_TOO_HIGH", costFrac, costPx, limitPx, checks };
}

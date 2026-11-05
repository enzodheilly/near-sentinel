/**
 * Exit state machine (RISK_ENGINE.md §5.4), run once per closed 1h bar for each open position.
 *
 * Levels come from the fill: R_dist = entryPrice − initialStop, TP1 = entry + tp1R × R_dist,
 * TP2 = entry + tp2R × R_dist (stored on the position as `takeProfit`).
 *
 * Within one bar, intrabar order is unknown, so the evaluation is conservative and fixed:
 *  1. low ≤ stop                        → STOP, everything, at min(stop, open) (a gap fills at the open)
 *  2. TP1 not hit and high ≥ TP1        → TAKE_PROFIT_1, sell tp1Fraction, stop raised to breakeven
 *  3. TP1 hit and high ≥ TP2            → TAKE_PROFIT_2, the rest (TP1 and TP2 can both fill on one bar)
 *  4. close updates highestCloseSinceEntry; after TP1, the chandelier stop
 *     highestClose − trailAtr × ATR raises the stop (never lowers it). New stops apply from the next bar.
 *  5. TP1 not hit after timeStopBars bars → TIME_STOP, everything, at the close
 *
 * The stop only ever moves up. Exits never depend on the LLM or on portfolio limits.
 */

import type { RiskConfig } from "../config/schema.ts";
import { INTERVAL_MS, type Candle, type ExitProposal, type ExitReason, type Position } from "../types.ts";

type Exits = RiskConfig["exits"];

export interface ExitStep {
  /** The position after this bar, or null when it is fully closed. */
  readonly position: Position | null;
  readonly exits: readonly ExitProposal[];
}

/** Number of 1h bars since the entry bar (the bar right after entry is 1). */
export function barsHeld(p: Position, bar: Candle): number {
  return Math.round((bar.openTime - p.entryBarTime) / INTERVAL_MS["1h"]);
}

export function manageExit(p: Position, bar: Candle, atr: number, cfg: Exits): ExitStep {
  if (!(p.quantity > 0)) return { position: null, exits: [] };
  const exit = (reason: ExitReason, referencePrice: number, quantity: number, remaining: number): ExitProposal => ({
    kind: "EXIT",
    asset: p.asset,
    barTime: bar.openTime,
    reason,
    referencePrice,
    quantity,
    fraction: quantity / remaining,
  });
  const [tp1, tp2] = p.takeProfit;

  // 1. stop first
  if (bar.low <= p.stopPrice) {
    return { position: null, exits: [exit("STOP", Math.min(p.stopPrice, bar.open), p.quantity, p.quantity)] };
  }

  const exits: ExitProposal[] = [];
  let quantity = p.quantity;
  let stop = p.stopPrice;
  let tp1Hit = p.tp1Hit;

  // 2. first target
  if (!tp1Hit && bar.high >= tp1) {
    const sold = p.quantity * cfg.tp1Fraction;
    exits.push(exit("TAKE_PROFIT_1", Math.max(tp1, bar.open), sold, quantity));
    quantity -= sold;
    tp1Hit = true;
    stop = Math.max(stop, p.entryPrice);
  }

  // 3. hard target on the rest
  if (tp1Hit && bar.high >= tp2) {
    exits.push(exit("TAKE_PROFIT_2", Math.max(tp2, bar.open), quantity, quantity));
    return { position: null, exits };
  }

  // 4. trailing, from the next bar on
  const highest = Math.max(p.highestCloseSinceEntry, bar.close);
  if (tp1Hit && Number.isFinite(atr)) stop = Math.max(stop, highest - cfg.trailAtr * atr);

  // 5. time stop
  if (!tp1Hit && barsHeld(p, bar) >= cfg.timeStopBars) {
    return { position: null, exits: [exit("TIME_STOP", bar.close, quantity, quantity)] };
  }

  return { position: { ...p, quantity, stopPrice: stop, tp1Hit, highestCloseSinceEntry: highest }, exits };
}

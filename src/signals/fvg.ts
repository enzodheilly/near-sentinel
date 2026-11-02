/**
 * FVG_SUPPORT — an unfilled bullish fair value gap just under the price (RISK_ENGINE.md §3.4).
 *
 * A bullish gap is three bars (i − 2, i − 1, i) with low[i] > high[i − 2]; the zone is
 * [high[i − 2], low[i]]. It supports bar t when it is:
 *  - recent:      t − (maxAgeBars − 1) ≤ i ≤ t;
 *  - meaningful:  low[i] − high[i − 2] ≥ minSizeAtr × ATR[i];
 *  - unfilled:    no close of bars i + 1 … t is below high[i − 2];
 *  - near:        close[t] − maxDistanceAtr × ATR[t] ≤ low[i] ≤ close[t].
 * The most recent qualifying gap is reported; its bottom (fvgBottom) feeds the stop (§5.2).
 */

import type { RiskConfig } from "../config/schema.ts";
import type { Candle, Signal } from "../types.ts";
import { fin, makeSignal, type SeriesAt } from "./signal.ts";

type Cfg = Pick<RiskConfig["signals"], "fvg">;

export interface Gap {
  readonly i: number; // index of the third bar
  readonly bottom: number; // high[i − 2]
  readonly top: number; // low[i]
}

/** The most recent gap supporting bar t, or null. */
export function findSupportingGap(candles: readonly Candle[], atr: readonly number[], t: number, cfg: Cfg["fvg"]): Gap | null {
  const c = candles[t];
  const atrT = atr[t];
  if (!c || !fin(atrT)) return null;
  const nearFloor = c.close - cfg.maxDistanceAtr * atrT;

  for (let i = t; i >= Math.max(2, t - cfg.maxAgeBars + 1); i--) {
    const third = candles[i] as Candle;
    const first = candles[i - 2] as Candle;
    const atrI = atr[i];
    const bottom = first.high;
    const top = third.low;
    if (!(top > bottom) || !fin(atrI)) continue;
    if (top - bottom < cfg.minSizeAtr * atrI) continue;
    if (top < nearFloor || top > c.close) continue;
    let filled = false;
    for (let j = i + 1; j <= t; j++) {
      if ((candles[j] as Candle).close < bottom) {
        filled = true;
        break;
      }
    }
    if (!filled) return { i, bottom, top };
  }
  return null;
}

export function fvgSupport(s: SeriesAt, cfg: Cfg): Signal | null {
  const gap = findSupportingGap(s.candles, s.ind.atr, s.t, cfg.fvg);
  if (!gap) return null;
  return makeSignal(s, "FVG_SUPPORT", "bullish", 1, {
    fvgBottom: gap.bottom,
    fvgTop: gap.top,
    ageBars: s.t - gap.i,
    sizeAtr: (gap.top - gap.bottom) / (s.ind.atr[gap.i] as number),
  });
}

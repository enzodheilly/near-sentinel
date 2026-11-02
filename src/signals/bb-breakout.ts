/**
 * BB_BREAKOUT — the entry trigger (RISK_ENGINE.md §3.1).
 *
 * Fires on bar t when all three hold:
 *  1. Squeeze: for at least one j in t − recentBars … t − 1,
 *     BBW[j] ≤ nearest-rank percentile(p) of BBW[j − lookback … j − 1];
 *  2. Breakout: close[t] > upper[t];
 *  3. Body filter: close[t] − open[t] ≥ bodyRatio × (high[t] − low[t]).
 * Strength = min(1, (close[t] − upper[t]) / ATR[t]).
 *
 * Returns null when the rule does not fire, or when history is too short to evaluate it.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { Signal } from "../types.ts";
import { percentile } from "./indicators/percentile.ts";
import { fin, makeSignal, type SeriesAt } from "./signal.ts";

type Cfg = Pick<RiskConfig["signals"], "squeeze" | "breakoutBodyRatio">;

/** Most recent bar j in [t − recentBars, t − 1] that was in a squeeze, or −1. */
export function lastSqueezeBar(bbw: readonly number[], t: number, cfg: Cfg["squeeze"]): number {
  for (let j = t - 1; j >= t - cfg.recentBars; j--) {
    if (j - cfg.lookback < 0) return -1;
    const window = bbw.slice(j - cfg.lookback, j);
    const cur = bbw[j];
    if (!fin(cur) || !window.every(fin)) return -1; // still warming up
    if (cur <= percentile(window, cfg.percentile)) return j;
  }
  return -1;
}

export function bbBreakout(s: SeriesAt, cfg: Cfg): Signal | null {
  const { candles, ind, t } = s;
  const c = candles[t];
  const upper = ind.bb.upper[t];
  const atrT = ind.atr[t];
  if (!c || !fin(upper) || !fin(atrT)) return null;

  const j = lastSqueezeBar(ind.bb.bandwidth, t, cfg.squeeze);
  if (j < 0) return null;
  if (!(c.close > upper)) return null;
  const range = c.high - c.low;
  if (!(range > 0 && c.close - c.open >= cfg.breakoutBodyRatio * range)) return null;

  return makeSignal(s, "BB_BREAKOUT", "bullish", atrT > 0 ? (c.close - upper) / atrT : 1, {
    close: c.close,
    upper,
    atr: atrT,
    bodyRatio: (c.close - c.open) / range,
    squeezeBarsAgo: t - j,
  });
}

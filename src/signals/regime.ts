/**
 * BTC_REGIME — confirmation or veto from the BTC 4h trend (RISK_ENGINE.md §3.5).
 *
 * Regime: bullish if the close of the last BTC 4h candle *closed by the end of 1h bar t* is above
 * EMA(50) of 4h closes at that candle; bearish otherwise. A 4h candle still open at the end of bar t
 * is never read — not its close, not through the EMA.
 *
 * For NEAR the regime counts only when corr(48) ≥ 0.6 (Pearson of 1h log returns, aligned on
 * openTime): bullish → confirmation, bearish → veto. Below the threshold, or when the correlation
 * is undefined (NaN), the signal is absent. For BTC the correlation is 1 by definition, so the
 * same table gives: bullish → confirmation, bearish → veto.
 *
 * Returns null during warm-up: fewer than `warmupBars.regime` closed 4h candles, or a correlation
 * window that is not fully covered.
 */

import type { RiskConfig } from "../config/schema.ts";
import { INTERVAL_MS, type Candle, type Signal } from "../types.ts";
import { pearson } from "./indicators/correlation.ts";
import { ema } from "./indicators/ema.ts";
import { fin, makeSignal, type SeriesAt } from "./signal.ts";

type Cfg = Pick<RiskConfig, "indicators" | "signals" | "warmupBars">;

/** BTC series the regime reads, with the 4h EMA computed once. */
export interface RegimeContext {
  readonly btc1h: readonly Candle[];
  readonly btc4h: readonly Candle[];
  readonly btcEma4h: readonly number[];
}

export function regimeContext(btc1h: readonly Candle[], btc4h: readonly Candle[], cfg: Pick<RiskConfig, "indicators">): RegimeContext {
  return { btc1h, btc4h, btcEma4h: ema(btc4h.map((c) => c.close), cfg.indicators.regimeEma) };
}

/** Index of the last 4h candle with openTime + 4h ≤ closeTime, or −1. Assumes sorted candles. */
export function lastClosed4h(btc4h: readonly Candle[], closeTime: number): number {
  let lo = 0;
  let hi = btc4h.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((btc4h[mid] as Candle).openTime + INTERVAL_MS["4h"] <= closeTime) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export interface Trend {
  readonly regime: "bullish" | "bearish";
  readonly index: number; // into btc4h
  readonly close: number;
  readonly ema: number;
}

/** BTC 4h trend as of the close of the 1h bar opened at `barOpenTime`, or null during warm-up. */
export function btcTrend(ctx: RegimeContext, barOpenTime: number, cfg: Pick<RiskConfig, "warmupBars">): Trend | null {
  const r = lastClosed4h(ctx.btc4h, barOpenTime + INTERVAL_MS["1h"]);
  if (r < 0 || r + 1 < cfg.warmupBars.regime) return null;
  const e = ctx.btcEma4h[r];
  if (!fin(e)) return null;
  const close = (ctx.btc4h[r] as Candle).close;
  return { regime: close > e ? "bullish" : "bearish", index: r, close, ema: e };
}

/**
 * corr(n) of 1h log returns ending at bar t: returns of bars t − n + 1 … t, each paired with the BTC
 * bar of the same openTime. NaN when a BTC bar is missing or the correlation is undefined.
 */
export function corrAt(asset1h: readonly Candle[], btc1h: readonly Candle[], t: number, n: number): number {
  if (t - n < 0) return Number.NaN;
  const btcIdx = new Map<number, Candle>();
  const first = (asset1h[t - n] as Candle).openTime;
  const last = (asset1h[t] as Candle).openTime;
  for (const c of btc1h) if (c.openTime >= first && c.openTime <= last) btcIdx.set(c.openTime, c);
  const a: number[] = [];
  const b: number[] = [];
  for (let j = t - n + 1; j <= t; j++) {
    const x0 = asset1h[j - 1] as Candle;
    const x1 = asset1h[j] as Candle;
    const y0 = btcIdx.get(x0.openTime);
    const y1 = btcIdx.get(x1.openTime);
    if (!y0 || !y1) return Number.NaN;
    a.push(Math.log(x1.close / x0.close));
    b.push(Math.log(y1.close / y0.close));
  }
  return pearson(a, b);
}

export function btcRegime(s: SeriesAt, ctx: RegimeContext, cfg: Cfg): Signal | null {
  const bar = s.candles[s.t];
  if (!bar) return null;
  const trend = btcTrend(ctx, bar.openTime, cfg);
  if (!trend) return null;

  const corr = s.asset === "BTC" ? 1 : corrAt(s.candles, ctx.btc1h, s.t, cfg.indicators.corrWindow);
  if (!(corr >= cfg.signals.corrThreshold)) return null; // includes NaN: undefined counts as < 0.6

  return makeSignal(s, "BTC_REGIME", trend.regime === "bullish" ? "bullish" : "veto", 1, {
    btcClose4h: trend.close,
    ema4h: trend.ema,
    regime4hOpenTime: (ctx.btc4h[trend.index] as Candle).openTime,
    corr,
    corrThreshold: cfg.signals.corrThreshold,
  });
}

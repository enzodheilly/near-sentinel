/**
 * Signal engine: every signal of RISK_ENGINE.md §3 for one asset at 1h bar t.
 *
 * Warm-up (§2): bar t is evaluated only if t ≥ warmupBars.exec and at least warmupBars.regime
 * closed 4h candles precede its close; otherwise no signal at all.
 *
 * No look-ahead by construction: the inputs are cut to what is known at the close of bar t
 * (1h bars ≤ t, BTC 1h bars opened no later than bar t, 4h candles closed by its close) before any
 * indicator is computed. Appending future candles therefore cannot change the result.
 *
 * Output order is fixed: SIGNAL_KINDS order (breakout, RSI momentum, RSI exhaustion, FVG, regime).
 */

import type { RiskConfig } from "../config/schema.ts";
import { INTERVAL_MS, SIGNAL_KINDS, type Candle, type Signal, type TradableAsset } from "../types.ts";
import { bbBreakout } from "./bb-breakout.ts";
import { fvgSupport } from "./fvg.ts";
import { computeIndicators } from "./indicators/index.ts";
import { btcRegime, lastClosed4h, regimeContext } from "./regime.ts";
import { rsiExhaustion, rsiMomentum } from "./rsi-signals.ts";
import type { SeriesAt } from "./signal.ts";

export interface MarketWindow {
  readonly asset: TradableAsset;
  /** The asset's own 1h candles (for BTC, the same series as btc1h). */
  readonly candles1h: readonly Candle[];
  readonly btc1h: readonly Candle[];
  readonly btc4h: readonly Candle[];
}

const ORDER = new Map(SIGNAL_KINDS.map((k, i) => [k, i]));

export function computeSignals(w: MarketWindow, t: number, cfg: RiskConfig): Signal[] {
  if (!Number.isInteger(t) || t < cfg.warmupBars.exec || t >= w.candles1h.length) return [];
  const barOpen = (w.candles1h[t] as Candle).openTime;
  const barClose = barOpen + INTERVAL_MS["1h"];

  const btc4h = w.btc4h.slice(0, lastClosed4h(w.btc4h, barClose) + 1);
  if (btc4h.length < cfg.warmupBars.regime) return [];
  const candles = w.candles1h.slice(0, t + 1);
  const btc1h = w.btc1h.filter((c) => c.openTime <= barOpen);

  const s: SeriesAt = { asset: w.asset, candles, ind: computeIndicators(candles, cfg.indicators), t };
  const found = [
    bbBreakout(s, cfg.signals),
    rsiMomentum(s, cfg.signals),
    rsiExhaustion(s, cfg.signals),
    fvgSupport(s, cfg.signals),
    btcRegime(s, regimeContext(btc1h, btc4h, cfg), cfg),
  ].filter((x): x is Signal => x !== null);
  return found.sort((a, b) => (ORDER.get(a.kind) as number) - (ORDER.get(b.kind) as number));
}

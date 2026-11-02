/**
 * Shared input and constructor for signal functions (RISK_ENGINE.md §3).
 */

import type { Candle, Signal, SignalKind, TradableAsset } from "../types.ts";
import type { IndicatorSet } from "./indicators/index.ts";

/** One asset's 1h series and its indicators, evaluated at bar index `t`. */
export interface SeriesAt {
  readonly asset: TradableAsset;
  readonly candles: readonly Candle[];
  readonly ind: IndicatorSet;
  readonly t: number;
}

/** True when x is a finite number (i.e. the indicator is past its warm-up). */
export function fin(x: number | undefined): x is number {
  return x !== undefined && Number.isFinite(x);
}

export function makeSignal(
  s: SeriesAt,
  kind: SignalKind,
  direction: Signal["direction"],
  strength: number,
  evidence: Record<string, number>,
): Signal {
  for (const [k, v] of Object.entries(evidence)) {
    if (!Number.isFinite(v)) throw new RangeError(`${kind}: evidence "${k}" is not finite (${v})`);
  }
  const candle = s.candles[s.t];
  if (!candle) throw new RangeError(`${kind}: no candle at index ${s.t}`);
  return { kind, asset: s.asset, barTime: candle.openTime, direction, strength: Math.min(1, Math.max(0, strength)), evidence };
}

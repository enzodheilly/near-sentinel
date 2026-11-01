/**
 * Wilder's Average True Range (RISK_ENGINE.md §2).
 *
 * True range at i ≥ 1: max(high − low, |high − prevClose|, |low − prevClose|). It needs the previous
 * close, so it does not exist at index 0.
 * - Seed: simple average of true ranges 1…n, so the first value is at index n.
 * - Then Wilder smoothing: atr = (atr × (n − 1) + tr) / n.
 *
 * Returns an array aligned with `candles`; entries before index n are NaN.
 * Pure: the value at index i depends only on candles[0…i].
 */

import type { Candle } from "../../types.ts";
import { assertPeriod } from "./period.ts";

type Hlc = Pick<Candle, "high" | "low" | "close">;

/** True range of `c` given the previous candle's close. */
export function trueRange(c: Hlc, prevClose: number): number {
  return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
}

export function atr(candles: readonly Hlc[], n: number): number[] {
  assertPeriod("atr", n);
  const out = new Array<number>(candles.length).fill(Number.NaN);
  if (candles.length <= n) return out;

  const tr = (i: number) => trueRange(candles[i] as Hlc, (candles[i - 1] as Hlc).close);

  let value = 0;
  for (let i = 1; i <= n; i++) value += tr(i);
  value /= n;
  out[n] = value;

  for (let i = n + 1; i < candles.length; i++) {
    value = (value * (n - 1) + tr(i)) / n;
    out[i] = value;
  }
  return out;
}

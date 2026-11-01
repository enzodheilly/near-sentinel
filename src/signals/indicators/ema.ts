/**
 * Exponential moving average seeded with the simple average (RISK_ENGINE.md §2).
 *
 *   ema[n − 1] = SMA of values[0 … n − 1]
 *   ema[i]     = α × values[i] + (1 − α) × ema[i − 1],   α = 2 / (n + 1)
 *
 * Aligned with `values`; entries before index n − 1 are NaN. Pure and causal.
 */

import { assertPeriod } from "./period.ts";

export function ema(values: readonly number[], n: number): number[] {
  assertPeriod("ema", n);
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (values.length < n) return out;

  let e = 0;
  for (let i = 0; i < n; i++) e += values[i] as number;
  e /= n;
  out[n - 1] = e;

  const alpha = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    e = alpha * (values[i] as number) + (1 - alpha) * e;
    out[i] = e;
  }
  return out;
}

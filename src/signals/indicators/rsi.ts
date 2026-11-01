/**
 * Wilder's Relative Strength Index (RISK_ENGINE.md §2).
 *
 * - Seed: simple average of the gains and losses of changes 1…n, so the first value is at index n.
 * - Then Wilder smoothing: avg = (avg × (n − 1) + x) / n.
 * - No movement at all (both averages 0) gives 50; no loss gives 100.
 *
 * Returns an array aligned with `closes`; entries before index n are NaN (not enough history).
 * Pure: the value at index i depends only on closes[0…i].
 */

import { assertPeriod } from "./period.ts";

export function rsi(closes: readonly number[], n: number): number[] {
  assertPeriod("rsi", n);
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length <= n) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= n;
  avgLoss /= n;
  out[n] = rsiFromAverages(avgGain, avgLoss);

  for (let i = n + 1; i < closes.length; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

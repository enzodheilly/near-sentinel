/**
 * Bollinger bands (RISK_ENGINE.md §2).
 *
 *   middle = SMA(n) of close
 *   upper  = middle + k × σ,   lower = middle − k × σ,   σ = population standard deviation (÷ n)
 *   bbw    = (upper − lower) / middle                    (bandwidth, used by the squeeze rule §3.1)
 *
 * Arrays are aligned with `closes`; entries before index n − 1 are NaN.
 * Each window is computed directly (two passes), which avoids the drift of running sums.
 * Pure and causal: the value at index i depends only on closes[i − n + 1 … i].
 */

import { assertPeriod } from "./period.ts";

export interface BollingerBands {
  readonly middle: number[];
  readonly upper: number[];
  readonly lower: number[];
  readonly bandwidth: number[];
}

export function bollinger(closes: readonly number[], n: number, k: number): BollingerBands {
  assertPeriod("bollinger", n);
  if (!(Number.isFinite(k) && k > 0)) throw new RangeError(`bollinger: k must be > 0, got ${k}`);
  const len = closes.length;
  const middle = new Array<number>(len).fill(Number.NaN);
  const upper = new Array<number>(len).fill(Number.NaN);
  const lower = new Array<number>(len).fill(Number.NaN);
  const bandwidth = new Array<number>(len).fill(Number.NaN);

  for (let i = n - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += closes[j] as number;
    const mean = sum / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += ((closes[j] as number) - mean) ** 2;
    const sd = Math.sqrt(sq / n);
    middle[i] = mean;
    upper[i] = mean + k * sd;
    lower[i] = mean - k * sd;
    bandwidth[i] = mean === 0 ? Number.NaN : (2 * k * sd) / mean;
  }
  return { middle, upper, lower, bandwidth };
}

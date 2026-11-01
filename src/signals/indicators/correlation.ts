/**
 * Correlation helpers for the BTC regime filter (RISK_ENGINE.md §2, §3.5).
 */

/** Log returns: out[i − 1] = ln(prices[i] / prices[i − 1]). Length is prices.length − 1. */
export function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] as number;
    const cur = prices[i] as number;
    if (!(prev > 0 && cur > 0)) throw new RangeError(`logReturns: prices must be > 0 (index ${prev > 0 ? i : i - 1})`);
    out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Pearson correlation of two equal-length series.
 *
 * Returns NaN when it is undefined (fewer than 2 points, or a series with zero variance). Callers
 * must treat NaN as "not correlated": with the §3.5 rule `corr >= 0.6`, NaN compares false, so a
 * flat series can never trigger the regime filter.
 */
export function pearson(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError(`pearson: lengths differ (${a.length} vs ${b.length})`);
  const n = a.length;
  if (n < 2) return Number.NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  // Correlation is scale invariant, so deviations are normalised by their largest magnitude first.
  // Without this, tiny but non-constant series (|x| ~ 1e-160) square to 0 and look constant.
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa = Math.max(sa, Math.abs((a[i] as number) - ma));
    sb = Math.max(sb, Math.abs((b[i] as number) - mb));
  }
  if (sa === 0 || sb === 0) return Number.NaN; // a constant series: correlation is undefined
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ((a[i] as number) - ma) / sa;
    const db = ((b[i] as number) - mb) / sb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  // Clamp: rounding can push |r| a hair above 1.
  return Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb)));
}

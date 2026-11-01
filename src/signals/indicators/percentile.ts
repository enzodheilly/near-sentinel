/**
 * Nearest-rank percentile (RISK_ENGINE.md §3.1): sorted[floor(p × (len − 1))].
 *
 * The result is always one of the observed values, so it is exactly reproducible (no interpolation).
 * Inputs must be finite: a NaN in the window means the caller asked too early (warm-up), which is a
 * bug to surface, not a value to skip.
 */

export function percentile(values: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile: p must be in [0, 1], got ${p}`);
  if (values.length === 0) throw new RangeError("percentile: empty window");
  if (!values.every(Number.isFinite)) throw new RangeError("percentile: window contains a non-finite value");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))] as number;
}

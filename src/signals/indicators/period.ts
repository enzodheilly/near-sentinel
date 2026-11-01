/** Throws if `n` is not a usable indicator period (an integer >= 1). */
export function assertPeriod(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`${name}: period must be an integer >= 1, got ${n}`);
}

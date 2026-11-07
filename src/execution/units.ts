/** Human amounts ↔ base units (bigint). Shared by the replay and paper executors. */

/** 9 significant decimals, then scaled: exact enough for 24-decimal NEAR without float overflow of 10^24. */
export const toBase = (x: number, decimals: number): bigint => {
  const micro = BigInt(Math.round(x * 1e9));
  return decimals >= 9 ? micro * 10n ** BigInt(decimals - 9) : micro / 10n ** BigInt(9 - decimals);
};

export const toHuman = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

/**
 * Default risk configuration: the values of RISK_ENGINE.md §11, plus the pinned assets and model
 * chosen during the preparation spikes (P1, P2). Validated when this module loads.
 */

import { parseRiskConfig, type RiskConfig } from "./schema.ts";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const defaultRiskConfig: RiskConfig = deepFreeze(
  parseRiskConfig({
    assets: {
      // P1: nBTC quoted within 0.10% of the reference price; wBTC rejected (1.20%).
      BTC: { assetId: "nep141:nbtc.bridge.near", decimals: 8, marketSymbol: "BTCUSDT" },
      NEAR: { assetId: "nep141:wrap.near", decimals: 24, marketSymbol: "NEARUSDT" },
      // Native USDC on NEAR.
      USDC: { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
    },
    timeframes: { exec: "1h", regime: "4h" },
    warmupBars: { exec: 200, regime: 60 },
    indicators: { rsi: 14, atr: 14, bb: { n: 20, k: 2 }, regimeEma: 50, corrWindow: 48 },
    signals: {
      squeeze: { lookback: 120, percentile: 0.2, recentBars: 5 },
      breakoutBodyRatio: 0.5,
      rsiMomentum: [55, 75],
      rsiExhaustion: 80,
      fvg: { maxAgeBars: 24, minSizeAtr: 0.25, maxDistanceAtr: 1.5 },
      corrThreshold: 0.6,
    },
    convergence: { minConfirmations: 2 },
    sizing: {
      riskPerTradePct: 1.0,
      maxPositionPct: 25,
      maxExposurePct: 50,
      minNotionalUsd: 10,
      stopAtrMult: 1.5,
      stopFvgBufferAtr: 0.1,
      minStopAtr: 0.5,
      maxStopAtr: 3,
    },
    exits: { tp1R: 1.5, tp1Fraction: 0.5, trailAtr: 2, tp2R: 3, timeStopBars: 48 },
    costs: { feePctAuthenticated: 0.2, feePctUnauthenticated: 0.45, maxCostFractionOfR: 0.25 },
    limits: { dailyLossPct: 3, maxDrawdownPct: 10, maxEntriesPerDay: 6, cooldownBars: 3, staleBars: 1.5 },
    execution: {
      slippageBps: { entry: 50, exit: 150, exitRetry: 250 },
      priceDeviationPct: 1,
      quoteTtlSec: 30,
      deadlineSec: 120,
      watcherPollSec: 60,
    },
    // P2: provider_tee signatures and valid veto JSON on 10/10 runs, mean latency 3.68 s.
    llm: { model: "Qwen/Qwen3.6-35B-A3B-FP8", timeoutMs: 10_000, fallbackMultiplier: 0.5, maxRationaleChars: 400 },
  }),
);

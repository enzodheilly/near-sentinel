/**
 * Indicators computed once per candle series, shared by every signal (RISK_ENGINE.md §2).
 * All arrays are aligned with the candles; entries during warm-up are NaN.
 */

import type { RiskConfig } from "../../config/schema.ts";
import type { Candle } from "../../types.ts";
import { atr } from "./atr.ts";
import { bollinger, type BollingerBands } from "./bollinger.ts";
import { rsi } from "./rsi.ts";

export interface IndicatorSet {
  readonly rsi: readonly number[];
  readonly atr: readonly number[];
  readonly bb: BollingerBands;
}

export function computeIndicators(candles: readonly Candle[], cfg: RiskConfig["indicators"]): IndicatorSet {
  return {
    rsi: rsi(candles.map((c) => c.close), cfg.rsi),
    atr: atr(candles, cfg.atr),
    bb: bollinger(candles.map((c) => c.close), cfg.bb.n, cfg.bb.k),
  };
}

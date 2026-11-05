/**
 * Risk configuration schema (RISK_ENGINE.md §11).
 *
 * Every rule parameter of the agent lives here. The parsed config is hashed (`configHash`) into each
 * decision record, so a decision can always be traced to the exact rules that produced it.
 * Paths, keys and other operational settings are deliberately NOT part of this config: changing
 * them must not change the hash.
 */

import { z } from "zod";
import { hashCanonical } from "../lib/canonical.ts";

const pct = z.number().positive().max(100);
const positive = z.number().positive();
const positiveInt = z.number().int().positive();

const tradableAssetSpec = z.strictObject({
  /** 1Click / NEAR Intents asset id, e.g. "nep141:wrap.near". Pinned, never resolved by symbol. */
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /** Market symbol at the OHLCV source, e.g. "NEARUSDT". */
  marketSymbol: z.string().min(1),
});

const quoteAssetSpec = tradableAssetSpec.omit({ marketSymbol: true });

export const riskConfigSchema = z
  .strictObject({
    assets: z.strictObject({ BTC: tradableAssetSpec, NEAR: tradableAssetSpec, USDC: quoteAssetSpec }),
    timeframes: z.strictObject({ exec: z.literal("1h"), regime: z.literal("4h") }),
    warmupBars: z.strictObject({ exec: positiveInt, regime: positiveInt }),
    indicators: z.strictObject({
      rsi: positiveInt,
      atr: positiveInt,
      bb: z.strictObject({ n: z.number().int().min(2), k: positive }),
      regimeEma: positiveInt,
      corrWindow: z.number().int().min(3),
    }),
    signals: z.strictObject({
      squeeze: z.strictObject({
        lookback: z.number().int().min(2),
        percentile: z.number().gt(0).lt(1),
        recentBars: positiveInt,
      }),
      breakoutBodyRatio: z.number().gt(0).max(1),
      rsiMomentum: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]),
      rsiExhaustion: z.number().min(0).max(100),
      fvg: z.strictObject({ maxAgeBars: z.number().int().min(3), minSizeAtr: z.number().min(0), maxDistanceAtr: positive }),
      corrThreshold: z.number().min(-1).max(1),
    }),
    convergence: z.strictObject({ minConfirmations: z.number().int().min(1).max(3) }),
    sizing: z.strictObject({
      riskPerTradePct: z.number().positive().max(5),
      maxPositionPct: pct,
      maxExposurePct: pct,
      minNotionalUsd: positive,
      stopAtrMult: positive,
      stopFvgBufferAtr: z.number().min(0),
      minStopAtr: positive,
      maxStopAtr: positive,
    }),
    exits: z.strictObject({
      tp1R: positive,
      tp1Fraction: z.number().gt(0).lt(1),
      trailAtr: positive,
      tp2R: positive,
      timeStopBars: positiveInt,
    }),
    costs: z.strictObject({
      feePctAuthenticated: z.number().min(0).max(5),
      feePctUnauthenticated: z.number().min(0).max(5),
      maxCostFractionOfTarget: z.number().gt(0).max(1),
    }),
    limits: z.strictObject({
      dailyLossPct: pct,
      maxDrawdownPct: pct,
      maxEntriesPerDay: positiveInt,
      cooldownBars: z.number().int().min(0),
      staleBars: positive,
    }),
    execution: z.strictObject({
      slippageBps: z.strictObject({ entry: positiveInt, exit: positiveInt, exitRetry: positiveInt }),
      priceDeviationPct: pct,
      quoteTtlSec: positiveInt,
      deadlineSec: positiveInt,
      watcherPollSec: positiveInt,
    }),
    llm: z.strictObject({
      /** Canonical model id; sent with `x-no-aliasing: true` so provider_tee signatures match. */
      model: z.string().min(1),
      timeoutMs: positiveInt,
      /** Applied when the LLM fails. Can only reduce a trade, never keep it at full size. */
      fallbackMultiplier: z.union([z.literal(0.5), z.literal(0)]),
      maxRationaleChars: positiveInt,
    }),
  })
  // Cross-field rules: each one encodes an invariant of RISK_ENGINE.md.
  .refine((c) => c.signals.rsiMomentum[0] < c.signals.rsiMomentum[1], {
    path: ["signals", "rsiMomentum"],
    message: "RSI momentum band must be [low, high] with low < high",
  })
  .refine((c) => c.signals.rsiExhaustion > c.signals.rsiMomentum[1], {
    path: ["signals", "rsiExhaustion"],
    message: "RSI exhaustion veto must sit above the momentum band",
  })
  .refine((c) => c.sizing.minStopAtr <= c.sizing.stopAtrMult && c.sizing.stopAtrMult <= c.sizing.maxStopAtr, {
    path: ["sizing", "stopAtrMult"],
    message: "stop distance must satisfy minStopAtr <= stopAtrMult <= maxStopAtr",
  })
  .refine((c) => c.sizing.maxPositionPct <= c.sizing.maxExposurePct, {
    path: ["sizing", "maxPositionPct"],
    message: "a single position cannot exceed the total exposure cap",
  })
  .refine((c) => c.exits.tp1R < c.exits.tp2R, {
    path: ["exits", "tp1R"],
    message: "TP1 must come before TP2",
  })
  .refine((c) => c.costs.feePctAuthenticated <= c.costs.feePctUnauthenticated, {
    path: ["costs", "feePctUnauthenticated"],
    message: "unauthenticated fees cannot be lower than authenticated fees",
  })
  .refine(
    (c) => c.execution.slippageBps.entry <= c.execution.slippageBps.exit && c.execution.slippageBps.exit <= c.execution.slippageBps.exitRetry,
    { path: ["execution", "slippageBps"], message: "slippage tolerance must widen: entry <= exit <= exitRetry" },
  )
  .refine((c) => c.signals.squeeze.recentBars < c.signals.squeeze.lookback, {
    path: ["signals", "squeeze", "recentBars"],
    message: "squeeze recency window must be shorter than its lookback",
  });

export type RiskConfig = z.infer<typeof riskConfigSchema>;

/** Validates a config. Throws a ZodError listing every invalid field. */
export function parseRiskConfig(input: unknown): RiskConfig {
  return riskConfigSchema.parse(input);
}

/** SHA-256 of the canonical JSON of a validated config. Recorded in every DecisionRecord. */
export function configHash(config: RiskConfig): string {
  return hashCanonical(riskConfigSchema.parse(config));
}

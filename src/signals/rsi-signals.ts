/**
 * RSI_MOMENTUM (confirmation, RISK_ENGINE.md §3.2): low ≤ RSI[t] ≤ high — momentum, not exhausted.
 * RSI_EXHAUSTION (veto, §3.3): RSI[t] > exhaustion — blocks any new entry on this bar.
 *
 * Bounds are inclusive for the momentum band and strict for the veto, exactly as specified.
 * Both return null when the rule does not hold or RSI is still warming up.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { Signal } from "../types.ts";
import { fin, makeSignal, type SeriesAt } from "./signal.ts";

type Cfg = Pick<RiskConfig["signals"], "rsiMomentum" | "rsiExhaustion">;

export function rsiMomentum(s: SeriesAt, cfg: Cfg): Signal | null {
  const r = s.ind.rsi[s.t];
  const [low, high] = cfg.rsiMomentum;
  if (!fin(r) || r < low || r > high) return null;
  return makeSignal(s, "RSI_MOMENTUM", "bullish", 1, { rsi: r, low, high });
}

export function rsiExhaustion(s: SeriesAt, cfg: Cfg): Signal | null {
  const r = s.ind.rsi[s.t];
  if (!fin(r) || !(r > cfg.rsiExhaustion)) return null;
  return makeSignal(s, "RSI_EXHAUSTION", "veto", 1, { rsi: r, threshold: cfg.rsiExhaustion });
}

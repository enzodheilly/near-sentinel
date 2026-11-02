import { defaultRiskConfig } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { computeIndicators } from "../../src/signals/indicators/index.ts";
import type { SeriesAt } from "../../src/signals/signal.ts";
import type { Candle } from "../../src/types.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Candle builder: open/high/low/close at bar i. */
export const k = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: T0 + i * H, open: o, high: h, low: l, close: c, volume: 1 });

/** A quiet bar oscillating around `mid` with half-range `w`. */
export const quiet = (i: number, mid: number, w: number): Candle => {
  const c = mid + w * 0.5 * Math.sin(i * 1.7);
  const o = mid - w * 0.5 * Math.sin(i * 1.7);
  return k(i, o, Math.max(o, c) + w * 0.3, Math.min(o, c) - w * 0.3, c);
};

/** Wraps candles into the shape signal functions take, with default (or overridden) indicator periods. */
export function seriesAt(candles: Candle[], t: number, indicators = defaultRiskConfig.indicators): SeriesAt {
  return { asset: "NEAR", candles, ind: computeIndicators(candles, indicators), t };
}

/** The committed demo fixture's NEAR 1h series, evaluated at its signal bar. */
export async function fixtureAt(name: "demo-entry" | "demo-refusal"): Promise<SeriesAt> {
  const set = await loadFixtureSet(new URL(`../../fixtures/${name}/`, import.meta.url).pathname);
  const candles = set.series["NEARUSDT"]?.["1h"]?.candles;
  if (!candles) throw new Error(`${name}: no NEARUSDT 1h series`);
  const t = candles.findIndex((c) => c.openTime === set.signalBarTime);
  return { asset: "NEAR", candles: [...candles], ind: computeIndicators(candles, defaultRiskConfig.indicators), t };
}

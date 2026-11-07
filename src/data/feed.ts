/**
 * Live market feed for paper and live modes: the three series the engine reads (NEAR 1h, BTC 1h, BTC 4h),
 * closed candles only, checked for gaps and staleness, and archived so every decision can be verified later.
 *
 * - Gaps: a missing candle inside a window breaks the indicators. The series is cut after the last gap, so
 *   the engine sees a contiguous (shorter) history; with less than the warm-up it simply takes no entry.
 *   The gap is reported, never filled in.
 * - Staleness: a series whose last closed candle ended more than `cfg.limits.staleBars` (1.5) intervals ago is
 *   stale. The engine's limits gate refuses entries on it (STALE_DATA); the feed reports it too.
 * - Archive: the candles of each snapshot are merged into `<dir>/<SYMBOL>-<interval>.json` (atomic write), the
 *   source `verify` reads to recompute a paper or live decision. A candle that changes after it was archived
 *   is a data problem and is reported (the archived value is kept).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RiskConfig } from "../config/schema.ts";
import type { TickMarket } from "../decision/engine.ts";
import { INTERVAL_MS, type Candle, type Interval } from "../types.ts";
import type { BinanceClient } from "./binance.ts";

export interface SeriesSpec {
  readonly name: string; // "NEAR 1h"
  readonly symbol: string; // "NEARUSDT"
  readonly interval: Interval;
  readonly limit: number;
}

export const feedSeries = (cfg: RiskConfig): readonly SeriesSpec[] => [
  { name: "NEAR 1h", symbol: cfg.assets.NEAR.marketSymbol, interval: "1h", limit: 500 },
  { name: "BTC 1h", symbol: cfg.assets.BTC.marketSymbol, interval: "1h", limit: 500 },
  { name: "BTC 4h", symbol: cfg.assets.BTC.marketSymbol, interval: "4h", limit: 300 },
];

/** Open times missing between consecutive candles. */
export function findGaps(candles: readonly Candle[], interval: Interval): number[] {
  const step = INTERVAL_MS[interval];
  const gaps: number[] = [];
  for (let i = 1; i < candles.length; i++) for (let t = candles[i - 1]!.openTime + step; t < candles[i]!.openTime; t += step) gaps.push(t);
  return gaps;
}

/** The candles after the last gap (the contiguous tail). */
export function contiguousTail(candles: readonly Candle[], interval: Interval): Candle[] {
  const step = INTERVAL_MS[interval];
  let start = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i]!.openTime - candles[i - 1]!.openTime !== step) start = i;
  return candles.slice(start);
}

export const isStale = (last: Candle | undefined, interval: Interval, now: number, staleBars: number): boolean =>
  last === undefined || now - (last.openTime + INTERVAL_MS[interval]) > staleBars * INTERVAL_MS[interval];

export interface FeedSnapshot {
  readonly at: number;
  readonly market: TickMarket;
  /** openTime of the last closed NEAR 1h candle: the bar the tick evaluates. */
  readonly barTime: number | undefined;
  readonly problems: readonly string[];
}

/** Candle archive, one JSON file per series, merged by openTime. */
export class CandleArchive {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  file(symbol: string, interval: Interval) {
    return join(this.dir, `${symbol}-${interval}.json`);
  }
  async read(symbol: string, interval: Interval): Promise<Candle[]> {
    try {
      return (JSON.parse(await readFile(this.file(symbol, interval), "utf8")) as { candles: Candle[] }).candles;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  /** Merges `candles` in; returns the open times whose archived value differs from the new one. */
  async merge(symbol: string, interval: Interval, candles: readonly Candle[]): Promise<number[]> {
    const byTime = new Map((await this.read(symbol, interval)).map((c) => [c.openTime, c]));
    const changed: number[] = [];
    for (const c of candles) {
      const old = byTime.get(c.openTime);
      if (!old) byTime.set(c.openTime, c);
      else if (old.open !== c.open || old.high !== c.high || old.low !== c.low || old.close !== c.close || old.volume !== c.volume) changed.push(c.openTime);
    }
    const all = [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
    await mkdir(this.dir, { recursive: true });
    const path = this.file(symbol, interval);
    await writeFile(`${path}.tmp`, `${JSON.stringify({ symbol, interval, source: "binance data-api", candles: all })}\n`);
    await rename(`${path}.tmp`, path);
    return changed;
  }
}

export class MarketFeed {
  private readonly cfg: RiskConfig;
  private readonly client: Pick<BinanceClient, "closedCandles">;
  private readonly archive: CandleArchive | undefined;

  constructor(cfg: RiskConfig, client: Pick<BinanceClient, "closedCandles">, archive?: CandleArchive) {
    this.cfg = cfg;
    this.client = client;
    this.archive = archive;
  }

  /** Fetches the three series as of `now`. Network or schema errors propagate (the loop skips the tick). */
  async snapshot(now: number): Promise<FeedSnapshot> {
    const problems: string[] = [];
    const out: Record<string, Candle[]> = {};
    for (const s of feedSeries(this.cfg)) {
      // the archived value wins when Binance revises a candle: decisions already reference it
      let candles = await this.client.closedCandles({ symbol: s.symbol, interval: s.interval, limit: s.limit }, now);
      if (this.archive) {
        const changed = await this.archive.merge(s.symbol, s.interval, candles);
        if (changed.length) {
          problems.push(`${s.name}: ${changed.length} candle(s) changed at the source after being archived (archived values kept)`);
          const archived = new Map((await this.archive.read(s.symbol, s.interval)).map((c) => [c.openTime, c]));
          candles = candles.map((c) => archived.get(c.openTime) ?? c);
        }
      }
      const gaps = findGaps(candles, s.interval);
      if (gaps.length) {
        problems.push(`${s.name}: ${gaps.length} missing candle(s), last at ${new Date(gaps.at(-1)!).toISOString()}; history cut after the gap`);
        candles = contiguousTail(candles, s.interval);
      }
      if (isStale(candles.at(-1), s.interval, now, this.cfg.limits.staleBars)) {
        problems.push(`${s.name}: stale (last closed candle ${candles.at(-1) ? new Date(candles.at(-1)!.openTime).toISOString() : "none"})`);
      }
      out[s.name] = candles;
    }
    const near = out["NEAR 1h"]!;
    return { at: now, market: { candles1h: { NEAR: near, BTC: out["BTC 1h"]! }, btc4h: out["BTC 4h"]! }, barTime: near.at(-1)?.openTime, problems };
  }
}

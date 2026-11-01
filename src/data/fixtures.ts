/**
 * Loader for the frozen demo fixtures.
 *
 * Layout of a fixture set (as frozen during the preparation phase):
 *
 *   fixtures/<name>/manifest.json         what was frozen, around which bar, and what to expect
 *   fixtures/<name>/<SYMBOL>_<1h|4h>.json  a bare JSON array of candles
 *
 * The manifest is the source of truth. A set is accepted only if:
 * - every file listed in the manifest exists and its SHA-256 (of the raw file bytes) matches;
 * - no unlisted .json file sits next to it;
 * - each series has the announced count, first and last candle, and is strictly increasing,
 *   contiguous, aligned on its interval and internally consistent (low <= open, close <= high);
 * - the signal bar exists in the 1h series of the asset.
 * Any failure throws a FixtureError naming the file and the problem. Nothing is repaired silently.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hashCanonical } from "../lib/canonical.ts";
import {
  INTERVAL_MS,
  REJECT_REASONS,
  SIGNAL_KINDS,
  TRADABLE_ASSETS,
  type Candle,
  type CandleWindowRef,
  type Interval,
  type RejectReason,
  type SignalKind,
  type TradableAsset,
} from "../types.ts";

export class FixtureError extends Error {
  readonly file: string;
  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = "FixtureError";
    this.file = file;
  }
}

const finite = z.number().refine(Number.isFinite, "must be finite");

const candleSchema = z.strictObject({
  openTime: z.number().int().nonnegative(),
  open: finite.positive(),
  high: finite.positive(),
  low: finite.positive(),
  close: finite.positive(),
  volume: finite.nonnegative(),
});

/** ISO 8601 UTC instant, e.g. "2026-07-20T09:00Z" or "2026-07-20T09:00:00.000Z". */
const isoInstant = z.string().refine((s) => /Z$/.test(s) && !Number.isNaN(Date.parse(s)), "must be an ISO 8601 UTC instant");

const fileEntrySchema = z.strictObject({
  candles: z.number().int().positive(),
  from: isoInstant,
  to: isoInstant,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const manifestSchema = z.looseObject({
  name: z.string().min(1),
  asset: z.enum(TRADABLE_ASSETS),
  breakoutBar: isoInstant,
  kind: z.enum(["ENTRY", "REFUSAL"]),
  reason: z.string().min(1),
  files: z.record(z.string().regex(/^[A-Z0-9]+_(1h|4h)$/, "file key must be <SYMBOL>_<1h|4h>"), fileEntrySchema),
  event: z
    .looseObject({
      confirmations: z.array(z.enum(SIGNAL_KINDS)).default([]),
      vetoes: z.array(z.enum(SIGNAL_KINDS)).default([]),
    })
    .default({ confirmations: [], vetoes: [] }),
});

export type FixtureManifest = z.infer<typeof manifestSchema>;

/** What the decision engine must reproduce on the signal bar (TASK_LIST T1.7 golden test). */
export interface FixtureExpectation {
  readonly decision: "ENTRY" | "REJECT";
  readonly reason?: RejectReason;
  readonly confirmations: readonly SignalKind[];
  readonly vetoes: readonly SignalKind[];
}

export interface FixtureSeries {
  readonly file: string;
  readonly symbol: string;
  readonly interval: Interval;
  readonly candles: readonly Candle[];
  readonly sha256: string;
}

export interface FixtureSet {
  readonly name: string;
  readonly asset: TradableAsset;
  /** series[symbol][interval], e.g. series.NEARUSDT["1h"]. */
  readonly series: Readonly<Record<string, Partial<Record<Interval, FixtureSeries>>>>;
  /** openTime (ms) of the 1h bar the fixture was frozen around. */
  readonly signalBarTime: number;
  readonly expected: FixtureExpectation;
  /** The full manifest, kept as provenance (includes the selection tool's own simulation). */
  readonly manifest: FixtureManifest;
}

/** Manifest reasons use signal names for vetoes; the engine uses RejectReason. */
const REASON_ALIASES: Readonly<Record<string, RejectReason>> = {
  RSI_EXHAUSTION: "VETO_RSI_EXHAUSTION",
  BTC_REGIME: "VETO_BTC_REGIME",
};

function toExpectation(dir: string, m: FixtureManifest): FixtureExpectation {
  const base = { confirmations: m.event.confirmations, vetoes: m.event.vetoes };
  if (m.kind === "ENTRY") {
    if (m.reason !== "OK") throw new FixtureError(dir, `an ENTRY fixture must have reason "OK", got "${m.reason}"`);
    return { decision: "ENTRY", ...base };
  }
  const reason = REASON_ALIASES[m.reason] ?? m.reason;
  if (!(REJECT_REASONS as readonly string[]).includes(reason)) throw new FixtureError(dir, `unknown refusal reason "${m.reason}"`);
  return { decision: "REJECT", reason: reason as RejectReason, ...base };
}

/** Throws FixtureError if the candles are not sorted, contiguous, aligned and consistent. */
export function assertCandleSeries(file: string, candles: readonly Candle[], interval: Interval): void {
  const step = INTERVAL_MS[interval];
  candles.forEach((c, i) => {
    if (c.openTime % step !== 0) throw new FixtureError(file, `candle ${i} openTime ${c.openTime} is not aligned on ${interval}`);
    if (c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) {
      throw new FixtureError(file, `candle ${i} (${new Date(c.openTime).toISOString()}) has inconsistent OHLC`);
    }
    if (i === 0) return;
    const prev = candles[i - 1] as Candle;
    const delta = c.openTime - prev.openTime;
    if (delta <= 0) throw new FixtureError(file, `candle ${i} is not after candle ${i - 1} (unsorted or duplicate)`);
    if (delta !== step) throw new FixtureError(file, `gap of ${delta / step - 1} candle(s) after ${new Date(prev.openTime).toISOString()}`);
  });
}

/** Verifies one series file's raw bytes against its manifest entry and returns the candles. */
export function parseSeries(file: string, key: string, raw: Buffer, entry: z.infer<typeof fileEntrySchema>): FixtureSeries {
  const [symbol, interval] = key.split("_") as [string, Interval];
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== entry.sha256) throw new FixtureError(file, `sha256 mismatch: manifest ${entry.sha256.slice(0, 12)}…, file ${sha256.slice(0, 12)}…`);

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new FixtureError(file, `invalid JSON (${(e as Error).message})`);
  }
  const parsed = z.array(candleSchema).min(1).safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new FixtureError(file, `invalid candle at ${first?.path.join(".") || "root"}: ${first?.message}`);
  }
  const candles = parsed.data;
  if (candles.length !== entry.candles) throw new FixtureError(file, `manifest announces ${entry.candles} candles, file has ${candles.length}`);
  const first = candles[0] as Candle;
  const last = candles[candles.length - 1] as Candle;
  if (first.openTime !== Date.parse(entry.from)) throw new FixtureError(file, `first candle is ${new Date(first.openTime).toISOString()}, manifest says ${entry.from}`);
  if (last.openTime !== Date.parse(entry.to)) throw new FixtureError(file, `last candle is ${new Date(last.openTime).toISOString()}, manifest says ${entry.to}`);
  assertCandleSeries(file, candles, interval);
  return { file, symbol, interval, candles, sha256 };
}

/** Loads and verifies fixtures/<name>/ (manifest.json plus the series it lists). */
export async function loadFixtureSet(dir: string): Promise<FixtureSet> {
  const manifestFile = join(dir, "manifest.json");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (e) {
    throw new FixtureError(manifestFile, `cannot read manifest (${(e as Error).message})`);
  }
  const parsed = manifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new FixtureError(manifestFile, `invalid manifest at ${first?.path.join(".") || "root"}: ${first?.message}`);
  }
  const manifest = parsed.data;

  const listed = new Set(Object.keys(manifest.files).map((k) => `${k}.json`));
  const unlisted = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "manifest.json" && !listed.has(f));
  if (unlisted.length) throw new FixtureError(dir, `files not listed in the manifest: ${unlisted.join(", ")}`);

  const series: Record<string, Partial<Record<Interval, FixtureSeries>>> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    const file = join(dir, `${key}.json`);
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch {
      throw new FixtureError(file, "listed in the manifest but missing");
    }
    const s = parseSeries(file, key, raw, entry);
    (series[s.symbol] ??= {})[s.interval] = s;
  }

  const signalBarTime = Date.parse(manifest.breakoutBar);
  const assetSeries = Object.values(series)
    .map((byInterval) => byInterval["1h"])
    .find((s) => s?.symbol.startsWith(manifest.asset));
  if (!assetSeries) throw new FixtureError(dir, `no 1h series for asset ${manifest.asset}`);
  if (!assetSeries.candles.some((c) => c.openTime === signalBarTime)) {
    throw new FixtureError(dir, `signal bar ${manifest.breakoutBar} is not in ${assetSeries.symbol} 1h`);
  }

  return { name: manifest.name, asset: manifest.asset, series, signalBarTime, expected: toExpectation(dir, manifest), manifest };
}

/** Reference to a candle window for decision records (canonical-JSON hash, independent of key order). */
export function windowRef(symbol: string, interval: Interval, candles: readonly Candle[]): CandleWindowRef {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error("windowRef needs at least one candle");
  return { symbol, interval, firstOpenTime: first.openTime, lastOpenTime: last.openTime, count: candles.length, sha256: hashCanonical(candles) };
}

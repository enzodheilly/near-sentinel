/**
 * Loader for the frozen demo fixtures (fixtures/<name>/<SYMBOL>_<interval>.json).
 *
 * A fixture file is { meta, candles }. It is accepted only if:
 * - `meta.sha256` equals SHA-256 of JSON.stringify(candles) (the hash written when it was frozen);
 * - `meta.count`, `meta.symbol` and `meta.interval` match the content and the file name;
 * - candles are strictly increasing, contiguous for their interval, and internally consistent
 *   (low <= open, close <= high; finite numbers; volume >= 0).
 * Any failure throws a FixtureError naming the file and the problem. Nothing is repaired silently.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { hashCanonical, sha256Hex } from "../lib/canonical.ts";
import { INTERVAL_MS, type Candle, type CandleWindowRef, type Interval } from "../types.ts";

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

const expectedSchema = z.looseObject({
  decision: z.enum(["ENTRY", "REJECT"]),
  reason: z.string().nullable().optional(),
  confirmations: z.array(z.string()).optional(),
  vetoes: z.array(z.string()).optional(),
});

/** Critical fields are checked strictly; other provenance fields are kept as they are. */
const metaSchema = z.looseObject({
  symbol: z.string().min(1),
  interval: z.enum(["1h", "4h"]),
  count: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signalBar: z.string().optional(),
  expected: expectedSchema.optional(),
});

const fileSchema = z.strictObject({ meta: metaSchema, candles: z.array(candleSchema).min(1) });

export type FixtureMeta = z.infer<typeof metaSchema>;
export type FixtureExpectation = z.infer<typeof expectedSchema>;

export interface FixtureSeries {
  readonly file: string;
  readonly symbol: string;
  readonly interval: Interval;
  readonly candles: readonly Candle[];
  readonly meta: FixtureMeta;
}

export interface FixtureSet {
  readonly name: string;
  /** series[symbol][interval], e.g. series.NEARUSDT["1h"]. */
  readonly series: Readonly<Record<string, Partial<Record<Interval, FixtureSeries>>>>;
  /** openTime (ms) of the bar the fixture was frozen around, if recorded. */
  readonly signalBarTime?: number;
  readonly expected?: FixtureExpectation;
}

const FILE_RE = /^([A-Z0-9]+)_(1h|4h)\.json$/;

/** Throws FixtureError if the candles are not sorted, contiguous and consistent. */
export function assertCandleSeries(file: string, candles: readonly Candle[], interval: Interval): void {
  const step = INTERVAL_MS[interval];
  candles.forEach((c, i) => {
    if (c.openTime % step !== 0) throw new FixtureError(file, `candle ${i} openTime ${c.openTime} is not aligned on ${interval}`);
    if (c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || c.low > c.high) {
      throw new FixtureError(file, `candle ${i} (${new Date(c.openTime).toISOString()}) has inconsistent OHLC`);
    }
    if (i === 0) return;
    const prev = candles[i - 1] as Candle;
    const delta = c.openTime - prev.openTime;
    if (delta <= 0) throw new FixtureError(file, `candle ${i} is not after candle ${i - 1} (unsorted or duplicate)`);
    if (delta !== step) {
      throw new FixtureError(file, `gap of ${delta / step - 1} candle(s) after ${new Date(prev.openTime).toISOString()}`);
    }
  });
}

/** Parses and verifies one fixture file's content. `file` is used for naming and messages. */
export function parseFixtureFile(file: string, text: string): FixtureSeries {
  const match = FILE_RE.exec(basename(file));
  if (!match) throw new FixtureError(file, "file name must be <SYMBOL>_<1h|4h>.json");
  const [, symbol, interval] = match as unknown as [string, string, Interval];

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new FixtureError(file, `invalid JSON (${(e as Error).message})`);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new FixtureError(file, `invalid content at ${first?.path.join(".") || "root"}: ${first?.message}`);
  }
  const { meta, candles } = parsed.data;

  const actual = sha256Hex(JSON.stringify(candles));
  if (actual !== meta.sha256) throw new FixtureError(file, `sha256 mismatch: meta ${meta.sha256.slice(0, 12)}…, content ${actual.slice(0, 12)}…`);
  if (meta.count !== candles.length) throw new FixtureError(file, `meta.count is ${meta.count} but the file has ${candles.length} candles`);
  if (meta.symbol !== symbol) throw new FixtureError(file, `meta.symbol ${meta.symbol} does not match file name`);
  if (meta.interval !== interval) throw new FixtureError(file, `meta.interval ${meta.interval} does not match file name`);
  assertCandleSeries(file, candles, interval);

  return { file, symbol, interval, candles, meta };
}

/** Loads every <SYMBOL>_<interval>.json in `dir` as one fixture set. */
export async function loadFixtureSet(dir: string): Promise<FixtureSet> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new FixtureError(dir, "no fixture files found");

  const series: Record<string, Partial<Record<Interval, FixtureSeries>>> = {};
  for (const f of files) {
    const s = parseFixtureFile(join(dir, f), await readFile(join(dir, f), "utf8"));
    (series[s.symbol] ??= {})[s.interval] = s;
  }

  // All files of a set are frozen around the same bar and must agree on what to expect.
  const all = Object.values(series).flatMap((byInterval) => Object.values(byInterval));
  const bars = new Set(all.map((s) => s.meta.signalBar).filter((b): b is string => b !== undefined));
  if (bars.size > 1) throw new FixtureError(dir, `files disagree on signalBar: ${[...bars].join(", ")}`);
  const [bar] = bars;
  const signalBarTime = bar === undefined ? undefined : Date.parse(bar);
  if (signalBarTime !== undefined && Number.isNaN(signalBarTime)) throw new FixtureError(dir, `invalid signalBar ${bar}`);
  const expected = all.find((s) => s.meta.expected)?.meta.expected;

  return {
    name: basename(dir),
    series,
    ...(signalBarTime !== undefined ? { signalBarTime } : {}),
    ...(expected ? { expected } : {}),
  };
}

/** Reference to a candle window for decision records (canonical-JSON hash, independent of key order). */
export function windowRef(symbol: string, interval: Interval, candles: readonly Candle[]): CandleWindowRef {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error("windowRef needs at least one candle");
  return {
    symbol,
    interval,
    firstOpenTime: first.openTime,
    lastOpenTime: last.openTime,
    count: candles.length,
    sha256: hashCanonical(candles),
  };
}

/**
 * Decision records (ARCHITECTURE.md §10): everything needed to reproduce one decision, canonicalised with
 * RFC 8785 (JCS) and hashed with SHA-256. Rejections and holds are recorded like trades.
 *
 * The file `records/<hash>.json` holds exactly the canonical bytes that were hashed, so
 * `sha256(file) === <hash>` can be checked with any tool, without this code.
 *
 * Externals (quotes, clock, balances, LLM answer) are copied in call order, so `verify` can replay the decision.
 * Candles are referenced, not copied: each CandleWindowRef carries the SHA-256 of the canonical candle array
 * the engine read (asset 1h up to the bar, BTC 1h up to the bar, BTC 4h closed by the bar's close).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { windowRef } from "../data/fixtures.ts";
import { canonicalJson, sha256Hex } from "../lib/canonical.ts";
import { INTERVAL_MS, type Candle, type CandleWindowRef, type DecisionRecord, type TradableAsset } from "../types.ts";
import type { Decision, TickMarket } from "./engine.ts";

export interface RecordMeta {
  /** git commit of the agent that took the decision. */
  readonly agentVersion: string;
  /** configHash of the risk config in force. */
  readonly configHash: string;
}

const SYMBOL: Readonly<Record<TradableAsset, string>> = { BTC: "BTCUSDT", NEAR: "NEARUSDT" };

/**
 * The candle windows a decision depends on, exactly as cut for bar `barTime`: every 1h series (signals of the
 * asset, BTC for the regime, and the freshness of all of them for the limits gate) and the BTC 4h candles
 * closed by the bar's close. Same three windows for every decision of a tick, in a fixed order.
 */
export function decisionWindows(market: TickMarket, _asset: TradableAsset, barTime: number): CandleWindowRef[] {
  const upTo = (cs: readonly Candle[]) => cs.filter((c) => c.openTime <= barTime);
  const closed4h = market.btc4h.filter((c) => c.openTime + INTERVAL_MS["4h"] <= barTime + INTERVAL_MS["1h"]);
  const refs: CandleWindowRef[] = [];
  for (const a of ["NEAR", "BTC"] as const) {
    const cs = upTo(market.candles1h[a]);
    if (cs.length) refs.push(windowRef(SYMBOL[a], "1h", cs));
  }
  if (closed4h.length) refs.push(windowRef("BTCUSDT", "4h", closed4h));
  return refs;
}

export function buildRecord(d: Decision, candles: readonly CandleWindowRef[], meta: RecordMeta): DecisionRecord {
  return {
    version: 1,
    agentVersion: meta.agentVersion,
    configHash: meta.configHash,
    asset: d.asset,
    barTime: d.barTime,
    inputs: { candles, portfolio: d.portfolio, now: d.now, externals: d.externals, ...(d.trigger ? { trigger: d.trigger } : {}) },
    signals: d.signals,
    checks: d.checks,
    ...(d.llm ? { llm: d.llm } : {}),
    outcome: d.outcome,
  };
}

/** The canonical bytes of a record (what is hashed and what is written). */
export const recordBytes = (r: DecisionRecord): string => canonicalJson(r);

export const hashRecord = (r: DecisionRecord): string => sha256Hex(recordBytes(r));

/**
 * Writes `<dir>/<hash>.json` and returns the hash. Idempotent: writing the same record twice is a no-op;
 * the write goes through a temporary file, so a crash never leaves a half-written record under a valid name.
 */
export async function writeRecord(dir: string, r: DecisionRecord): Promise<string> {
  const bytes = recordBytes(r);
  const hash = sha256Hex(bytes);
  const path = join(dir, `${hash}.json`);
  await mkdir(dir, { recursive: true });
  try {
    if ((await readFile(path, "utf8")) === bytes) return hash;
  } catch {
    // not written yet
  }
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, bytes, "utf8");
  await rename(tmp, path);
  return hash;
}

/** Reads a record and checks that its bytes still hash to its name. */
export async function readRecord(dir: string, hash: string): Promise<DecisionRecord> {
  const bytes = await readFile(join(dir, `${hash}.json`), "utf8");
  const actual = sha256Hex(bytes);
  if (actual !== hash) throw new Error(`record ${hash}: file content hashes to ${actual} (modified after it was written)`);
  return JSON.parse(bytes) as DecisionRecord;
}

/**
 * An `onDecision` sink for the engine: builds, hashes and writes each record before its trade executes.
 * `anchor`, when given (live mode), is awaited too, so a trade never executes before its hash is on-chain.
 */
export function recorder(dir: string, market: TickMarket, meta: RecordMeta, anchor?: (hash: string) => Promise<void>) {
  const hashes: string[] = [];
  const cache = new Map<string, CandleWindowRef[]>();
  const sink = async (d: Decision): Promise<void> => {
    const key = `${d.asset}:${d.barTime}`;
    let refs = cache.get(key);
    if (!refs) cache.set(key, (refs = decisionWindows(market, d.asset, d.barTime)));
    const hash = await writeRecord(dir, buildRecord(d, refs, meta));
    hashes.push(hash);
    if (anchor) await anchor(hash);
  };
  return { sink, hashes };
}

/**
 * `pnpm verify <hash>... | --all`: recompute records and check them (src/decision/verify.ts).
 * Exit code 0 only if every record verifies. A hash prefix of 8+ characters is accepted.
 *
 * Candle data is looked up in fixtures/ (any set whose windows match). Not yet checked, and said so:
 * the LLM TEE signature (#33/#35) and the on-chain anchor (#44).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultRiskConfig } from "../config/default.ts";
import { configHash, type RiskConfig } from "../config/schema.ts";
import { loadFixtureSet, type FixtureSet } from "../data/fixtures.ts";
import { readRecord } from "../decision/record.ts";
import { verifyRecord } from "../decision/verify.ts";
import type { Candle, DecisionRecord, Interval } from "../types.ts";

export interface VerifyCliOptions {
  readonly root: string;
  readonly records: string;
  readonly args: readonly string[];
  readonly write: (line: string) => void;
  readonly configs?: ReadonlyMap<string, RiskConfig>;
}

export async function loadAllFixtures(root: string): Promise<FixtureSet[]> {
  const dir = join(root, "fixtures");
  const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return Promise.all(names.map((n) => loadFixtureSet(join(dir, n))));
}

/** Candles for a record: the first fixture set whose series cover every window the record references. */
export function candleSourceFor(rec: DecisionRecord, sets: readonly FixtureSet[]) {
  const covers = (s: FixtureSet) =>
    rec.inputs.candles.every((w) => {
      const cs = s.series[w.symbol]?.[w.interval]?.candles;
      return !!cs?.length && cs[0]!.openTime <= w.firstOpenTime && cs.at(-1)!.openTime >= w.lastOpenTime;
    });
  const set = sets.find(covers);
  return { set, candles: (symbol: string, interval: Interval): readonly Candle[] | undefined => set?.series[symbol]?.[interval]?.candles };
}

async function resolveHashes(records: string, args: readonly string[]): Promise<{ hashes: string[]; errors: string[] }> {
  let files: string[] = [];
  try {
    files = (await readdir(records)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).map((f) => f.slice(0, 64));
  } catch {
    return { hashes: [], errors: [`no records directory at ${records} (run pnpm demo first)`] };
  }
  if (args.includes("--all")) return { hashes: files.sort(), errors: files.length ? [] : [`no records in ${records}`] };
  const hashes: string[] = [];
  const errors: string[] = [];
  for (const a of args.filter((x) => !x.startsWith("--"))) {
    if (!/^[0-9a-f]{8,64}$/.test(a)) {
      errors.push(`${a}: not a record hash (8 to 64 hex characters)`);
      continue;
    }
    const hits = files.filter((f) => f.startsWith(a));
    if (hits.length === 1) hashes.push(hits[0]!);
    else errors.push(hits.length ? `${a}: ambiguous, matches ${hits.length} records` : `${a}: no such record in ${records}`);
  }
  if (!hashes.length && !errors.length) errors.push("usage: pnpm verify <hash>... | --all");
  return { hashes, errors };
}

export async function runVerify(o: VerifyCliOptions): Promise<number> {
  const configs = o.configs ?? new Map([[configHash(defaultRiskConfig), defaultRiskConfig]]);
  const { hashes, errors } = await resolveHashes(o.records, o.args);
  for (const e of errors) o.write(`✗ ${e}`);
  const sets = await loadAllFixtures(o.root);
  const all = o.args.includes("--all");
  let bad = errors.length;
  let good = 0;
  for (const h of hashes) {
    let rec: DecisionRecord;
    try {
      rec = await readRecord(o.records, h);
    } catch (e) {
      bad++;
      o.write(`✗ ${h}\n    ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const src = candleSourceFor(rec, sets);
    const res = await verifyRecord(rec, { configs, candles: src.candles, expectedHash: h });
    const what = `${rec.asset} ${new Date(rec.barTime).toISOString().slice(0, 16).replace("T", " ")} ${rec.outcome.action}${"reason" in rec.outcome ? ` ${rec.outcome.reason}` : ""}`;
    if (!res.ok) {
      bad++;
      o.write(`✗ ${h}  ${what}`);
      for (const p of res.problems) o.write(`    ${p}`);
      continue;
    }
    good++;
    if (all) continue; // one summary line at the end
    o.write(`✓ ${h}  ${what}`);
    o.write(`    hash: the file's bytes hash to its name`);
    o.write(`    config: ${rec.configHash.slice(0, 16)}… known`);
    o.write(`    candles: ${rec.inputs.candles.map((c) => `${c.symbol} ${c.interval} (${c.count})`).join(", ")} match ${src.set?.name ?? "?"}`);
    o.write(`    recomputed: same signals, checks and outcome, byte for byte`);
    for (const n of res.notes) o.write(`    note: ${n}`);
    o.write(`    LLM signature: ${rec.llm?.signature ? "present, not checked yet (#33)" : rec.llm ? "none (replay: no model called)" : "no LLM stage in this decision"}`);
    o.write(`    on-chain anchor: not checked yet (contract lands in Sprint 5)`);
  }
  if (all || hashes.length > 1) o.write(`${bad ? "✗" : "✓"} ${good} of ${good + bad} record(s) verified${bad ? `, ${bad} failed` : ""}`);
  return bad ? 1 : 0;
}

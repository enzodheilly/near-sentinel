/**
 * `pnpm explorer`: build explorer/dist/index.html, a read-only human view of what the agent did.
 *
 * Built only from real data: each demo scenario is replayed, its decision records are written to `records/`,
 * read back FROM DISK, verified one by one (src/decision/verify.ts), and embedded with the fixture candles.
 * Nothing in the page is mocked. The page is one self-contained file: no CDN, no network, no backend,
 * no wallet, no buttons that act. It opens from file://.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitVersion, SCENARIOS } from "../cli/demo.ts";
import { candleSourceFor, loadArchiveSet } from "../cli/verify.ts";
import { defaultRiskConfig } from "../config/default.ts";
import { configHash, type RiskConfig } from "../config/schema.ts";
import { loadFixtureSet, type FixtureSet } from "../data/fixtures.ts";
import { readRecord } from "../decision/record.ts";
import { verifyRecord } from "../decision/verify.ts";
import { runReplay, scenarioBars } from "../execution/replay.ts";
import type { DecisionRecord } from "../types.ts";

const H = 3_600_000;

export interface ExplorerDecision {
  readonly hash: string;
  readonly verified: boolean;
  readonly problems: readonly string[];
  readonly record: DecisionRecord;
  /** On-chain anchor in the guardrail contract, when checked at build time (null: checked, not found). */
  readonly anchor?: { readonly seq: number; readonly at: number; readonly contract: string; readonly network: string } | null;
}

export interface ExplorerScenario {
  readonly name: string;
  readonly asset: string;
  readonly kind: "ENTRY" | "REJECT" | "PAPER";
  readonly signalBarTime: number;
  /** [openTime, open, high, low, close] of the asset's 1h candles shown on the chart. */
  readonly candles: readonly (readonly [number, number, number, number, number])[];
  readonly bars: number;
  readonly startEquity: number;
  readonly endEquity: number;
  readonly decisions: readonly ExplorerDecision[];
}

export interface ExplorerData {
  readonly builtAt: string;
  readonly agentVersion: string;
  readonly configHash: string;
  readonly llmModel: string;
  readonly scenarios: readonly ExplorerScenario[];
}

export interface AnchorCheck {
  readonly contract: string;
  readonly network: string;
  readonly lookup: (hash: string) => Promise<{ readonly kind: string; readonly recorded_at_ms: number; readonly seq: number } | null>;
}

export async function buildExplorerData(o: { root: string; records: string; cfg?: RiskConfig; agentVersion?: string; now?: () => number; anchor?: AnchorCheck }): Promise<ExplorerData> {
  const cfg = o.cfg ?? defaultRiskConfig;
  const meta = { agentVersion: o.agentVersion ?? gitVersion(o.root), configHash: configHash(cfg) };
  const configs = new Map([[meta.configHash, cfg]]);
  const sets: FixtureSet[] = [];
  const scenarios: ExplorerScenario[] = [];
  for (const name of SCENARIOS) sets.push(await loadFixtureSet(join(o.root, "fixtures", name)));

  for (const set of sets) {
    const bars = scenarioBars(set);
    const run = await runReplay({ set, cfg, meta, dir: o.records, ...(bars ? { bars } : {}) });
    const decisions: ExplorerDecision[] = [];
    for (const hash of run.hashes) {
      const record = await readRecord(o.records, hash); // what is on disk, not what is in memory
      const res = await verifyRecord(record, { configs, candles: candleSourceFor(record, sets).candles, expectedHash: hash });
      decisions.push({ hash, verified: res.ok, problems: res.problems, record });
    }
    const all = set.series[`${set.asset}USDT`]!["1h"]!.candles;
    const lastBar = all[cfg.warmupBars.exec + run.bars - 1]!.openTime;
    const from = set.signalBarTime - 48 * H;
    const to = Math.max(lastBar, ...run.executions.map((e) => e.barTime)) + 4 * H;
    scenarios.push({
      name: set.name, asset: set.asset, kind: set.expected.decision, signalBarTime: set.signalBarTime,
      candles: all.filter((c) => c.openTime >= from && c.openTime <= Math.min(to, lastBar)).map((c) => [c.openTime, c.open, c.high, c.low, c.close] as const),
      bars: run.bars, startEquity: run.start.equityUsd, endEquity: run.end.equityUsd, decisions,
    });
  }
  const known = new Set(scenarios.flatMap((x) => x.decisions.map((d) => d.hash)));
  const paper = await paperScenario({ records: o.records, archiveDir: join(o.root, "data", "candles"), configs, known, ...(o.anchor ? { anchor: o.anchor } : {}) });
  if (paper) scenarios.push(paper);
  return { builtAt: new Date((o.now ?? Date.now)()).toISOString(), ...meta, llmModel: cfg.llm.model, scenarios };
}

/**
 * The paper (or live) run: every record in `records/` whose candles are in the live archive (data/candles),
 * read from disk, verified against the archive, and checked against the on-chain anchor when one is given.
 */
export async function paperScenario(o: { records: string; archiveDir: string; configs: ReadonlyMap<string, RiskConfig>; known: ReadonlySet<string>; anchor?: AnchorCheck }): Promise<ExplorerScenario | undefined> {
  const archive = await loadArchiveSet(o.archiveDir);
  const near = archive.series["NEARUSDT"]?.["1h"]?.candles ?? [];
  if (near.length === 0) return undefined;
  let files: string[] = [];
  try {
    files = (await readdir(o.records)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  } catch {
    return undefined;
  }
  const decisions: ExplorerDecision[] = [];
  for (const f of files) {
    const hash = f.slice(0, 64);
    if (o.known.has(hash)) continue;
    const record = await readRecord(o.records, hash);
    const src = candleSourceFor(record, [archive]);
    if (!src.set) continue; // a record of something else (e.g. an older replay)
    const res = await verifyRecord(record, { configs: o.configs, candles: src.candles, expectedHash: hash });
    let anchor: ExplorerDecision["anchor"];
    if (o.anchor) {
      const a = await o.anchor.lookup(hash).catch(() => null);
      anchor = a ? { seq: a.seq, at: a.recorded_at_ms, contract: o.anchor.contract, network: o.anchor.network } : null;
    }
    decisions.push({ hash, verified: res.ok, problems: res.problems, record, ...(anchor !== undefined ? { anchor } : {}) });
  }
  if (decisions.length === 0) return undefined;
  decisions.sort((a, b) => a.record.barTime - b.record.barTime || (a.record.asset < b.record.asset ? -1 : 1));
  const first = decisions[0]!.record, last = decisions.at(-1)!.record;
  const key = decisions.find((d) => d.record.outcome.action !== "HOLD") ?? decisions.at(-1)!;
  return {
    name: "paper run", asset: "NEAR", kind: "PAPER", signalBarTime: key.record.barTime,
    candles: near.filter((c) => c.openTime >= first.barTime - 6 * H && c.openTime <= last.barTime).map((c) => [c.openTime, c.open, c.high, c.low, c.close] as const),
    bars: new Set(decisions.map((d) => d.record.barTime)).size,
    startEquity: first.inputs.portfolio.equityUsd, endEquity: last.inputs.portfolio.equityUsd, decisions,
  };
}

/** Inline the data into the template. `</` is escaped so no record content can close the script tag. */
export function renderExplorer(template: string, data: ExplorerData): string {
  const json = JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)).replace(/</g, "\\u003c");
  if (!template.includes("/*__DATA__*/null")) throw new Error("explorer template: data placeholder missing");
  return template.replace("/*__DATA__*/null", json);
}

export async function runExplorer(o: { root: string; records: string; out?: string; write: (l: string) => void; agentVersion?: string; now?: () => number; anchor?: AnchorCheck }): Promise<number> {
  const out = o.out ?? join(o.root, "explorer", "dist", "index.html");
  const template = await readFile(join(dirname(fileURLToPath(import.meta.url)), "template.html"), "utf8");
  const data = await buildExplorerData(o);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderExplorer(template, data));
  const n = data.scenarios.reduce((s, x) => s + x.decisions.length, 0);
  const bad = data.scenarios.flatMap((s) => s.decisions).filter((d) => !d.verified).length;
  o.write(`explorer: ${n} decision records embedded (${bad ? `${bad} FAILED verification` : "all verified"}) → ${out}`);
  return bad ? 1 : 0;
}

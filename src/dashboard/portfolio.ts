/**
 * The dashboard's portfolio tab: how an agent's money evolved. Read-only, rebuilt from what the agent already writes.
 *
 * - paper / live: `state/<mode>/history.jsonl` (one line per tick, written by the runner since this tab exists).
 *   For the paper agent, the time before that file is rebuilt from its decision records: each record holds the
 *   portfolio the decision was taken on, and the archived candles (data/candles) give the prices to value it.
 * - demo: the frozen replay `pnpm demo` writes (records whose bar lies in a fixture's window), so a visitor can
 *   see a full trade cycle. Always labelled as a replay, never mixed with real results.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RiskConfig } from "../config/schema.ts";
import type { DecisionRecord, PortfolioSnapshot } from "../types.ts";

export type PortfolioMode = "paper" | "live" | "demo";
type Asset = "USDC" | "NEAR" | "BTC";

export interface PortfolioPoint {
  readonly t: number;
  readonly equity: number;
  /** USD value of each holding. */
  readonly values: Readonly<Record<Asset, number>>;
}

export interface PortfolioTrade {
  readonly t: number;
  readonly asset: "NEAR" | "BTC";
  readonly kind: "ENTRY" | "EXIT";
  readonly reason?: string;
  readonly notionalUsd?: number;
  readonly fraction?: number;
  readonly price: number;
}

export interface PortfolioView {
  readonly mode: PortfolioMode;
  /** Where the numbers come from, in one line. */
  readonly source: string;
  readonly points: readonly PortfolioPoint[];
  readonly trades: readonly PortfolioTrade[];
  readonly limits: { readonly dailyLossPct: number; readonly maxDrawdownPct: number; readonly maxEntriesPerDay: number };
  /** Current state of the limits (paper and live). */
  readonly today?: { readonly dayStartEquity: number; readonly peakEquity: number; readonly equity: number; readonly entriesToday: number; readonly killSwitch: boolean };
}

const readJson = async <T>(p: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
};

const value = (balances: Readonly<Record<Asset, number>>, prices: Partial<Record<"NEAR" | "BTC", number>>, equity: number): Record<Asset, number> => {
  const v = { USDC: balances.USDC, NEAR: balances.NEAR * (prices.NEAR ?? NaN), BTC: balances.BTC * (prices.BTC ?? NaN) };
  // a price missing: when one asset is held, it is worth whatever equity is not USDC
  for (const a of ["NEAR", "BTC"] as const) {
    if (Number.isNaN(v[a])) {
      const other = a === "NEAR" ? "BTC" : "NEAR";
      v[a] = balances[a] > 0 ? Math.max(0, equity - v.USDC - (Number.isNaN(v[other]) ? 0 : v[other])) : 0;
    }
  }
  return v;
};

interface HistoryLine {
  t: number;
  equity: number;
  balances: Record<Asset, number>;
  prices: Partial<Record<"NEAR" | "BTC", number>>;
  trades?: { asset: "NEAR" | "BTC"; kind: "ENTRY" | "EXIT"; reason?: string; notionalUsd?: number; fraction?: number; price: number }[];
}

async function readHistory(path: string): Promise<{ points: PortfolioPoint[]; trades: PortfolioTrade[] }> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { points: [], trades: [] };
  }
  const points: PortfolioPoint[] = [];
  const trades: PortfolioTrade[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let h: HistoryLine;
    try {
      h = JSON.parse(l) as HistoryLine;
    } catch {
      continue; // a line cut by a crash
    }
    points.push({ t: h.t, equity: h.equity, values: value(h.balances, h.prices, h.equity) });
    for (const x of h.trades ?? []) trades.push({ t: h.t, ...x });
  }
  return { points, trades };
}

/** Records, split into the agent's own and the demo replays (decided on bars inside a frozen fixture window). */
async function readRecords(root: string): Promise<{ live: DecisionRecord[]; replay: DecisionRecord[] }> {
  const windows: [number, number][] = [];
  try {
    for (const d of await readdir(join(root, "fixtures"))) {
      const m = await readJson<{ window?: { from: string; to: string } }>(join(root, "fixtures", d, "manifest.json"));
      if (m?.window) windows.push([Date.parse(m.window.from), Date.parse(m.window.to)]);
    }
  } catch {
    // no fixtures: no replays
  }
  const dir = join(root, "records");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  } catch {
    return { live: [], replay: [] };
  }
  const live: DecisionRecord[] = [];
  const replay: DecisionRecord[] = [];
  for (const f of files) {
    const rec = await readJson<DecisionRecord>(join(dir, f));
    if (!rec) continue;
    (windows.some(([a, b]) => rec.barTime >= a && rec.barTime <= b) ? replay : live).push(rec);
  }
  return { live, replay };
}

/** Closes of the archived 1h candles, by openTime. */
async function archiveCloses(root: string): Promise<Record<"NEAR" | "BTC", Map<number, number>>> {
  const out = { NEAR: new Map<number, number>(), BTC: new Map<number, number>() };
  for (const [a, sym] of [["NEAR", "NEARUSDT"], ["BTC", "BTCUSDT"]] as const) {
    const j = await readJson<{ candles: { openTime: number; close: number }[] }>(join(root, "data", "candles", `${sym}-1h.json`));
    for (const c of j?.candles ?? []) out[a].set(c.openTime, c.close);
  }
  return out;
}

/** One point per bar (the latest decision's portfolio of that bar) and the trades, from records. */
function fromRecords(recs: readonly DecisionRecord[], closes?: Record<"NEAR" | "BTC", Map<number, number>>): { points: PortfolioPoint[]; trades: PortfolioTrade[] } {
  const byBar = new Map<number, PortfolioSnapshot & { now: number }>();
  const trades: PortfolioTrade[] = [];
  for (const r of recs) {
    const prev = byBar.get(r.barTime);
    if (!prev || r.inputs.now > prev.now) byBar.set(r.barTime, { ...r.inputs.portfolio, now: r.inputs.now });
    const o = r.outcome;
    if (o.action === "TRADE") {
      const p = o.proposal;
      trades.push(p.kind === "ENTRY"
        ? { t: r.inputs.now, asset: p.asset, kind: "ENTRY", notionalUsd: p.notionalUsd, price: p.referencePrice }
        : { t: r.inputs.now, asset: p.asset, kind: "EXIT", reason: p.reason, fraction: p.fraction, price: p.referencePrice });
    }
  }
  const points = [...byBar.entries()].sort((a, b) => a[0] - b[0]).map(([bar, s]) => {
    const prices = closes ? { ...(closes.NEAR.has(bar) ? { NEAR: closes.NEAR.get(bar)! } : {}), ...(closes.BTC.has(bar) ? { BTC: closes.BTC.get(bar)! } : {}) } : {};
    return { t: s.now, equity: s.equityUsd, values: value(s.balances, prices, s.equityUsd) };
  });
  return { points, trades: trades.sort((a, b) => a.t - b.t) };
}

export async function buildPortfolio(root: string, mode: PortfolioMode, cfg: RiskConfig): Promise<PortfolioView> {
  const limits = { dailyLossPct: cfg.limits.dailyLossPct, maxDrawdownPct: cfg.limits.maxDrawdownPct, maxEntriesPerDay: cfg.limits.maxEntriesPerDay };
  if (mode === "demo") {
    const { replay } = await readRecords(root);
    // replays are split into scenarios by gaps of more than two days; show the one with trades (the full cycle)
    const sorted = [...replay].sort((a, b) => a.barTime - b.barTime);
    const runs: DecisionRecord[][] = [];
    for (const r of sorted) {
      const last = runs.at(-1)?.at(-1);
      if (!last || r.barTime - last.barTime > 2 * 86_400_000) runs.push([r]);
      else runs.at(-1)!.push(r);
    }
    const run = runs.find((x) => x.some((r) => r.outcome.action === "TRADE")) ?? runs[0] ?? [];
    const { points, trades } = fromRecords(run);
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    return {
      mode, limits, points, trades,
      source: run.length ? `Replay of frozen market data, ${day(run[0]!.barTime)} to ${day(run.at(-1)!.barTime)} (pnpm demo). Not live results.` : "No replay yet: run pnpm demo once.",
    };
  }
  const dir = join(root, "state", mode);
  const hist = await readHistory(join(dir, "history.jsonl"));
  let points = hist.points, trades = hist.trades;
  let source = mode === "live" ? "Recorded at every tick of the live agent." : "Recorded at every tick of the paper agent.";
  if (mode === "paper") {
    // before history.jsonl existed: rebuilt from the paper agent's own records (live has not run before it)
    const since = hist.points[0]?.t ?? Infinity;
    const { live } = await readRecords(root);
    const back = fromRecords(live.filter((r) => r.inputs.now < since), await archiveCloses(root));
    if (back.points.length) source = "Rebuilt from the paper agent's decision records, then recorded at every tick.";
    points = [...back.points, ...points];
    trades = [...back.trades, ...trades];
  }
  const st = await readJson<{ portfolio: PortfolioSnapshot }>(join(dir, "portfolio.json"));
  const p = st?.portfolio;
  return {
    mode, limits, points, trades, source,
    ...(p ? { today: { dayStartEquity: p.dayStartEquityUsd, peakEquity: p.peakEquityUsd, equity: p.equityUsd, entriesToday: p.entriesToday, killSwitch: p.killSwitch } } : {}),
  };
}

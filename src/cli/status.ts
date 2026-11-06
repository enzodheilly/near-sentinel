/**
 * `pnpm status`: the last known state — positions, limits, today's PnL. Read from state/portfolio.json
 * (written after every tick or replay); falls back to the portfolio of the most recent record, and says so.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultRiskConfig } from "../config/default.ts";
import type { RiskConfig } from "../config/schema.ts";
import type { DecisionRecord, PortfolioSnapshot } from "../types.ts";

export interface SavedState {
  readonly savedAt: number;
  readonly source: string; // e.g. "replay demo-refusal", "paper", "live"
  readonly portfolio: PortfolioSnapshot;
}

export async function saveState(path: string, s: SavedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(s, null, 2)}\n`);
}

async function lastRecordState(records: string): Promise<SavedState | null> {
  let best: DecisionRecord | null = null;
  try {
    for (const f of await readdir(records)) {
      if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
      const r = JSON.parse(await readFile(join(records, f), "utf8")) as DecisionRecord;
      if (!best || r.inputs.now > best.inputs.now) best = r;
    }
  } catch {
    return null;
  }
  return best && { savedAt: best.inputs.now, source: `latest record (${best.asset} ${new Date(best.barTime).toISOString()})`, portfolio: best.inputs.portfolio };
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export async function runStatus(o: { statePath: string; records: string; write: (l: string) => void; cfg?: RiskConfig }): Promise<number> {
  const cfg = o.cfg ?? defaultRiskConfig;
  let s: SavedState | null = null;
  try {
    s = JSON.parse(await readFile(o.statePath, "utf8")) as SavedState;
  } catch {
    s = await lastRecordState(o.records);
    if (s) o.write(`(no ${o.statePath}; showing the state recorded with the latest decision)`);
  }
  if (!s) {
    o.write("no state yet: run pnpm demo (replay) or pnpm paper first");
    return 1;
  }
  const p = s.portfolio;
  const L = cfg.limits;
  const dd = p.peakEquityUsd > 0 ? p.equityUsd / p.peakEquityUsd - 1 : 0;
  const day = p.dayStartEquityUsd > 0 ? p.equityUsd / p.dayStartEquityUsd - 1 : 0;
  o.write(`NEAR Sentinel status — ${s.source}, as of ${iso(p.at)} UTC`);
  o.write(`  equity ${usd(p.equityUsd)} · cash ${p.balances.USDC.toFixed(2)} USDC · BTC ${p.balances.BTC} · NEAR ${p.balances.NEAR}`);
  o.write(`  today ${pct(day)} (stop new entries at −${L.dailyLossPct}%) · from peak ${usd(p.peakEquityUsd)} ${pct(dd)} (kill switch at −${L.maxDrawdownPct}%)`);
  o.write(`  entries today ${p.entriesToday}/${L.maxEntriesPerDay} · kill switch ${p.killSwitch ? "ON — owner reset required" : "off"}`);
  const cds = Object.entries(p.cooldownUntil).filter(([, t]) => t !== undefined && t > p.at);
  o.write(`  cooldowns ${cds.length ? cds.map(([a, t]) => `${a} until ${iso(t!)}`).join(", ") : "none"}`);
  if (!p.positions.length) o.write("  positions none");
  for (const x of p.positions) {
    o.write(`  position ${x.asset} ${x.quantity} @ ${x.entryPrice} (since ${iso(x.entryBarTime)}) · stop ${x.stopPrice.toPrecision(6)} · TP1 ${x.takeProfit[0].toPrecision(6)}${x.tp1Hit ? " (hit)" : ""} · TP2 ${x.takeProfit[1].toPrecision(6)}`);
  }
  return 0;
}

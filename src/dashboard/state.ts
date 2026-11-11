/**
 * What the live dashboard shows (`pnpm dashboard`): a read-only snapshot of the agent, built from the files the
 * agent writes (state/, records/) and, when configured, a few on-chain views (guardrail policy and day usage,
 * the live agent's NEAR Intents balances, each recent decision's anchor). Nothing here writes or signs.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { heartbeatAlert, readHeartbeat, type Heartbeat } from "../execution/watcher.ts";
import type { DecisionRecord, PortfolioSnapshot } from "../types.ts";

export interface ModeView {
  readonly mode: "paper" | "live";
  readonly configured: boolean;
  readonly running: boolean;
  readonly heartbeat?: Heartbeat;
  readonly alert: string | null;
  readonly portfolio?: PortfolioSnapshot;
  readonly lastBarTime?: number;
  readonly savedAt?: number;
}

export interface GuardrailView {
  readonly network: string;
  readonly contract: string;
  readonly agent: string;
  readonly policy?: { readonly paused: boolean; readonly max_trades_per_day: number; readonly owner: string; readonly agent: string };
  readonly dayUsage?: { readonly trades: number };
  readonly decisionCount?: number;
  readonly error?: string;
}

export interface DecisionView {
  readonly hash: string;
  readonly at: number;
  readonly barTime: number;
  readonly asset: string;
  readonly action: string;
  readonly reason?: string;
  readonly detail: string;
  readonly llm?: string;
  readonly anchor?: { readonly network: string; readonly contract: string; readonly seq: number; readonly at: number } | null;
  /** What the agent looked at and checked, for the detail panel. */
  readonly signals: readonly { readonly kind: string; readonly direction: string; readonly strength: number; readonly evidence: Readonly<Record<string, number>> }[];
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly value?: number; readonly limit?: number; readonly detail?: string }[];
  readonly review?: { readonly model: string; readonly verdict: string; readonly sizeMultiplier: number; readonly rationale: string; readonly fallbackReason?: string; readonly attestation?: string };
  readonly agentVersion?: string;
}

/** What the agent looked at on its latest bar, for the scan view. */
export interface ScanView {
  readonly hash: string;
  readonly asset: string;
  readonly barTime: number;
  readonly action: string;
  readonly reason?: string;
  readonly signals: readonly { readonly kind: string; readonly direction: string }[];
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
  readonly llm?: string;
  readonly anchored?: boolean;
}

export interface DashboardState {
  readonly at: number;
  /** Last NEAR 1h candles from the agent's archive: [openTime, open, high, low, close]. */
  readonly chart: readonly (readonly [number, number, number, number, number])[];
  /** The latest NEAR decision and the latest decision overall (the scan view shows NEAR first). */
  readonly scan?: ScanView;
  readonly modes: readonly ModeView[];
  readonly guardrails: readonly GuardrailView[];
  readonly liveWallet?: { readonly account: string; readonly usdc: number; readonly near: number; readonly btc: number; readonly error?: string };
  readonly prices?: { readonly NEAR?: number; readonly BTC?: number; readonly at: number };
  readonly decisions: readonly DecisionView[];
  readonly counts: { readonly total: number; readonly trades: number; readonly rejects: number; readonly holds: number };
}

/** On-chain reads, injected (tests use fakes; the server uses near-kit). */
export interface ChainReader {
  view<T>(network: "testnet" | "mainnet", contract: string, method: string, args: object): Promise<T | undefined>;
}

const readJson = async <T>(p: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
};

async function mode(root: string, m: "paper" | "live", now: number, configured: boolean): Promise<ModeView> {
  const dir = join(root, "state", m);
  const hb = await readHeartbeat(join(dir, "heartbeat.json"));
  const st = await readJson<{ savedAt: number; portfolio: PortfolioSnapshot; lastBarTime?: number }>(join(dir, "portfolio.json"));
  const alert = hb || st ? heartbeatAlert(hb, now) : null;
  return {
    mode: m, configured, running: !!hb && now - hb.at <= 5 * 60_000, alert,
    ...(hb ? { heartbeat: hb } : {}),
    ...(st ? { portfolio: st.portfolio, savedAt: st.savedAt, ...(st.lastBarTime !== undefined ? { lastBarTime: st.lastBarTime } : {}) } : {}),
  };
}

export function describeDecision(r: DecisionRecord): string {
  const o = r.outcome;
  if (o.action === "TRADE") {
    const p = o.proposal;
    return p.kind === "ENTRY" ? `buy $${p.notionalUsd.toFixed(2)} of ${p.asset} at ${p.referencePrice.toPrecision(6)}, stop ${p.stopPrice.toPrecision(6)}` : `sell ${Math.round(p.fraction * 100)}% of ${p.asset} (${p.reason})`;
  }
  return o.reason;
}

/** The `limit` most recent records (by file time), newest first. */
async function recentRecords(dir: string, limit: number): Promise<{ hash: string; rec: DecisionRecord; mtime: number }[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  } catch {
    return [];
  }
  const withTime = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(join(dir, f))).mtimeMs })));
  withTime.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f, mtime } of withTime.slice(0, limit)) {
    const rec = await readJson<DecisionRecord>(join(dir, f));
    if (rec) out.push({ hash: f.slice(0, 64), rec, mtime });
  }
  return out;
}

export interface BuildOptions {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly chain?: ChainReader;
  readonly now?: number;
  readonly limit?: number;
  /** Anchor lookups already done (hash → result), to avoid asking the chain every refresh. */
  readonly anchorCache?: Map<string, DecisionView["anchor"]>;
}

export async function buildDashboardState(o: BuildOptions): Promise<DashboardState> {
  const now = o.now ?? Date.now();
  const e = o.env;
  const modes = [await mode(o.root, "paper", now, true), await mode(o.root, "live", now, !!(e["AGENT_ACCOUNT"] && e["LIVE_NEAR_GUARDRAIL_CONTRACT"]))];

  const guardrailCfg = [
    { prefix: "", network: (e["NEAR_NETWORK"] ?? "testnet") as "testnet" | "mainnet" },
    { prefix: "LIVE_", network: (e["LIVE_NEAR_NETWORK"] ?? "mainnet") as "testnet" | "mainnet" },
  ].filter((g) => e[`${g.prefix}NEAR_GUARDRAIL_CONTRACT`]);
  const guardrails: GuardrailView[] = [];
  for (const g of guardrailCfg) {
    const contract = e[`${g.prefix}NEAR_GUARDRAIL_CONTRACT`]!;
    const base = { network: g.network, contract, agent: e[`${g.prefix}NEAR_AGENT_ACCOUNT`] ?? "" };
    if (!o.chain) {
      guardrails.push(base);
      continue;
    }
    try {
      const [policy, dayUsage, decisionCount] = await Promise.all([
        o.chain.view<GuardrailView["policy"]>(g.network, contract, "get_policy", {}),
        o.chain.view<GuardrailView["dayUsage"]>(g.network, contract, "get_day_usage", {}),
        o.chain.view<number>(g.network, contract, "get_decision_count", {}),
      ]);
      guardrails.push({ ...base, ...(policy ? { policy } : {}), ...(dayUsage ? { dayUsage } : {}), ...(decisionCount !== undefined ? { decisionCount } : {}) });
    } catch (err) {
      guardrails.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let liveWallet: DashboardState["liveWallet"];
  const account = e["AGENT_ACCOUNT"];
  if (account && o.chain) {
    try {
      const ids = ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:wrap.near", "nep141:nbtc.bridge.near"];
      const b = (await o.chain.view<string[]>("mainnet", "intents.near", "mt_batch_balance_of", { account_id: account, token_ids: ids })) ?? ["0", "0", "0"];
      liveWallet = { account, usdc: Number(BigInt(b[0] ?? "0")) / 1e6, near: Number(BigInt(b[1] ?? "0")) / 1e24, btc: Number(BigInt(b[2] ?? "0")) / 1e8 };
    } catch (err) {
      liveWallet = { account, usdc: 0, near: 0, btc: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const hbs = modes.map((m) => m.heartbeat).filter((h): h is Heartbeat => !!h?.prices).sort((a, b) => b.at - a.at);
  const prices = hbs[0]?.prices ? { ...hbs[0].prices, at: hbs[0].at } : undefined;

  // the agent's own recent decisions (demo replays in the same folder decide on old bars: left out)
  const recs = (await recentRecords(join(o.root, "records"), (o.limit ?? 40) * 3)).filter((r) => now - r.rec.inputs.now <= 7 * 86_400_000).slice(0, o.limit ?? 40);
  const cache = o.anchorCache ?? new Map();
  const decisions: DecisionView[] = [];
  for (const { hash, rec } of recs) {
    let anchor = cache.get(hash);
    if (anchor === undefined && o.chain && guardrailCfg.length) {
      anchor = null;
      for (const g of guardrailCfg) {
        const contract = e[`${g.prefix}NEAR_GUARDRAIL_CONTRACT`]!;
        const a = await o.chain.view<{ seq: number; recorded_at_ms: number }>(g.network, contract, "get_decision", { hash }).catch(() => undefined);
        if (a) {
          anchor = { network: g.network, contract, seq: a.seq, at: a.recorded_at_ms };
          break;
        }
      }
      cache.set(hash, anchor);
    }
    const o2 = rec.outcome;
    decisions.push({
      hash, at: rec.inputs.now, barTime: rec.barTime, asset: rec.asset, action: o2.action, ...(o2.action !== "TRADE" ? { reason: o2.reason } : {}),
      detail: describeDecision(rec), ...(rec.llm ? { llm: `${rec.llm.verdict} × ${rec.llm.sizeMultiplier}` } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
      signals: (rec.signals ?? []).map((x) => ({ kind: x.kind, direction: x.direction, strength: x.strength, evidence: x.evidence ?? {} })),
      checks: (rec.checks ?? []).map((c) => ({ name: c.name, ok: c.ok, ...(c.value !== undefined ? { value: c.value } : {}), ...(c.limit !== undefined ? { limit: c.limit } : {}), ...(c.detail ? { detail: c.detail } : {}) })),
      ...(rec.llm ? { review: { model: rec.llm.model, verdict: rec.llm.verdict, sizeMultiplier: rec.llm.sizeMultiplier, rationale: rec.llm.rationale, ...(rec.llm.fallbackReason ? { fallbackReason: rec.llm.fallbackReason } : {}), ...(rec.llm.attestation ? { attestation: rec.llm.attestation.status } : {}) } } : {}),
      ...(rec.agentVersion ? { agentVersion: rec.agentVersion } : {}),
    });
  }
  decisions.sort((a, b) => b.at - a.at);

  const latest = recs.filter((r) => now - r.rec.inputs.now <= 7 * 86_400_000).sort((a, b) => b.rec.inputs.now - a.rec.inputs.now || (a.rec.asset === "NEAR" ? -1 : 1))[0];
  let scan: ScanView | undefined;
  if (latest) {
    const r = latest.rec;
    const a = cache.get(latest.hash);
    scan = {
      hash: latest.hash, asset: r.asset, barTime: r.barTime, action: r.outcome.action,
      ...(r.outcome.action !== "TRADE" ? { reason: r.outcome.reason } : {}),
      signals: r.signals.map((x) => ({ kind: x.kind, direction: x.direction })),
      checks: r.checks.map((c) => ({ name: c.name, ok: c.ok })),
      ...(r.llm ? { llm: `${r.llm.verdict} × ${r.llm.sizeMultiplier}` } : {}),
      ...(a !== undefined ? { anchored: a !== null } : {}),
    };
  }
  const archive = await readJson<{ candles: { openTime: number; open: number; high: number; low: number; close: number }[] }>(join(o.root, "data", "candles", "NEARUSDT-1h.json"));
  const chart = (archive?.candles ?? []).slice(-48).map((c) => [c.openTime, c.open, c.high, c.low, c.close] as const);
  const counts = {
    total: decisions.length,
    trades: decisions.filter((d) => d.action === "TRADE").length,
    rejects: decisions.filter((d) => d.action === "REJECT").length,
    holds: decisions.filter((d) => d.action === "HOLD").length,
  };
  return { at: now, chart, ...(scan ? { scan } : {}), modes, guardrails, ...(liveWallet ? { liveWallet } : {}), ...(prices ? { prices } : {}), decisions, counts };
}

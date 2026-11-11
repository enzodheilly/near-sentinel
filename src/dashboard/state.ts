/**
 * What the live dashboard shows (`pnpm dashboard`): a read-only snapshot of the agent, built from the files the
 * agent writes (state/, records/) and, when configured, a few on-chain views (guardrail policy and day usage,
 * the live agent's NEAR Intents balances, each recent decision's anchor). Nothing here writes or signs.
 */

import { readdir, readFile } from "node:fs/promises";
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

/** A real swap the live agent's key signed on mainnet, from the evidence files in test/live/recorded/. */
export interface SwapView {
  readonly at: number;
  readonly side: "buy" | "sell";
  readonly status: string;
  readonly intentHash: string;
  readonly tx?: string;
  readonly amountIn: number;
  readonly assetIn: string;
  readonly amountOut: number;
  readonly assetOut: string;
  readonly price: number;
  readonly settledMs?: number;
  readonly file: string;
}

/** How far the last 7 days of decisions got: where each one stopped. */
export interface FunnelView {
  readonly days: number;
  readonly total: number;
  /** Decisions that stopped at each stage, in order. */
  readonly stopped: { readonly breakout: number; readonly confirm: number; readonly risk: number; readonly llm: number; readonly policy: number };
  readonly trades: number;
  /** Most frequent reasons inside the confirmation and risk stages. */
  readonly reasons: Readonly<Record<string, number>>;
}

/** The stage a decision stopped at, from its outcome. */
export function funnelStage(action: string, reason?: string): keyof FunnelView["stopped"] | "trade" {
  if (action === "TRADE") return "trade";
  if (reason === "NO_SIGNAL") return "breakout";
  if (reason === "INSUFFICIENT_CONFLUENCE" || reason === "VETO_RSI_EXHAUSTION" || reason === "VETO_BTC_REGIME") return "confirm";
  if (reason === "LLM_VETO") return "llm";
  if (reason === "POLICY_DENIED") return "policy";
  return "risk";
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
  readonly swaps: readonly SwapView[];
  readonly funnel: FunnelView;
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
  const st = await readJson<{ savedAt: number; portfolio: PortfolioSnapshot; lastBarTime?: number; halted?: string }>(join(dir, "portfolio.json"));
  const alert = st?.halted ? `Trading halted: ${st.halted}` : hb || st ? heartbeatAlert(hb, now) : null;
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

// records are content-addressed (the file name is their hash): once parsed, a file never needs reading again
const recordCache = new Map<string, DecisionRecord | null>();

/**
 * The `limit` most recent records by decision time, newest first. Not by file time: `pnpm demo` writes hundreds of
 * replayed decisions dated months back, and they must not push the agent's own out of view.
 */
async function recentRecords(dir: string, limit: number): Promise<{ hash: string; rec: DecisionRecord }[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
  } catch {
    return [];
  }
  const out: { hash: string; rec: DecisionRecord }[] = [];
  for (const f of files) {
    const p = join(dir, f);
    if (!recordCache.has(p)) recordCache.set(p, (await readJson<DecisionRecord>(p)) ?? null);
    const rec = recordCache.get(p);
    if (rec) out.push({ hash: f.slice(0, 64), rec });
  }
  return out.sort((a, b) => b.rec.inputs.now - a.rec.inputs.now).slice(0, limit);
}

/** Swap evidence written by scripts/swap-once.ts (one file per swap), oldest first. */
export async function readSwaps(dir: string): Promise<SwapView[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  type Evidence = { at?: string; account?: string; direction?: string; status?: { updatedAt?: string }; report?: { status: string; intentHash?: string; txRefs?: string[]; fill?: { quantityIn: number; quantityOut: number; price: number } } };
  const out: SwapView[] = [];
  for (const f of files) {
    const e = await readJson<Evidence>(join(dir, f));
    const r = e?.report;
    if (!e?.at || !e.direction || !r?.intentHash || !r.fill) continue;
    const sell = e.direction.startsWith("sell");
    const at = Date.parse(e.at), done = e.status?.updatedAt ? Date.parse(e.status.updatedAt) : NaN;
    out.push({
      at, side: sell ? "sell" : "buy", status: r.status, intentHash: r.intentHash, ...(r.txRefs?.[1] ? { tx: r.txRefs[1] } : {}),
      amountIn: r.fill.quantityIn, assetIn: sell ? "NEAR" : "USDC", amountOut: r.fill.quantityOut, assetOut: sell ? "USDC" : "NEAR", price: r.fill.price,
      ...(Number.isFinite(done) ? { settledMs: done - at } : {}), file: f,
    });
  }
  return out.sort((a, b) => a.at - b.at);
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
  const swaps = await readSwaps(join(o.root, "test", "live", "recorded"));
  // the funnel counts every decision of the last 7 days (two assets, hourly: about 340), not just the log's 40
  const week = (await recentRecords(join(o.root, "records"), 1000)).filter((r) => now - r.rec.inputs.now <= 7 * 86_400_000);
  const stopped = { breakout: 0, confirm: 0, risk: 0, llm: 0, policy: 0 };
  const reasons: Record<string, number> = {};
  let trades = 0;
  for (const { rec } of week) {
    const reason = rec.outcome.action === "TRADE" ? undefined : rec.outcome.reason;
    const st = funnelStage(rec.outcome.action, reason);
    if (st === "trade") trades++;
    else stopped[st]++;
    if (reason && reason !== "NO_SIGNAL") reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const funnel: FunnelView = { days: 7, total: week.length, stopped, trades, reasons };
  return { at: now, chart, swaps, funnel, ...(scan ? { scan } : {}), modes, guardrails, ...(liveWallet ? { liveWallet } : {}), ...(prices ? { prices } : {}), decisions, counts };
}

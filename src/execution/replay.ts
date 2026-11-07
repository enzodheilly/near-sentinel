/**
 * Replay mode (ARCHITECTURE.md §7): frozen fixture candles, fixture quotes, simulated fills. Fully offline and
 * deterministic, so every record it produces can be verified by anyone with the fixtures.
 *
 * - Quote: the reference price of the proposal, moved against the trade by `slippageBps` (0 by default),
 *   received `quoteDelayMs` after the bar's close. Amounts in base units, like a 1Click quote.
 * - Fill: exactly at the quote. Balances are simulated in base units. A full exit (fraction 1) sells the whole
 *   balance held when the position's float quantity rounds a few base units above it (a live executor must
 *   do the same: the last exit sells what is there, not what float arithmetic says).
 * - LLM: no model is called in replay. The stage is filled by a stub that approves and says so in its rationale;
 *   the veto itself runs in paper and live modes (#34).
 * - Fees: the partner-JWT schedule (0.20%) is assumed, as configured for paper and live.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { FixtureSet } from "../data/fixtures.ts";
import { runTick, type Decision, type EngineDeps, type TickMarket } from "../decision/engine.ts";
import { recorder, type RecordMeta } from "../decision/record.ts";
import {
  INTERVAL_MS,
  type AssetSymbol,
  type Candle,
  type ExecutionReport,
  type Executor,
  type LlmReview,
  type PortfolioSnapshot,
  type Quote,
  type TradableAsset,
  type TradeProposal,
} from "../types.ts";
import { MemoryKeys, type ExecutedKeys } from "./idempotency.ts";

const H = INTERVAL_MS["1h"];

export interface ReplayOptions {
  readonly slippageBps?: number;
  readonly quoteDelayMs?: number;
}

const toBase = (x: number, decimals: number): bigint => {
  // 9 significant decimals then scale: exact enough for 24-decimal NEAR without float overflow of 10^24
  const micro = BigInt(Math.round(x * 1e9));
  return decimals >= 9 ? micro * 10n ** BigInt(decimals - 9) : micro / 10n ** BigInt(9 - decimals);
};
const toHuman = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

export class ReplayExecutor implements Executor {
  readonly mode = "replay" as const;
  private readonly cfg: RiskConfig;
  private readonly clock: () => number;
  private readonly slip: number;
  private readonly bal: Record<AssetSymbol, bigint>;

  constructor(cfg: RiskConfig, start: Readonly<Record<AssetSymbol, number>>, clock: () => number, opts: ReplayOptions = {}) {
    this.cfg = cfg;
    this.clock = clock;
    this.slip = (opts.slippageBps ?? 0) / 10_000;
    this.bal = {
      USDC: toBase(start.USDC, cfg.assets.USDC.decimals),
      BTC: toBase(start.BTC, cfg.assets.BTC.decimals),
      NEAR: toBase(start.NEAR, cfg.assets.NEAR.decimals),
    };
  }

  async quote(p: TradeProposal, slippageBps: number): Promise<Quote> {
    const A = this.cfg.assets;
    const buy = p.kind === "ENTRY";
    const price = p.referencePrice * (buy ? 1 + this.slip : 1 - this.slip);
    const qty = buy ? p.notionalUsd / price : p.quantity;
    const usd = buy ? p.notionalUsd : p.quantity * price;
    const [origin, dest] = buy ? ([A.USDC, A[p.asset]] as const) : ([A[p.asset], A.USDC] as const);
    let amountIn = toBase(buy ? usd : qty, origin.decimals);
    let amountOut = toBase(buy ? qty : usd, dest.decimals);
    if (!buy && p.fraction === 1) {
      const held = this.bal[p.asset];
      const dust = toBase(qty * 1e-6, origin.decimals); // rounding, not a real shortfall
      if (amountIn > held && amountIn - held <= dust) {
        amountOut = (amountOut * held) / amountIn;
        amountIn = held;
      }
    }
    const now = this.clock();
    return {
      originAsset: origin.assetId, destinationAsset: dest.assetId, amountIn, amountOut,
      minAmountOut: (amountOut * BigInt(10_000 - slippageBps)) / 10_000n,
      deadline: new Date(now + this.cfg.execution.deadlineSec * 1000).toISOString(),
      receivedAt: now,
      raw: { source: "fixture", price, slippageBps },
    };
  }

  async execute(p: TradeProposal, q: Quote): Promise<ExecutionReport> {
    const A = this.cfg.assets;
    const sym = (id: string): AssetSymbol => (Object.keys(A) as AssetSymbol[]).find((k) => A[k].assetId === id) as AssetSymbol;
    const from = sym(q.originAsset);
    const to = sym(q.destinationAsset);
    if (this.bal[from] < q.amountIn) {
      return { mode: "replay", status: "FAILED", quote: q, txRefs: [], error: `simulated balance ${from} too low` };
    }
    this.bal[from] -= q.amountIn;
    this.bal[to] += q.amountOut;
    const quantityIn = toHuman(q.amountIn, A[from].decimals);
    const quantityOut = toHuman(q.amountOut, A[to].decimals);
    const price = p.kind === "ENTRY" ? quantityIn / quantityOut : quantityOut / quantityIn;
    return { mode: "replay", status: "SIMULATED", quote: q, txRefs: [], fill: { quantityIn, quantityOut, price } };
  }

  async balances(): Promise<Readonly<Record<AssetSymbol, bigint>>> {
    return { ...this.bal };
  }
}

export const REPLAY_LLM_RATIONALE = "Replay mode: no model is called; the LLM veto runs in paper and live modes.";

export const replayLlm = async (cfg: RiskConfig): Promise<LlmReview> => ({
  model: `none (replay; live model ${cfg.llm.model})`, verdict: "approve", sizeMultiplier: 1, rationale: REPLAY_LLM_RATIONALE,
});

export interface ReplayRun {
  readonly name: string;
  readonly asset: TradableAsset;
  readonly decisions: readonly Decision[];
  readonly hashes: readonly string[]; // records written to `dir`, one per decision, same order
  readonly executions: readonly { readonly barTime: number; readonly proposal: TradeProposal; readonly report: ExecutionReport }[];
  readonly start: PortfolioSnapshot;
  readonly end: PortfolioSnapshot;
  readonly bars: number;
}

export interface ReplayParams {
  readonly set: FixtureSet;
  readonly cfg: RiskConfig;
  readonly meta: RecordMeta;
  /** Where records are written. */
  readonly dir: string;
  readonly startUsdc?: number;
  readonly keys?: ExecutedKeys;
  readonly options?: ReplayOptions;
  /** Number of bars to replay from the first evaluable bar (default: to the end of the fixture). */
  readonly bars?: number;
  /** LLM stage; defaults to the replay stub (no model called). Paper mode passes the attested veto. */
  readonly llm?: EngineDeps["llm"];
}

/**
 * How much of each demo scenario is replayed. An entry runs to the end of its window (entry → TP1 → TP2);
 * a refusal runs the refused bar and the next 24 h, to show the agent staying out (later bars of the window
 * hold unrelated setups).
 */
export const scenarioBars = (set: FixtureSet): number | undefined => (set.expected.decision === "REJECT" ? 25 : undefined);

/** Runs the engine bar by bar over a fixture set, from the first evaluable bar to the last. */
export async function runReplay({ set, cfg, meta, dir, startUsdc = 1000, keys = new MemoryKeys(), options = {}, bars, llm }: ReplayParams): Promise<ReplayRun> {
  const near = set.series["NEARUSDT"]?.["1h"]?.candles ?? [];
  const btc = set.series["BTCUSDT"]?.["1h"]?.candles ?? [];
  const btc4h = set.series["BTCUSDT"]?.["4h"]?.candles ?? [];
  const first = cfg.warmupBars.exec;
  if (near.length <= first) throw new Error(`replay ${set.manifest.name}: needs more than ${first} NEAR 1h candles, has ${near.length}`);

  let now = near[first]!.openTime + H;
  const clock = () => now;
  const executor = new ReplayExecutor(cfg, { USDC: startUsdc, BTC: 0, NEAR: 0 }, clock, options);
  const start: PortfolioSnapshot = {
    at: near[first]!.openTime, balances: { USDC: startUsdc, BTC: 0, NEAR: 0 }, positions: [], equityUsd: startUsdc,
    peakEquityUsd: startUsdc, dayStartEquityUsd: startUsdc, entriesToday: 0, cooldownUntil: {}, killSwitch: false,
  };
  let portfolio = start;
  const decisions: Decision[] = [];
  const hashes: string[] = [];
  const executions: { barTime: number; proposal: TradeProposal; report: ExecutionReport }[] = [];

  const last = bars === undefined ? near.length : Math.min(near.length, first + bars);
  for (let t = first; t < last; t++) {
    const barTime = near[t]!.openTime;
    now = barTime + H + (options.quoteDelayMs ?? 30_000);
    const upTo = (cs: readonly Candle[]) => cs.filter((c) => c.openTime <= barTime);
    const market: TickMarket = { candles1h: { NEAR: upTo(near), BTC: upTo(btc) }, btc4h };
    const rec = recorder(dir, market, meta);
    const deps: EngineDeps = {
      authenticated: true,
      clock,
      balances: () => executor.balances(),
      quote: (p, bps) => executor.quote(p, bps),
      execute: (p, q) => executor.execute(p, q),
      llm: llm ?? (() => replayLlm(cfg)),
      onDecision: rec.sink,
    };
    const r = await runTick({ barTime, market, portfolio, executed: keys }, deps, cfg);
    portfolio = r.portfolio;
    decisions.push(...r.decisions);
    hashes.push(...rec.hashes);
    executions.push(...r.executions.map((e) => ({ barTime, ...e })));
  }
  return { name: set.manifest.name, asset: set.asset, decisions, hashes, executions, start, end: portfolio, bars: last - first };
}

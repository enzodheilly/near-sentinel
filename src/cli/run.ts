/**
 * `pnpm paper`: the agent running on the live market with zero funds at risk (ARCHITECTURE.md §7).
 *
 * - One tick per closed 1h candle, a few seconds after the close (the bar must be final at the source).
 *   A bar is never ticked twice, including across restarts (`lastBarTime` is saved with the portfolio).
 * - Between ticks the price watcher guards stops and targets every 60 s and writes the heartbeat.
 * - Ticks and watcher steps run one at a time, through a single queue: they never see half of each other.
 * - Every decision is recorded (records/) before its trade executes; the candles are archived (data/candles)
 *   so `pnpm verify` can recompute paper decisions; the portfolio is saved after every step.
 * - SIGINT / SIGTERM: stop scheduling, let the step in progress finish (record, fill, state), then exit.
 *   Combined with the idempotency registry, an interruption never leaves a half-recorded trade.
 *
 * `pnpm live --yes-real-funds` (#47) runs the same loop with the live executor: real swaps inside NEAR Intents,
 * signed by the agent's intent key, each decision anchored on chain first (mandatory), and an owner-set cap per
 * trade (LIVE_MAX_NOTIONAL_USD, default $10).
 */

import { dirname, join } from "node:path";
import type { RiskConfig } from "../config/schema.ts";
import { runTick, runWatch, StepAborted, type Decision, type EngineDeps, type TickMarket } from "../decision/engine.ts";
import { recorder, type RecordMeta } from "../decision/record.ts";
import type { ExecutedKeys } from "../execution/idempotency.ts";
import type { HeartbeatSink } from "../execution/watcher.ts";
import { anchorHook, type Anchor } from "../execution/anchor.ts";
import { PriceWatcher } from "../execution/watcher.ts";
import { INTERVAL_MS, type Executor, type PortfolioSnapshot, type TradableAsset, type TradeProposal } from "../types.ts";
import { appendFile, readFile } from "node:fs/promises";
import { configHash } from "../config/schema.ts";
import { defaultRiskConfig } from "../config/default.ts";
import { BinanceClient } from "../data/binance.ts";
import { CandleArchive, MarketFeed, type FeedSnapshot } from "../data/feed.ts";
import { NearAiClient } from "../decision/llm/client.ts";
import { nearAiVeto } from "../decision/llm/veto.ts";
import { FileKeys } from "../execution/idempotency.ts";
import { OneClickClient } from "../execution/oneclick.ts";
import { FileBalanceStore, PaperExecutor } from "../execution/paper.ts";
import { FileHeartbeat } from "../execution/watcher.ts";
import { gitVersion } from "./demo.ts";
import { saveState, type SavedState } from "./status.ts";
import { acquireLock } from "./lock.ts";

const H = INTERVAL_MS["1h"];

export interface RunnerOptions {
  readonly cfg: RiskConfig;
  readonly meta: RecordMeta;
  readonly feed: { snapshot(now: number): Promise<FeedSnapshot> };
  readonly executor: Executor;
  readonly llm: EngineDeps["llm"];
  readonly authenticated: boolean;
  readonly keys: ExecutedKeys;
  readonly prices: () => Promise<Partial<Record<TradableAsset, number>>>;
  readonly heartbeat: HeartbeatSink;
  readonly recordsDir: string;
  readonly statePath: string;
  readonly mode: "paper" | "live";
  /** On-chain anchoring of each decision hash before its trade (mandatory in live mode, optional in paper). */
  readonly anchor?: Anchor;
  readonly clock?: () => number;
  /** After a failed tick, retry this often until the next close (default 60 s). */
  readonly retryMs?: number;
  /** Delay after the candle close before ticking (the source must have the final bar). */
  readonly tickDelayMs?: number;
  readonly write?: (line: string) => void;
}

interface RunnerState extends SavedState {
  readonly lastBarTime?: number;
  /** Set when a swap's outcome is unknown: the agent trades no more until the owner checks it and resumes. */
  readonly halted?: string;
}

export class Runner {
  private readonly o: RunnerOptions;
  private readonly clock: () => number;
  private readonly write: (l: string) => void;
  private portfolio: PortfolioSnapshot;
  private lastBarTime: number | undefined;
  private market: TickMarket | undefined;
  private marketBar: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private failedAttempts = 0;
  private halted: string | undefined;
  private readonly watcher: PriceWatcher;

  private constructor(o: RunnerOptions, portfolio: PortfolioSnapshot, lastBarTime: number | undefined, halted?: string) {
    this.o = o;
    this.halted = halted;
    this.clock = o.clock ?? Date.now;
    this.write = o.write ?? (() => {});
    this.portfolio = portfolio;
    this.lastBarTime = lastBarTime;
    this.watcher = new PriceWatcher({
      pollMs: o.cfg.execution.watcherPollSec * 1000, mode: o.mode, clock: this.clock, prices: o.prices, heartbeat: o.heartbeat,
      onPrices: (prices, at) => this.serial(() => this.watchStep(prices, at)), log: this.write,
    });
  }

  /** Resumes the saved paper portfolio, or starts from the executor's balances (all cash). */
  static async open(o: RunnerOptions): Promise<Runner> {
    let saved: RunnerState | undefined;
    try {
      saved = JSON.parse(await readFile(o.statePath, "utf8")) as RunnerState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${o.statePath}: unreadable state (${e instanceof Error ? e.message : String(e)}); refusing to start on a guess`);
    }
    if (saved) return new Runner(o, saved.portfolio, saved.lastBarTime, saved.halted);
    const b = await o.executor.balances();
    const A = o.cfg.assets;
    const usdc = Number(b.USDC) / 10 ** A.USDC.decimals;
    const now = (o.clock ?? Date.now)();
    const p: PortfolioSnapshot = {
      at: now, balances: { USDC: usdc, BTC: Number(b.BTC) / 10 ** A.BTC.decimals, NEAR: Number(b.NEAR) / 10 ** A.NEAR.decimals }, positions: [],
      equityUsd: usdc, peakEquityUsd: usdc, dayStartEquityUsd: usdc, entriesToday: 0, cooldownUntil: {}, killSwitch: false,
    };
    return new Runner(o, p, undefined);
  }

  get state(): { readonly portfolio: PortfolioSnapshot; readonly lastBarTime: number | undefined; readonly halted: string | undefined } {
    return { portfolio: this.portfolio, lastBarTime: this.lastBarTime, halted: this.halted };
  }

  /** The owner checked the swap whose outcome was unknown (and fixed the state if needed): trading may go on. */
  async resume(): Promise<void> {
    this.halted = undefined;
    await this.save();
  }

  /** When the next tick runs: the next candle close plus the delay. */
  nextTickAt(now: number): number {
    const delay = this.o.tickDelayMs ?? 15_000;
    const close = Math.floor((now - delay) / H) * H + H;
    return close + delay;
  }

  start(): void {
    this.stopping = false;
    this.watcher.start();
    this.scheduleTick(0); // catch up the last closed bar now, then every close
  }

  /** Stops scheduling and waits for the step in progress (and the watcher's) to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.watcher.stop();
    await this.queue.catch(() => {});
    await this.save();
  }

  /** One tick on the last closed bar, if it has not been ticked yet. */
  async tick(): Promise<void> {
    await this.serial(() => this.tickStep());
  }

  /** Next tick at the next close; after a failed tick (data down, anchor failed), retry every minute until it. */
  private scheduleTick(afterMs?: number) {
    if (this.stopping) return;
    const now = this.clock();
    this.timer = setTimeout(() => {
      void this.serial(() => this.tickStep()).then(
        (ok) => {
          const t = this.clock();
          const retry = this.o.retryMs ?? 60_000;
          const nextClose = this.nextTickAt(t) - (this.o.tickDelayMs ?? 15_000);
          if (ok) this.failedAttempts = 0;
          else if (t + retry < nextClose) return this.scheduleTick(retry);
          else if (this.failedAttempts > 0) {
            this.write(`gave up on this bar after ${this.failedAttempts} attempts; next try at the next close`);
            this.failedAttempts = 0;
          }
          this.scheduleTick();
        },
        () => this.scheduleTick(),
      );
    }, afterMs ?? Math.max(0, this.nextTickAt(now) - now));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private deps(market: TickMarket): { deps: EngineDeps; hashes: string[] } {
    const rec = recorder(this.o.recordsDir, market, this.o.meta, this.o.anchor ? anchorHook(this.o.anchor) : undefined);
    const x = this.o.executor;
    return {
      hashes: rec.hashes,
      deps: {
        authenticated: this.o.authenticated, clock: this.clock, balances: () => x.balances(), quote: (p, b) => x.quote(p, b),
        execute: (p, q) => x.execute(p, q), llm: this.o.llm, onDecision: rec.sink,
      },
    };
  }

  /** One tick; false when it must be retried (market data unavailable, or the tick stopped). */
  private async tickStep(): Promise<boolean> {
    if (this.halted) return true;
    const now = this.clock();
    let snap: FeedSnapshot;
    try {
      snap = await this.o.feed.snapshot(now);
    } catch (e) {
      if (this.failedAttempts++ === 0) this.write(`market data unavailable (${e instanceof Error ? e.message : String(e)}); retrying every minute until the next close, the watcher keeps guarding open positions`);
      return false;
    }
    if (this.failedAttempts > 0) this.write(`market data back after ${this.failedAttempts} failed attempt(s)`);
    for (const p of snap.problems) this.write(`data: ${p}`);
    this.market = snap.market;
    this.marketBar = snap.barTime;
    if (snap.barTime === undefined || (this.lastBarTime !== undefined && snap.barTime <= this.lastBarTime)) return true;
    const { deps, hashes } = this.deps(snap.market);
    let r: Awaited<ReturnType<typeof runTick>>;
    try {
      r = await runTick({ barTime: snap.barTime, market: snap.market, portfolio: this.portfolio, executed: this.o.keys }, deps, this.o.cfg);
    } catch (e) {
      // e.g. anchoring failed: the decision that failed was not executed; the next tick retries the bar
      await this.keepExecuted(e, now, snap.market);
      if (e instanceof StepAborted && (await this.haltOnUnknown(e.executions))) return true;
      if (this.failedAttempts++ === 0) this.write(`ALERT tick stopped: ${e instanceof Error ? e.message : String(e)}; ${e instanceof StepAborted && e.executions.length ? `${e.executions.length} trade(s) before it were executed and kept; ` : ""}retrying every minute until the next close`);
      return false;
    }
    this.portfolio = r.portfolio;
    this.lastBarTime = snap.barTime;
    await this.save();
    if (r.pauseContract) await this.pauseContract();
    await this.haltOnUnknown(r.executions);
    const prices: Partial<Record<TradableAsset, number>> = {};
    for (const a of ["NEAR", "BTC"] as const) {
      const c = snap.market.candles1h[a].at(-1)?.close;
      if (c !== undefined) prices[a] = c;
    }
    await this.history(now, prices, r.decisions);
    const bar = new Date(snap.barTime).toISOString().slice(0, 16).replace("T", " ");
    for (const [i, d] of r.decisions.entries()) {
      const o = d.outcome;
      const what = o.action === "TRADE" ? `${o.proposal.kind} ${o.proposal.kind === "ENTRY" ? `$${o.proposal.notionalUsd.toFixed(2)}` : o.proposal.reason}` : `${o.action} ${o.reason}`;
      this.write(`${bar} ${d.asset.padEnd(4)} ${what}${d.llm ? ` · LLM ${d.llm.verdict}` : ""} · record ${hashes[i]?.slice(0, 12) ?? "?"}`);
    }
    for (const a of r.alerts) this.write(`ALERT ${a}`);
    this.write(`${bar} equity $${this.portfolio.equityUsd.toFixed(2)} · positions ${this.portfolio.positions.map((p) => `${p.asset} ${p.quantity.toPrecision(6)}`).join(", ") || "none"}`);
    return true;
  }

  private async watchStep(prices: Partial<Record<TradableAsset, number>>, at: number): Promise<void> {
    if (this.halted || !this.market || this.marketBar === undefined || this.portfolio.positions.length === 0) return;
    const { deps, hashes } = this.deps(this.market);
    let r: Awaited<ReturnType<typeof runWatch>>;
    try {
      r = await runWatch({ barTime: this.marketBar, market: this.market, portfolio: this.portfolio, prices, at, executed: this.o.keys }, deps, this.o.cfg);
    } catch (e) {
      await this.keepExecuted(e, at, this.market);
      if (e instanceof StepAborted) await this.haltOnUnknown(e.executions);
      throw e; // the watcher logs it and polls again
    }
    if (r.decisions.length === 0) return;
    this.portfolio = r.portfolio;
    await this.save();
    await this.haltOnUnknown(r.executions);
    await this.history(at, prices, r.decisions);
    for (const [i, d] of r.decisions.entries()) {
      const o = d.outcome;
      this.write(`watcher ${d.asset} ${o.action === "TRADE" && o.proposal.kind === "EXIT" ? `EXIT ${o.proposal.reason}` : o.action} at ${prices[d.asset]} · record ${hashes[i]?.slice(0, 12) ?? "?"}`);
    }
    for (const a of r.alerts) this.write(`ALERT ${a}`);
  }

  /**
   * One line per tick (and per watcher exit) in history.jsonl next to the state file: equity, balances, the prices
   * they were valued at, and the trades of that step. Read by the dashboard's portfolio tab; never by decisions.
   */
  private async history(t: number, prices: Partial<Record<TradableAsset, number>>, decisions: readonly Decision[]): Promise<void> {
    await this.historyLine(t, prices, decisions.flatMap((d) => (d.outcome.action === "TRADE" ? [d.outcome.proposal] : [])));
  }

  private async historyLine(t: number, prices: Partial<Record<TradableAsset, number>>, proposals: readonly TradeProposal[]): Promise<void> {
    const trades = proposals.map((p) => (p.kind === "ENTRY" ? { asset: p.asset, kind: "ENTRY", notionalUsd: p.notionalUsd, price: p.referencePrice } : { asset: p.asset, kind: "EXIT", reason: p.reason, fraction: p.fraction, price: p.referencePrice }));
    const line = { t, bar: this.lastBarTime, equity: this.portfolio.equityUsd, balances: this.portfolio.balances, prices, ...(trades.length ? { trades } : {}) };
    try {
      await appendFile(join(dirname(this.o.statePath), "history.jsonl"), `${JSON.stringify(line)}\n`);
    } catch (e) {
      this.write(`history not written (${e instanceof Error ? e.message : String(e)}); trading is unaffected`);
    }
  }

  /**
   * A step stopped half-way: the trades it executed before stopping are real (their records were anchored and the
   * swap done), so the portfolio keeps them. Without this the agent would forget a position it holds, or one it sold.
   */
  private async keepExecuted(e: unknown, t: number, market: TickMarket): Promise<void> {
    if (!(e instanceof StepAborted) || e.executions.length === 0) return;
    this.portfolio = e.portfolio;
    await this.save();
    const prices: Partial<Record<TradableAsset, number>> = {};
    for (const a of ["NEAR", "BTC"] as const) {
      const c = market.candles1h[a].at(-1)?.close;
      if (c !== undefined) prices[a] = c;
    }
    const trades = e.executions.filter((x) => x.report.fill).map((x) => x.proposal);
    await this.historyLine(t, prices, trades);
  }

  /**
   * A swap whose outcome is unknown (sent, no final answer) leaves the portfolio uncertain: trading on would risk
   * an unguarded position or selling twice. Everything stops (ticks and watcher) until the owner checks the intent
   * and restarts with --resume. Saved, so a plain restart does not resume either.
   */
  private async haltOnUnknown(executions: readonly { proposal: TradeProposal; report: { status: string; intentHash?: string; error?: string } }[]): Promise<boolean> {
    const u = executions.find((x) => x.report.status === "UNKNOWN");
    if (!u) return false;
    const p = u.proposal;
    this.halted = `${p.kind} ${p.asset}${p.kind === "EXIT" ? ` ${p.reason}` : ""}: outcome unknown (${u.report.error ?? "no final status"})${u.report.intentHash ? `, intent ${u.report.intentHash}` : ""}`;
    await this.save();
    this.write(`ALERT trading halted: ${this.halted}. Check the intent on the explorer, fix state/ if needed, then restart with --resume.`);
    return true;
  }

  /** Kill switch: pause the guardrail contract (agent key may call `pause`; only the owner can unpause). */
  private async pauseContract(): Promise<void> {
    const a = this.o.anchor;
    if (!a?.pause) {
      this.write("ALERT kill switch: no guardrail contract to pause; entries stay blocked by the agent until the owner resets it");
      return;
    }
    try {
      await a.pause();
      this.write("ALERT kill switch: guardrail contract paused; only the owner can unpause it");
    } catch (e) {
      this.write(`ALERT kill switch: pausing the contract failed (${e instanceof Error ? e.message : String(e)}); entries stay blocked by the agent`);
    }
  }

  private async save() {
    const s: RunnerState = { savedAt: this.clock(), source: this.o.mode, portfolio: this.portfolio, ...(this.lastBarTime !== undefined ? { lastBarTime: this.lastBarTime } : {}), ...(this.halted ? { halted: this.halted } : {}) };
    await saveState(this.o.statePath, s);
  }
}

/** Paper file layout under the repo root (all git-ignored except records/). */
export const paperPaths = (root: string) => ({
  state: join(root, "state", "paper", "portfolio.json"),
  balances: join(root, "state", "paper", "balances.json"),
  keys: join(root, "state", "paper", "executed.jsonl"),
  heartbeat: join(root, "state", "paper", "heartbeat.json"),
  candles: join(root, "data", "candles"),
  records: join(root, "records"),
});

/** `pnpm paper`: wires the real feed, 1Click dry quotes and the attested veto, then runs until SIGINT. */
export async function runPaper(o: { root: string; env: NodeJS.ProcessEnv; write: (l: string) => void; signals?: NodeJS.Process }): Promise<number> {
  const cfg = defaultRiskConfig;
  const P = paperPaths(o.root);
  const lock = await acquireLock(join(dirname(P.state), "agent.lock"));
  if ("heldBy" in lock) {
    o.write(`another paper agent is already running from this folder (process ${lock.heldBy}); stop it first (Ctrl+C in its terminal, or kill ${lock.heldBy}). Two agents would decide every bar twice.`);
    return 2;
  }
  try {
    return await paperLoop(o, cfg, P);
  } finally {
    await lock.release();
  }
}

async function paperLoop(o: { root: string; env: NodeJS.ProcessEnv; write: (l: string) => void; signals?: NodeJS.Process }, cfg: RiskConfig, P: ReturnType<typeof paperPaths>): Promise<number> {
  const oneclick = new OneClickClient({ jwt: o.env["ONECLICK_JWT"] });
  const binance = new BinanceClient();
  const key = o.env["NEARAI_API_KEY"];
  if (!oneclick.authenticated) o.write("warning: no ONECLICK_JWT, quotes pay 0.25% more and the cost filter is stricter");
  if (!key) o.write("warning: no NEARAI_API_KEY, every entry gets the LLM fallback (size × 0.5)");
  const llm: EngineDeps["llm"] = key
    ? nearAiVeto(new NearAiClient({ apiKey: key, timeoutMs: cfg.llm.timeoutMs }), cfg)
    : async () => { throw new Error("NEARAI_API_KEY not set"); };
  const executor = await PaperExecutor.open({ cfg, client: oneclick, store: new FileBalanceStore(P.balances) });
  const anchor = await anchorFromEnv(o.env);
  o.write(anchor ? `anchoring every decision in ${o.env["NEAR_GUARDRAIL_CONTRACT"]} on ${o.env["NEAR_NETWORK"] ?? "testnet"} before execution` : "no NEAR_AGENT_KEY / NEAR_GUARDRAIL_CONTRACT: decisions are recorded locally only (not anchored)");
  const symbols: Record<TradableAsset, string> = { BTC: cfg.assets.BTC.marketSymbol, NEAR: cfg.assets.NEAR.marketSymbol };
  const runner = await Runner.open({
    cfg, meta: { agentVersion: gitVersion(o.root), configHash: configHash(cfg) }, mode: "paper",
    feed: new MarketFeed(cfg, binance, new CandleArchive(P.candles)), executor, llm, authenticated: oneclick.authenticated,
    keys: new FileKeys(P.keys), heartbeat: new FileHeartbeat(P.heartbeat), recordsDir: P.records, statePath: P.state, write: o.write,
    ...(anchor ? { anchor } : {}),
    prices: async () => {
      const t = await binance.lastPrices(Object.values(symbols));
      return Object.fromEntries((Object.keys(symbols) as TradableAsset[]).filter((a) => t[symbols[a]] !== undefined).map((a) => [a, t[symbols[a]]!]));
    },
  });
  const s = runner.state;
  o.write(`NEAR Sentinel paper mode · equity $${s.portfolio.equityUsd.toFixed(2)} · ${s.lastBarTime ? `resuming after ${new Date(s.lastBarTime).toISOString()}` : "fresh start"} · Ctrl+C stops cleanly`);
  runner.start();
  const proc = o.signals ?? process;
  return new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) return o.write("still finishing the current step; it will exit right after");
      stopping = true;
      o.write(`${sig}: finishing the current step, then stopping (no trade is left half-recorded)`);
      void runner.stop().then(() => {
        o.write(`stopped · equity $${runner.state.portfolio.equityUsd.toFixed(2)} · state saved to ${P.state}`);
        resolve(0);
      });
    };
    proc.on("SIGINT", () => onSignal("SIGINT"));
    proc.on("SIGTERM", () => onSignal("SIGTERM"));
  });
}

/** The guardrail anchor from .env (restricted agent key from scripts/setup-agent-key.ts), or undefined. */
export async function anchorFromEnv(env: NodeJS.ProcessEnv, prefix = ""): Promise<Anchor | undefined> {
  const key = env[`${prefix}NEAR_AGENT_KEY`];
  const agentId = env[`${prefix}NEAR_AGENT_ACCOUNT`];
  const contractId = env[`${prefix}NEAR_GUARDRAIL_CONTRACT`];
  if (!key || !agentId || !contractId) return undefined;
  const network = (env[`${prefix}NEAR_NETWORK`] ?? "testnet") as "testnet" | "mainnet";
  const { Near } = await import("near-kit");
  const { ContractAnchor } = await import("../execution/anchor.ts");
  const near = new Near({ network, keyStore: { [agentId]: key }, defaultWaitUntil: "FINAL" });
  return new ContractAnchor({ near: near as never, contractId, agentId });
}

/** Live layout: separate from paper so the two never mix. */
export const livePaths = (root: string) => ({ ...paperPaths(root), state: join(root, "state", "live", "portfolio.json"), keys: join(root, "state", "live", "executed.jsonl"), heartbeat: join(root, "state", "live", "heartbeat.json") });

/** `pnpm live --yes-real-funds`: real trades. Refuses to start without anchoring, keys or the explicit flag. */
export async function runLive(o: { root: string; env: NodeJS.ProcessEnv; args: readonly string[]; write: (l: string) => void; signals?: NodeJS.Process }): Promise<number> {
  const cfg = defaultRiskConfig;
  const e = o.env;
  if (!o.args.includes("--yes-real-funds")) {
    o.write("pnpm live trades real funds. Re-run with --yes-real-funds once the owner has agreed.");
    return 2;
  }
  const account = e["AGENT_ACCOUNT"];
  const key = e["AGENT_PRIVATE_KEY"];
  if (!account || !key) {
    o.write("live needs AGENT_ACCOUNT and AGENT_PRIVATE_KEY in .env (scripts/setup-live-key.ts)");
    return 2;
  }
  const anchor = await anchorFromEnv(e, "LIVE_");
  if (!anchor) {
    o.write("live needs the on-chain guardrail on mainnet: LIVE_NEAR_AGENT_ACCOUNT, LIVE_NEAR_GUARDRAIL_CONTRACT, LIVE_NEAR_AGENT_KEY (scripts/deploy-guardrail.ts --network mainnet)");
    return 2;
  }
  const cap = Number(e["LIVE_MAX_NOTIONAL_USD"] ?? 10);
  if (!Number.isFinite(cap) || cap <= 0) {
    o.write(`LIVE_MAX_NOTIONAL_USD must be a plain positive number of dollars (e.g. 10), got "${e["LIVE_MAX_NOTIONAL_USD"]}"; refusing to start without a cap`);
    return 2;
  }
  const P = livePaths(o.root);
  const lock = await acquireLock(join(dirname(P.state), "agent.lock"));
  if ("heldBy" in lock) {
    o.write(`another live agent is already running from this folder (process ${lock.heldBy}); stop it first. Two live agents could trade twice.`);
    return 2;
  }
  try {
  const oneclick = new OneClickClient({ jwt: e["ONECLICK_JWT"] });
  const binance = new BinanceClient();
  const nearaiKey = e["NEARAI_API_KEY"];
  const llm: EngineDeps["llm"] = nearaiKey
    ? nearAiVeto(new NearAiClient({ apiKey: nearaiKey, timeoutMs: cfg.llm.timeoutMs }), cfg)
    : async () => { throw new Error("NEARAI_API_KEY not set"); };
  const { Near } = await import("near-kit");
  const { LiveExecutor } = await import("../execution/live.ts");
  const executor = new LiveExecutor({ cfg, client: oneclick, near: new Near({ network: "mainnet", keyStore: { [account]: key } }) as never, account, maxNotionalUsd: cap });
  const symbols: Record<TradableAsset, string> = { BTC: cfg.assets.BTC.marketSymbol, NEAR: cfg.assets.NEAR.marketSymbol };
  const runner = await Runner.open({
    cfg, meta: { agentVersion: gitVersion(o.root), configHash: configHash(cfg) }, mode: "live",
    feed: new MarketFeed(cfg, binance, new CandleArchive(P.candles)), executor, llm, authenticated: oneclick.authenticated, anchor,
    keys: new FileKeys(P.keys), heartbeat: new FileHeartbeat(P.heartbeat), recordsDir: P.records, statePath: P.state, write: o.write,
    prices: async () => {
      const t = await binance.lastPrices(Object.values(symbols));
      return Object.fromEntries((Object.keys(symbols) as TradableAsset[]).filter((a) => t[symbols[a]] !== undefined).map((a) => [a, t[symbols[a]]!]));
    },
  });
  if (runner.state.halted) {
    if (!o.args.includes("--resume")) {
      o.write(`trading is halted: ${runner.state.halted}. Check it first, then re-run with --resume.`);
      return 2;
    }
    await runner.resume();
    o.write("resumed by the owner after a halt");
  }
  o.write(`NEAR Sentinel LIVE · ${account} · cap $${cap}/trade · anchoring in ${e["LIVE_NEAR_GUARDRAIL_CONTRACT"]} (${e["LIVE_NEAR_NETWORK"] ?? "mainnet"}) · equity $${runner.state.portfolio.equityUsd.toFixed(2)} · Ctrl+C stops cleanly`);
  runner.start();
  const proc = o.signals ?? process;
  return await new Promise<number>((resolve) => {
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) return;
      stopping = true;
      o.write(`${sig}: finishing the current step, then stopping`);
      void runner.stop().then(() => resolve(0));
    };
    proc.on("SIGINT", () => onSignal("SIGINT"));
    proc.on("SIGTERM", () => onSignal("SIGTERM"));
  });
  } finally {
    await lock.release();
  }
}

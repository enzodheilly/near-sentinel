/**
 * Decision engine: one tick per closed 1h candle (RISK_ENGINE.md §10, ARCHITECTURE.md §6).
 *
 *   1. Data: the series known at the close of the bar; freshness feeds STALE_DATA.
 *   2. Portfolio: equity at the last closes, peak, day roll; the kill switch is applied first.
 *   3. Open positions, BTC then NEAR: exit machine → quote → §7 checks (exits re-quote once) → execute.
 *      A STOP starts the cooldown. An exit that stays stuck pauses entries for this tick and raises an alert.
 *   4. Portfolio limits (§6). If one blocks, every asset gets a HOLD with that reason.
 *   5. Entries, BTC then NEAR: signals → convergence → stop → size (caps) → quote → §7 checks → cost filter
 *      (§5.5, measured slippage) → LLM veto (§8) → TRADE. On `reduce` the size is halved after every cap, then
 *      quoted and checked again (a new quote for a new amount; still never a retry of a failed entry quote).
 *   6. Every decision (TRADE, REJECT, HOLD, exits included) is handed to `onDecision` BEFORE execution, which
 *      is where the record is built, hashed and anchored (#26). Then the trade executes.
 *
 * Executor, LLM, clock and the decision sink are injected; nothing here touches the network.
 * Same tick replayed with the same idempotency set → every trade is refused as DUPLICATE, never re-executed.
 */

import type { RiskConfig } from "../config/schema.ts";
import { computeSignals } from "../signals/index.ts";
import { atr as atrSeries } from "../signals/indicators/atr.ts";
import {
  INTERVAL_MS,
  LLM_SIZE_MULTIPLIER,
  idempotencyKey,
  type AssetSymbol,
  type Candle,
  type CheckResult,
  type DecisionOutcome,
  type EntryProposal,
  type ExecutionReport,
  type ExitProposal,
  type LlmReview,
  type PortfolioSnapshot,
  type Position,
  type Quote,
  type RejectReason,
  type Signal,
  type TradableAsset,
  type TradeProposal,
} from "../types.ts";
import { quoteAndCheck, runChecks, type CheckContext, type CheckedQuote } from "./checks.ts";
import { evaluateConvergence } from "./convergence.ts";
import { costFilter } from "./costs.ts";
import { manageExit } from "./exits.ts";
import { applyKillSwitch, entryGate, recordEntry, rollPortfolio, startCooldown, type SeriesFreshness } from "./limits.ts";
import { equityUsd, placeStop, sizePosition, targets } from "./sizing.ts";

export const ASSET_ORDER: readonly TradableAsset[] = ["BTC", "NEAR"];

export interface TickMarket {
  /** 1h candles of each asset, closed ones only, oldest first. */
  readonly candles1h: Readonly<Record<TradableAsset, readonly Candle[]>>;
  /** BTC 4h candles (closed or not: the signal engine reads only those closed by the bar's close). */
  readonly btc4h: readonly Candle[];
}

export interface TickInput {
  /** openTime of the 1h bar that just closed. */
  readonly barTime: number;
  readonly market: TickMarket;
  readonly portfolio: PortfolioSnapshot;
  /** Idempotency keys of trades already executed. Updated in place on every fill. */
  readonly executed: Set<string>;
}

/** Numbers and fixed fields only (§8): no external free text reaches the model. */
export interface LlmContext {
  readonly asset: TradableAsset;
  readonly notionalUsd: number;
  readonly referencePrice: number;
  readonly stopPrice: number;
  readonly takeProfit: readonly [number, number];
  readonly signals: readonly Pick<Signal, "kind" | "direction" | "strength" | "evidence">[];
  readonly last24Closes: readonly number[];
  readonly dayPnlPct: number;
  readonly openExposureUsd: number;
}

export interface EngineDeps {
  readonly quote: (p: TradeProposal, slippageBps: number) => Promise<Quote>;
  readonly execute: (p: TradeProposal, q: Quote) => Promise<ExecutionReport>;
  /** Balances in the Intents contract, base units. */
  readonly balances: () => Promise<Readonly<Record<AssetSymbol, bigint>>>;
  readonly llm: (ctx: LlmContext) => Promise<LlmReview>;
  readonly clock: () => number;
  /** Partner JWT present (cost filter fee schedule). */
  readonly authenticated: boolean;
  /** Called with each decision before its trade executes (record, hash, anchor). */
  readonly onDecision?: (d: Decision) => Promise<void> | void;
  /** Tier 2 contract policy, read for this tick. */
  readonly policy?: CheckContext["policy"];
}

export interface Decision {
  readonly asset: TradableAsset;
  readonly barTime: number;
  readonly portfolio: PortfolioSnapshot; // state the decision was taken on
  readonly signals: readonly Signal[];
  readonly checks: readonly CheckResult[];
  readonly quote?: Quote;
  readonly llm?: LlmReview;
  readonly outcome: DecisionOutcome;
}

export interface TickResult {
  readonly portfolio: PortfolioSnapshot;
  readonly decisions: readonly Decision[];
  readonly executions: readonly { readonly proposal: TradeProposal; readonly report: ExecutionReport }[];
  readonly alerts: readonly string[];
  /** The kill switch tripped on this tick: the caller pauses the contract. */
  readonly pauseContract: boolean;
}

const H = INTERVAL_MS["1h"];

export async function runTick(input: TickInput, deps: EngineDeps, cfg: RiskConfig): Promise<TickResult> {
  const { barTime, market, executed } = input;
  const decisions: Decision[] = [];
  const executions: { proposal: TradeProposal; report: ExecutionReport }[] = [];
  const alerts: string[] = [];
  const now = deps.clock();

  // ---------------------------------------------------------------- 1. data
  const lastClose = (a: TradableAsset) => market.candles1h[a].at(-1)?.close;
  const barOf = (a: TradableAsset) => market.candles1h[a].find((c) => c.openTime === barTime);
  const lastClosed4h = market.btc4h.filter((c) => c.openTime + INTERVAL_MS["4h"] <= barTime + H).at(-1);
  const freshness: SeriesFreshness[] = [
    ...ASSET_ORDER.map((a) => ({ name: `${a} 1h`, interval: "1h" as const, lastOpenTime: market.candles1h[a].at(-1)?.openTime })),
    { name: "BTC 4h", interval: "4h", lastOpenTime: lastClosed4h?.openTime },
  ];
  const prices = Object.fromEntries(
    ASSET_ORDER.map((a) => [a, lastClose(a) ?? input.portfolio.positions.find((p) => p.asset === a)?.entryPrice ?? 0]),
  ) as Record<TradableAsset, number>;

  // ---------------------------------------------------------------- 2. portfolio, kill switch first
  let p = rollPortfolio(input.portfolio, now, equityUsd(input.portfolio.balances, prices));
  const ks = applyKillSwitch(p, barTime, prices, cfg.limits);
  p = ks.portfolio;
  if (ks.tripped) alerts.push(`Kill switch: equity ${p.equityUsd.toFixed(2)} ≤ ${100 - cfg.limits.maxDrawdownPct}% of peak ${p.peakEquityUsd.toFixed(2)}; closing all positions, pausing the contract`);

  const ctxFor = async (): Promise<(q: Quote) => CheckContext> => {
    const bal = await deps.balances();
    return (q) => ({
      now: deps.clock(),
      originBalance: bal[symbolOf(q.originAsset, cfg)] ?? 0n,
      executed,
      ...(deps.policy ? { policy: deps.policy } : {}),
    });
  };
  const decide = async (d: Decision) => {
    decisions.push(d);
    await deps.onDecision?.(d);
  };
  const fill = async (proposal: TradeProposal, q: Quote): Promise<ExecutionReport> => {
    const report = await deps.execute(proposal, q);
    executions.push({ proposal, report });
    if (report.fill && report.status !== "FAILED" && report.status !== "REFUNDED") executed.add(idempotencyKey(proposal));
    return report;
  };

  // ---------------------------------------------------------------- 3. open positions (before any entry)
  let exitStuck = false;
  for (const asset of ASSET_ORDER) {
    const pos = p.positions.find((x) => x.asset === asset && x.quantity > 0);
    if (!pos) continue;
    let exits: readonly ExitProposal[];
    let after: Position | null;
    const killExit = ks.exits.find((e) => e.asset === asset);
    if (killExit) {
      exits = [killExit];
      after = null;
    } else {
      const bar = barOf(asset);
      if (!bar) {
        alerts.push(`${asset}: no closed 1h bar at ${new Date(barTime).toISOString()}; exits wait for data (the watcher still guards the stop)`);
        continue;
      }
      const cs = market.candles1h[asset];
      const atrNow = atrSeries(cs.slice(0, cs.indexOf(bar) + 1), cfg.indicators.atr).at(-1) ?? Number.NaN;
      const step = manageExit(pos, bar, atrNow, cfg.exits);
      exits = step.exits;
      after = step.position;
    }
    if (exits.length === 0) {
      p = replacePosition(p, asset, after);
      continue;
    }
    let current: Position | null = pos;
    for (const exit of exits) {
      const ctx = await ctxFor();
      const checked: CheckedQuote = await quoteAndCheck(exit, (bps) => deps.quote(exit, bps), ctx, cfg);
      if (!checked.outcome.ok) {
        exitStuck ||= checked.exitStuck;
        if (checked.exitStuck) alerts.push(`${asset} ${exit.reason} exit refused twice (${checked.outcome.reason}); entries paused, retrying every ${cfg.execution.watcherPollSec} s`);
        await decide({ asset, barTime, portfolio: p, signals: [], checks: checked.attempts.flatMap((a) => a.outcome.checks), quote: checked.quote,
          outcome: { action: "REJECT", reason: checked.outcome.reason, proposal: exit } });
        break; // the position stays as it was; the next tick or the watcher tries again
      }
      await decide({ asset, barTime, portfolio: p, signals: [], checks: checked.attempts.flatMap((a) => a.outcome.checks), quote: checked.quote,
        outcome: { action: "TRADE", proposal: exit } });
      const report = await fill(exit, checked.quote);
      if (!report.fill) {
        exitStuck = true;
        alerts.push(`${asset} ${exit.reason} exit did not fill (${report.status}${report.error ? `: ${report.error}` : ""})`);
        break;
      }
      p = applyExitFill(p, exit, report, cfg);
      // last exit of the bar → the state computed by the exit machine; TP1 alone (TP2 refused) → the rest,
      // with TP1 marked and the stop at least at breakeven
      const c = current as Position;
      current = exit === exits.at(-1) ? after : { ...c, quantity: c.quantity - exit.quantity, tp1Hit: true, stopPrice: Math.max(c.stopPrice, c.entryPrice) };
      p = replacePosition(p, asset, current);
      if (exit.reason === "STOP") p = startCooldown(p, asset, barTime, cfg.limits);
    }
  }

  // ---------------------------------------------------------------- 4. portfolio limits
  const gate = entryGate(p, freshness, now, cfg.limits);
  const blocked: { reason: RejectReason; checks: readonly CheckResult[] } | null = !gate.ok
    ? { reason: gate.reason, checks: gate.checks }
    : exitStuck
      ? { reason: "EXIT_PENDING", checks: [...gate.checks, { name: "exits_done", ok: false }] }
      : null;
  if (blocked) {
    for (const asset of ASSET_ORDER) {
      await decide({ asset, barTime, portfolio: p, signals: [], checks: blocked.checks, outcome: { action: "HOLD", reason: blocked.reason } });
    }
    return { portfolio: p, decisions, executions, alerts, pauseContract: ks.tripped };
  }

  // ---------------------------------------------------------------- 5. entries, fixed order
  for (const asset of ASSET_ORDER) {
    const own = market.candles1h[asset];
    const t = own.findIndex((c) => c.openTime === barTime);
    if (t < 0) {
      await decide({ asset, barTime, portfolio: p, signals: [], checks: [{ name: "fresh_data", ok: false, detail: `${asset} 1h` }], outcome: { action: "HOLD", reason: "STALE_DATA" } });
      continue;
    }
    const signals = computeSignals({ asset, candles1h: own, btc1h: market.candles1h.BTC, btc4h: market.btc4h }, t, cfg);
    const checks: CheckResult[] = [...gate.checks];
    const reject = (reason: RejectReason, extra: { quote?: Quote; llm?: LlmReview; proposal?: TradeProposal } = {}) =>
      decide({
        asset, barTime, portfolio: p, signals, checks,
        ...(extra.quote ? { quote: extra.quote } : {}), ...(extra.llm ? { llm: extra.llm } : {}),
        outcome: { action: "REJECT", reason, ...(extra.proposal ? { proposal: extra.proposal } : {}) },
      });

    const conv = evaluateConvergence(asset, barTime, signals, p, cfg);
    checks.push(...conv.checks);
    if (!conv.ok) {
      if (conv.reason === "NO_SIGNAL") await decide({ asset, barTime, portfolio: p, signals, checks, outcome: { action: "HOLD", reason: "NO_SIGNAL" } });
      else await reject(conv.reason);
      continue;
    }
    const bo = conv.breakout.evidence;
    const pRef = own[t]!.close;
    const fvg = conv.confirmations.find((s) => s.kind === "FVG_SUPPORT")?.evidence["fvgBottom"];
    const stop = placeStop(pRef, bo["atr"] as number, fvg, cfg.sizing);
    checks.push(...stop.checks);
    if (!stop.ok) {
      await reject(stop.reason);
      continue;
    }

    const size = (llmMultiplier?: 1 | 0.5 | 0) =>
      sizePosition({
        asset, pRef, stop: stop.stop, balances: p.balances, prices, positions: p.positions,
        feeBufferPct: deps.authenticated ? cfg.costs.feePctAuthenticated : cfg.costs.feePctUnauthenticated,
        ...(deps.policy ? { onChainCapUsd: deps.policy.maxAmountInUsd } : {}),
        ...(llmMultiplier === undefined ? {} : { llmMultiplier }),
      }, cfg.sizing);
    const proposalFor = (s: Extract<ReturnType<typeof size>, { ok: true }>): EntryProposal => ({
      kind: "ENTRY", asset, barTime, referencePrice: pRef, notionalUsd: s.notionalUsd, quantity: s.quantity,
      stopPrice: stop.stop, takeProfit: targets(pRef, stop.stop, cfg.exits), riskUsd: s.riskUsd, signals,
    });
    const quoteChecked = async (proposal: EntryProposal) =>
      quoteAndCheck(proposal, (bps) => deps.quote(proposal, bps), await ctxFor(), cfg);

    const sized = size();
    checks.push(...sized.checks);
    if (!sized.ok) {
      await reject(sized.reason);
      continue;
    }
    let proposal = proposalFor(sized);
    let q = await quoteChecked(proposal);
    checks.push(...q.outcome.checks);
    if (!q.outcome.ok) {
      await reject(q.outcome.reason, { quote: q.quote, proposal });
      continue;
    }
    const cost = costFilter({ pRef, stop: stop.stop, authenticated: deps.authenticated, entrySlippageFrac: (q.outcome.priceQuoted - pRef) / pRef }, cfg);
    checks.push(...cost.checks);
    if (!cost.ok) {
      await reject(cost.reason, { quote: q.quote, proposal });
      continue;
    }

    const review = await reviewSafely(deps, {
      asset, notionalUsd: proposal.notionalUsd, referencePrice: pRef, stopPrice: stop.stop, takeProfit: proposal.takeProfit,
      signals: signals.map(({ kind, direction, strength, evidence }) => ({ kind, direction, strength, evidence })),
      last24Closes: own.slice(Math.max(0, t - 23), t + 1).map((c) => c.close),
      dayPnlPct: p.dayStartEquityUsd > 0 ? (p.equityUsd / p.dayStartEquityUsd - 1) * 100 : 0,
      openExposureUsd: p.positions.reduce((s, x) => s + x.quantity * prices[x.asset], 0),
    }, cfg);
    if (review.sizeMultiplier === 0) {
      await reject("LLM_VETO", { quote: q.quote, llm: review, proposal });
      continue;
    }
    if (review.sizeMultiplier === 0.5) {
      const reduced = size(0.5);
      checks.push(...reduced.checks.filter((c) => c.name === "llm_multiplier" || c.name === "min_notional"));
      if (!reduced.ok) {
        await reject(reduced.reason, { quote: q.quote, llm: review, proposal });
        continue;
      }
      proposal = proposalFor(reduced);
      q = await quoteChecked(proposal);
      checks.push(...q.outcome.checks);
      if (!q.outcome.ok) {
        await reject(q.outcome.reason, { quote: q.quote, llm: review, proposal });
        continue;
      }
    }

    await decide({ asset, barTime, portfolio: p, signals, checks, quote: q.quote, llm: review, outcome: { action: "TRADE", proposal } });
    const report = await fill(proposal, q.quote);
    if (report.fill) p = recordEntry(applyEntryFill(p, proposal, report, cfg));
    else alerts.push(`${asset} entry did not fill (${report.status}${report.error ? `: ${report.error}` : ""})`);
  }

  return { portfolio: p, decisions, executions, alerts, pauseContract: ks.tripped };
}

// ---------------------------------------------------------------- helpers

function symbolOf(assetId: string, cfg: RiskConfig): AssetSymbol {
  const hit = (Object.entries(cfg.assets) as [AssetSymbol, { assetId: string }][]).find(([, a]) => a.assetId === assetId);
  return hit ? hit[0] : "USDC";
}

function replacePosition(p: PortfolioSnapshot, asset: TradableAsset, pos: Position | null): PortfolioSnapshot {
  const others = p.positions.filter((x) => x.asset !== asset);
  return { ...p, positions: pos && pos.quantity > 0 ? [...others, pos] : others };
}

function applyEntryFill(p: PortfolioSnapshot, e: EntryProposal, r: ExecutionReport, cfg: RiskConfig): PortfolioSnapshot {
  const f = r.fill as NonNullable<ExecutionReport["fill"]>;
  const pos: Position = {
    asset: e.asset, quantity: f.quantityOut, entryPrice: f.price, entryBarTime: e.barTime, initialStop: e.stopPrice, stopPrice: e.stopPrice,
    takeProfit: targets(f.price, e.stopPrice, cfg.exits), tp1Hit: false, highestCloseSinceEntry: f.price,
  };
  const b = { ...p.balances, USDC: p.balances.USDC - f.quantityIn, [e.asset]: p.balances[e.asset] + f.quantityOut };
  return replacePosition({ ...p, balances: b }, e.asset, pos);
}

function applyExitFill(p: PortfolioSnapshot, x: ExitProposal, r: ExecutionReport, _cfg: RiskConfig): PortfolioSnapshot {
  const f = r.fill as NonNullable<ExecutionReport["fill"]>;
  return { ...p, balances: { ...p.balances, [x.asset]: Math.max(0, p.balances[x.asset] - f.quantityIn), USDC: p.balances.USDC + f.quantityOut } };
}

/** §8: any failure, or a verdict inconsistent with its multiplier, becomes `reduce` (× 0.5) with the reason. */
async function reviewSafely(deps: EngineDeps, ctx: LlmContext, cfg: RiskConfig): Promise<LlmReview> {
  const fallback = (why: string): LlmReview => ({
    model: cfg.llm.model, verdict: "reduce", sizeMultiplier: cfg.llm.fallbackMultiplier as 0.5, rationale: "", fallbackReason: why,
  });
  try {
    const r = await Promise.race([
      deps.llm(ctx),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${cfg.llm.timeoutMs} ms`)), cfg.llm.timeoutMs)),
    ]);
    if (LLM_SIZE_MULTIPLIER[r.verdict] !== r.sizeMultiplier) return { ...fallback(`inconsistent verdict ${r.verdict} × ${r.sizeMultiplier}`), ...pick(r) };
    return r;
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

const pick = (r: LlmReview) => ({ ...(r.chatId ? { chatId: r.chatId } : {}), ...(r.signature ? { signature: r.signature } : {}) });

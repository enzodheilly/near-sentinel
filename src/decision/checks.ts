/**
 * Pre-trade execution checks (RISK_ENGINE.md §7), run on every proposal right after the quote.
 *
 *   price sanity   |P_q − P_ref| / P_ref ≤ priceDeviationPct                         → QUOTE_PRICE_DEVIATION
 *   slippage       buys (P_q − P_ref) / P_ref, sells (P_ref − P_q) / P_ref ≤ tolerance  → SLIPPAGE_TOO_HIGH
 *   freshness      now − quote.receivedAt < quoteTtlSec                                  → QUOTE_EXPIRED
 *   balance        origin balance in Intents ≥ amountIn                                  → INSUFFICIENT_BALANCE
 *   idempotency    (asset, barTime, reason) not executed yet                             → DUPLICATE
 *   policy (T2)    contract not paused, amount within its cap                            → POLICY_DENIED
 *
 * P_q is the price implied by the quote, in USDC per unit: amountIn / amountOut for a buy (USDC in),
 * amountOut / amountIn for a sell (USDC out), both in human units.
 *
 * For exits, the price sanity bound is never tighter than the slippage tolerance (1.5% on the first attempt,
 * 2.5% on the retry): with a fixed 1% bound, a 150 or 250 bps tolerance could never be used. Entries keep 1%.
 *
 * Retry: entries are never re-quoted, whatever failed. An exit that fails a check a new quote could fix
 * (price, slippage, expiry) is re-quoted ONCE at the wider exitRetry tolerance. If the retry fails too,
 * entries pause, an alert is raised, and the caller keeps retrying the exit every watcherPollSec.
 */

import type { RiskConfig } from "../config/schema.ts";
import {
  idempotencyKey,
  type CheckResult,
  type Quote,
  type RejectReason,
  type TradeProposal,
} from "../types.ts";

type Cfg = Pick<RiskConfig, "assets" | "execution">;

export interface CheckContext {
  readonly now: number;
  /** Balance of the quote's origin asset in the Intents contract, in base units. */
  readonly originBalance: bigint;
  /** Idempotency keys already executed. */
  readonly executed: ReadonlySet<string>;
  /** Tier 2 contract policy; absent on Tier 1. */
  readonly policy?: { readonly paused: boolean; readonly maxAmountInUsd: number };
}

export type CheckOutcome =
  | { readonly ok: true; readonly priceQuoted: number; readonly toleranceBps: number; readonly checks: readonly CheckResult[] }
  | { readonly ok: false; readonly reason: RejectReason; readonly priceQuoted: number | null; readonly toleranceBps: number; readonly checks: readonly CheckResult[] };

const toHuman = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals;

/** Tolerance (bps) of the first attempt: 50 for entries, 150 for exits (§7.1). */
export function firstTolerance(p: TradeProposal, cfg: Cfg): number {
  return p.kind === "ENTRY" ? cfg.execution.slippageBps.entry : cfg.execution.slippageBps.exit;
}

/** Price implied by the quote in USDC per unit of the traded asset, or null if the pair does not match. */
export function impliedPrice(p: TradeProposal, q: Quote, cfg: Cfg): number | null {
  const usdc = cfg.assets.USDC;
  const asset = cfg.assets[p.asset];
  const buy = p.kind === "ENTRY";
  const [origin, dest] = buy ? [usdc, asset] : [asset, usdc];
  if (q.originAsset !== origin.assetId || q.destinationAsset !== dest.assetId) return null;
  const inH = toHuman(q.amountIn, origin.decimals);
  const outH = toHuman(q.amountOut, dest.decimals);
  if (!(inH > 0 && outH > 0)) return null;
  return buy ? inH / outH : outH / inH;
}

export function runChecks(p: TradeProposal, q: Quote, ctx: CheckContext, cfg: Cfg, toleranceBps = firstTolerance(p, cfg)): CheckOutcome {
  const pRef = p.referencePrice;
  const pq = impliedPrice(p, q, cfg);
  const sanityPct = p.kind === "EXIT" ? Math.max(cfg.execution.priceDeviationPct, toleranceBps / 100) : cfg.execution.priceDeviationPct;
  const dev = pq === null ? null : Math.abs(pq - pRef) / pRef;
  const slip = pq === null ? null : p.kind === "ENTRY" ? (pq - pRef) / pRef : (pRef - pq) / pRef;
  const ageSec = (ctx.now - q.receivedAt) / 1000;
  const key = idempotencyKey(p);
  const usdIn = p.kind === "ENTRY" ? p.notionalUsd : p.quantity * pRef;

  const rules: [RejectReason, CheckResult][] = [
    ["DUPLICATE", { name: "idempotency", ok: !ctx.executed.has(key), detail: key }],
    [
      "QUOTE_PRICE_DEVIATION",
      pq === null
        ? { name: "price_sanity", ok: false, detail: "quote pair or amounts do not match the proposal" }
        : { name: "price_sanity", ok: (dev as number) <= sanityPct / 100, value: (dev as number) * 100, limit: sanityPct },
    ],
    ["SLIPPAGE_TOO_HIGH", { name: "slippage", ok: slip !== null && slip * 10_000 <= toleranceBps, value: slip === null ? Number.NaN : slip * 10_000, limit: toleranceBps }],
    ["QUOTE_EXPIRED", { name: "quote_fresh", ok: ageSec < cfg.execution.quoteTtlSec, value: ageSec, limit: cfg.execution.quoteTtlSec }],
    ["INSUFFICIENT_BALANCE", { name: "balance", ok: ctx.originBalance >= q.amountIn, detail: `${ctx.originBalance} / ${q.amountIn}` }],
    ...(ctx.policy
      ? ([[
          "POLICY_DENIED",
          { name: "contract_policy", ok: !ctx.policy.paused && usdIn <= ctx.policy.maxAmountInUsd, value: usdIn, limit: ctx.policy.maxAmountInUsd, detail: ctx.policy.paused ? "paused" : "active" },
        ]] as [RejectReason, CheckResult][])
      : []),
  ];
  // value NaN is not valid JSON for the record: drop it
  const checks = rules.map(([, c]) => (Number.isNaN(c.value) ? { name: c.name, ok: c.ok } : c));
  const failed = rules.find(([, c]) => !c.ok);
  return failed
    ? { ok: false, reason: failed[0], priceQuoted: pq, toleranceBps, checks }
    : { ok: true, priceQuoted: pq as number, toleranceBps, checks };
}

/** Failures that a new quote can fix. */
const REQUOTABLE: ReadonlySet<RejectReason> = new Set(["QUOTE_PRICE_DEVIATION", "SLIPPAGE_TOO_HIGH", "QUOTE_EXPIRED"]);

export interface CheckedQuote {
  readonly outcome: CheckOutcome;
  readonly quote: Quote;
  /** Every attempt, in order: one for entries, at most two for exits. */
  readonly attempts: readonly { readonly quote: Quote; readonly outcome: CheckOutcome }[];
  /** Exit still failing after the retry: pause entries, alert, retry the exit every watcherPollSec. */
  readonly exitStuck: boolean;
}

/**
 * Quote, check, and for exits re-quote once at the wider tolerance. `getQuote(toleranceBps)` asks 1Click for a
 * quote with that slippage tolerance; `context()` gives the state at check time (clock, balance…).
 */
export async function quoteAndCheck(
  p: TradeProposal,
  getQuote: (toleranceBps: number) => Promise<Quote>,
  context: () => CheckContext,
  cfg: Cfg,
): Promise<CheckedQuote> {
  const tol = firstTolerance(p, cfg);
  const q1 = await getQuote(tol);
  const o1 = runChecks(p, q1, context(), cfg, tol);
  const attempts = [{ quote: q1, outcome: o1 }];
  if (o1.ok || p.kind === "ENTRY" || !REQUOTABLE.has(o1.reason)) {
    return { outcome: o1, quote: q1, attempts, exitStuck: !o1.ok && p.kind === "EXIT" };
  }
  const wide = cfg.execution.slippageBps.exitRetry;
  const q2 = await getQuote(wide);
  const o2 = runChecks(p, q2, context(), cfg, wide);
  attempts.push({ quote: q2, outcome: o2 });
  return { outcome: o2, quote: q2, attempts, exitStuck: !o2.ok };
}


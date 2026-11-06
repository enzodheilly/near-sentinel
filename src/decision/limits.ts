/**
 * Portfolio limits and circuit breakers (RISK_ENGINE.md §6). Pure functions over PortfolioSnapshot.
 *
 * - Daily loss:  PnL since 00:00 UTC (realised + unrealised) ≤ −dailyLossPct % of start-of-day equity
 *                → no new entries until the next UTC day (automatic reset).
 * - Drawdown:    equity ≤ (1 − maxDrawdownPct %) × peak → kill switch: close every position, pause the
 *                contract. Only the owner resets it (`resetKillSwitch`); no day roll ever clears it.
 * - Entries/day: entriesToday ≥ maxEntriesPerDay → no new entries until the next UTC day.
 * - Cooldown:    a stop-out on bar b blocks entries on that asset for the next cooldownBars bars
 *                (cooldownUntil = b + (cooldownBars + 1) × 1h); checked by convergence (§4).
 * - Stale data:  a series whose last closed candle ended more than staleBars × interval ago → no new entries.
 *
 * Exits are never blocked by any of these rules: nothing here gates an ExitProposal.
 */

import type { RiskConfig } from "../config/schema.ts";
import {
  INTERVAL_MS,
  type CheckResult,
  type Interval,
  type ExitProposal,
  type PortfolioSnapshot,
  type RejectReason,
  type TradableAsset,
} from "../types.ts";

type Limits = RiskConfig["limits"];
const DAY_MS = 86_400_000;

export const utcDay = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

/**
 * Brings the snapshot to tick time `now` with the latest equity: peak updated, and on the first tick of a new
 * UTC day the day counters reset (start-of-day equity = equity now, entries = 0). The kill switch is kept.
 */
export function rollPortfolio(p: PortfolioSnapshot, now: number, equityUsd: number): PortfolioSnapshot {
  if (!Number.isFinite(equityUsd)) throw new RangeError(`rollPortfolio: equity must be finite (got ${equityUsd})`);
  const newDay = utcDay(now) > utcDay(p.at);
  return {
    ...p,
    at: now,
    equityUsd,
    peakEquityUsd: Math.max(p.peakEquityUsd, equityUsd),
    dayStartEquityUsd: newDay ? equityUsd : p.dayStartEquityUsd,
    entriesToday: newDay ? 0 : p.entriesToday,
  };
}

export interface KillSwitchResult {
  readonly portfolio: PortfolioSnapshot;
  /** True on the tick that trips the breaker: the caller pauses the contract. */
  readonly tripped: boolean;
  /** One exit per open position, at its last price. Empty unless just tripped. */
  readonly exits: readonly ExitProposal[];
  readonly check: CheckResult;
}

/** Applies the drawdown breaker (§10 step 2: before anything else). */
export function applyKillSwitch(
  p: PortfolioSnapshot,
  barTime: number,
  prices: Readonly<Record<TradableAsset, number>>,
  cfg: Limits,
): KillSwitchResult {
  const floor = (1 - cfg.maxDrawdownPct / 100) * p.peakEquityUsd;
  const drawdown = p.peakEquityUsd > 0 ? 1 - p.equityUsd / p.peakEquityUsd : 0;
  const tripped = !p.killSwitch && p.equityUsd <= floor;
  const check: CheckResult = { name: "max_drawdown", ok: !(p.killSwitch || tripped), value: drawdown * 100, limit: cfg.maxDrawdownPct };
  if (!tripped) return { portfolio: p, tripped: false, exits: [], check };
  const exits = p.positions
    .filter((pos) => pos.quantity > 0)
    .map((pos): ExitProposal => ({
      kind: "EXIT", asset: pos.asset, barTime, reason: "KILL_SWITCH", referencePrice: prices[pos.asset], quantity: pos.quantity, fraction: 1,
    }));
  return { portfolio: { ...p, killSwitch: true }, tripped: true, exits, check };
}

/** Owner action only (contract `unpause` + this). Never called by the engine. */
export function resetKillSwitch(p: PortfolioSnapshot, owner: { readonly confirmedByOwner: true }): PortfolioSnapshot {
  if (owner.confirmedByOwner !== true) throw new Error("resetKillSwitch: owner confirmation required");
  return { ...p, killSwitch: false, peakEquityUsd: p.equityUsd };
}

export interface SeriesFreshness {
  readonly name: string; // e.g. "NEAR 1h"
  readonly interval: Interval;
  readonly lastOpenTime: number | undefined; // openTime of the last CLOSED candle
}

export type GateResult =
  | { readonly ok: true; readonly checks: readonly CheckResult[] }
  | { readonly ok: false; readonly reason: RejectReason; readonly checks: readonly CheckResult[] };

/**
 * May the engine look for new entries on this tick (§10 step 4)? Every rule is evaluated; the reason is the
 * first failure in the order KILL_SWITCH → STALE_DATA → DAILY_LOSS_LIMIT → MAX_TRADES_PER_DAY.
 */
export function entryGate(p: PortfolioSnapshot, series: readonly SeriesFreshness[], now: number, cfg: Limits): GateResult {
  const stale = series.filter((s) => s.lastOpenTime === undefined || now - (s.lastOpenTime + INTERVAL_MS[s.interval]) > cfg.staleBars * INTERVAL_MS[s.interval]);
  const dayPnl = p.dayStartEquityUsd > 0 ? (p.equityUsd - p.dayStartEquityUsd) / p.dayStartEquityUsd : 0;
  const rules: readonly [RejectReason, CheckResult][] = [
    ["KILL_SWITCH", { name: "kill_switch", ok: !p.killSwitch }],
    ["STALE_DATA", { name: "fresh_data", ok: stale.length === 0, ...(stale.length ? { detail: stale.map((s) => s.name).join(",") } : {}) }],
    ["DAILY_LOSS_LIMIT", { name: "daily_loss", ok: dayPnl > -cfg.dailyLossPct / 100, value: dayPnl * 100, limit: -cfg.dailyLossPct }],
    ["MAX_TRADES_PER_DAY", { name: "entries_today", ok: p.entriesToday < cfg.maxEntriesPerDay, value: p.entriesToday, limit: cfg.maxEntriesPerDay }],
  ];
  const checks = rules.map(([, c]) => c);
  const failed = rules.find(([, c]) => !c.ok);
  return failed ? { ok: false, reason: failed[0], checks } : { ok: true, checks };
}

/** After an entry fills. */
export const recordEntry = (p: PortfolioSnapshot): PortfolioSnapshot => ({ ...p, entriesToday: p.entriesToday + 1 });

/** After a STOP exit on bar `stopBarTime`: the next cooldownBars 1h bars of that asset are blocked. */
export function startCooldown(p: PortfolioSnapshot, asset: TradableAsset, stopBarTime: number, cfg: Limits): PortfolioSnapshot {
  const until = stopBarTime + (cfg.cooldownBars + 1) * INTERVAL_MS["1h"];
  return { ...p, cooldownUntil: { ...p.cooldownUntil, [asset]: Math.max(until, p.cooldownUntil[asset] ?? 0) } };
}

/**
 * Decision verification (ARCHITECTURE.md §10): recompute a record from its inputs and compare, byte for byte.
 *
 *   1. the record hashes to the expected hash (its file name, or its anchor on-chain);
 *   2. its configHash names a known configuration;
 *   3. each candle window it references matches the candle data given to `verify` (SHA-256 of the window);
 *   4. the decision is recomputed with the same code: signals, rules, sizing… and every external answer
 *      (quotes, clock, balances, LLM) read back from `inputs.externals`, in the order the engine asks for them;
 *   5. the recomputed record equals the stored one. The first difference is reported by its path.
 *
 * The LLM verdict is replayed, not recomputed (a model is not deterministic); its TEE signature is checked
 * separately: the signed text is rebuilt from the stored hashes and the ed25519 signature checked. Whether the hash is anchored on-chain is checked by the CLI (#31).
 */

import type { RiskConfig } from "../config/schema.ts";
import { windowRef } from "../data/fixtures.ts";
import { canonicalJson } from "../lib/canonical.ts";
import type { AssetSymbol, Candle, DecisionRecord, ExitProposal, ExternalCall, Interval, LlmReview, Quote } from "../types.ts";
import { evaluateEntry, exitPlan, marketFacts, quoteChecked, type Decision, type DecisionIO, type TickMarket } from "./engine.ts";
import { watchExit } from "./exits.ts";
import { applyKillSwitch, entryGate } from "./limits.ts";
import { recheckReview } from "./llm/attestation.ts";
import { anchorKind, buildRecord, hashRecord } from "./record.ts";

export interface VerifyContext {
  /** Risk configurations by configHash. */
  readonly configs: ReadonlyMap<string, RiskConfig>;
  /** Full candle series by market symbol and interval (e.g. a fixture set, or the archived market data). */
  readonly candles: (symbol: string, interval: Interval) => readonly Candle[] | undefined;
  /** Hash the record is expected to have (file name or on-chain anchor). */
  readonly expectedHash?: string;
  /** On-chain lookup of the hash in the guardrail contract (live records must be anchored). */
  readonly anchored?: (hash: string) => Promise<{ readonly kind: string; readonly recorded_at_ms: number; readonly seq: number } | null>;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly hash: string;
  readonly problems: readonly string[];
  /** Things that are consistent but cannot be fully proven from this record alone. */
  readonly notes: readonly string[];
}

class ReplayError extends Error {}

export async function verifyRecord(rec: DecisionRecord, ctx: VerifyContext): Promise<VerifyResult> {
  const problems: string[] = [];
  const notes: string[] = [];
  const hash = hashRecord(rec);
  const done = (): VerifyResult => ({ ok: problems.length === 0, hash, problems, notes });

  if (ctx.expectedHash !== undefined && ctx.expectedHash !== hash) {
    problems.push(`hash: the record hashes to ${hash}, not ${ctx.expectedHash} (content changed after it was hashed)`);
  }
  const cfg = ctx.configs.get(rec.configHash);
  if (!cfg) {
    problems.push(`configHash ${rec.configHash}: unknown configuration, the decision cannot be recomputed`);
    return done();
  }

  // ---------------------------------------------------------------- candle windows
  const series = new Map<string, readonly Candle[]>();
  for (const ref of rec.inputs.candles) {
    const label = `${ref.symbol} ${ref.interval}`;
    const all = ctx.candles(ref.symbol, ref.interval);
    if (!all) {
      problems.push(`candles ${label}: no data available to check this window`);
      continue;
    }
    const cut = all.filter((c) => c.openTime >= ref.firstOpenTime && c.openTime <= ref.lastOpenTime);
    const got = cut.length ? windowRef(ref.symbol, ref.interval, cut) : undefined;
    if (!got || got.sha256 !== ref.sha256 || got.count !== ref.count) {
      problems.push(`candles ${label}: the data does not match the record (record ${ref.count} candles, sha256 ${ref.sha256.slice(0, 12)}…; data ${got?.count ?? 0} candles, sha256 ${got?.sha256.slice(0, 12) ?? "none"}…)`);
      continue;
    }
    series.set(label, cut);
  }
  if (problems.length) return done();
  const market: TickMarket = {
    candles1h: { NEAR: series.get("NEARUSDT 1h") ?? [], BTC: series.get("BTCUSDT 1h") ?? [] },
    btc4h: series.get("BTCUSDT 4h") ?? [],
  };

  // ---------------------------------------------------------------- recompute with the recorded externals
  const tape = player(rec.inputs.externals.calls);
  const io: DecisionIO = {
    ...tape.io,
    authenticated: rec.inputs.externals.authenticated,
    ...(rec.inputs.externals.policy ? { policy: rec.inputs.externals.policy } : {}),
  };
  let decision: Omit<Decision, "externals">;
  try {
    decision = await recompute(rec, market, io, cfg, notes);
  } catch (e) {
    if (e instanceof ReplayError) {
      problems.push(e.message);
      return done();
    }
    throw e;
  }
  if (tape.left() > 0) problems.push(`externals: ${tape.left()} recorded call(s) were never asked for by the recomputation`);

  const rebuilt = buildRecord({ ...decision, externals: rec.inputs.externals, ...(rec.inputs.trigger ? { trigger: rec.inputs.trigger } : {}) }, rec.inputs.candles, {
    agentVersion: rec.agentVersion,
    configHash: rec.configHash,
  });
  const a = JSON.parse(canonicalJson(rec)) as unknown;
  const b = JSON.parse(canonicalJson(rebuilt)) as unknown;
  const diff = firstDifference(a, b, "");
  if (diff) problems.push(`recomputed decision differs at ${diff.path || "(root)"}: record has ${show(diff.a)}, recomputation gives ${show(diff.b)}`);
  if (ctx.anchored) {
    let entry: Awaited<ReturnType<NonNullable<VerifyContext["anchored"]>>> = null;
    try {
      entry = await ctx.anchored(hash);
    } catch (e) {
      problems.push(`anchor: lookup failed (${e instanceof Error ? e.message : String(e)})`);
    }
    if (entry === null && !problems.some((x) => x.startsWith("anchor:"))) problems.push("anchor: this hash is not recorded in the guardrail contract");
    else if (entry && entry.kind === "TRADE" && anchorKind(rec.outcome) === "EXIT") notes.push(`anchor: on chain as decision #${entry.seq}, an exit anchored as TRADE (contract deployed before EXIT existed), at ${new Date(entry.recorded_at_ms).toISOString()}`);
    else if (entry && entry.kind !== anchorKind(rec.outcome)) problems.push(`anchor: recorded on chain as ${entry.kind}, the record says ${anchorKind(rec.outcome)}`);
    else if (entry) notes.push(`anchor: on chain as decision #${entry.seq}, ${entry.kind}, at ${new Date(entry.recorded_at_ms).toISOString()}`);
  }
  if (rec.llm) {
    const llm = recheckReview(rec.llm);
    problems.push(...llm.problems);
    notes.push(...llm.notes);
  }
  return done();
}

async function recompute(rec: DecisionRecord, market: TickMarket, io: DecisionIO, cfg: RiskConfig, notes: string[]): Promise<Omit<Decision, "externals">> {
  const { asset, barTime } = rec;
  const p = rec.inputs.portfolio;
  const now = rec.inputs.now;
  const base = { asset, barTime, portfolio: p, now };
  const proposal = "proposal" in rec.outcome ? rec.outcome.proposal : undefined;

  // ---- an exit: re-derive it from the position and the bar, then replay its quote and checks
  if (proposal?.kind === "EXIT") {
    const { prices } = marketFacts(market, barTime, p);
    const killExits = proposal.reason === "KILL_SWITCH" ? applyKillSwitch({ ...p, killSwitch: false }, barTime, prices, cfg.limits).exits : [];
    const trigger = rec.inputs.trigger;
    const pos = p.positions.find((x) => x.asset === asset && x.quantity > 0);
    const watched = trigger && pos ? watchExit(pos, trigger.price, trigger.at, cfg.exits) : null;
    if (trigger) notes.push(`watcher exit: price ${trigger.price} observed at ${new Date(trigger.at).toISOString()} (an input, like a quote)`);
    const plan = trigger ? (watched ? { exits: watched.exits, after: watched.position } : null) : exitPlan(p, asset, barTime, market, killExits, cfg);
    const derived = plan && plan !== "NO_BAR" ? plan.exits.find((e) => sameJson(e, proposal)) : undefined;
    if (!derived) {
      throw new ReplayError(`outcome.proposal: the exit ${proposal.reason} of ${proposal.quantity} ${asset} is not what the exit machine produces for this position and bar`);
    }
    const checked = await quoteChecked(derived as ExitProposal, io, cfg);
    return {
      ...base, signals: [], checks: checked.attempts.flatMap((x) => x.outcome.checks),
      outcome: checked.outcome.ok ? { action: "TRADE", proposal: derived } : { action: "REJECT", reason: checked.outcome.reason, proposal: derived },
    };
  }

  // ---- entries held because an exit of the same tick is stuck: the gate itself is recomputed
  if (rec.outcome.action === "HOLD" && rec.outcome.reason === "EXIT_PENDING") {
    const { freshness } = marketFacts(market, barTime, p);
    const gate = entryGate(p, freshness, now, cfg.limits);
    notes.push("EXIT_PENDING: the stuck exit itself is in its own record of the same tick");
    return { ...base, signals: [], checks: [...gate.checks, { name: "exits_done", ok: false }], outcome: { action: "HOLD", reason: "EXIT_PENDING" } };
  }

  // ---- everything else is the entry path, from the limits gate to the trade
  const { quote: _quote, ...ev } = await evaluateEntry({ asset, barTime, now, market, portfolio: p, io }, cfg);
  return ev;
}

/** Reads the recorded external answers back, in order; any divergence is a precise ReplayError. */
function player(calls: readonly ExternalCall[]) {
  let i = 0;
  const next = <K extends ExternalCall["kind"]>(kind: K, what: string): Extract<ExternalCall, { kind: K }> => {
    const c = calls[i];
    if (!c) throw new ReplayError(`externals: the recomputation asks for ${what} (call ${i + 1}), but the record has no more calls`);
    if (c.kind !== kind) throw new ReplayError(`externals: the recomputation asks for ${what} at call ${i + 1}, the record has a ${c.kind} there`);
    i++;
    return c as Extract<ExternalCall, { kind: K }>;
  };
  const io = {
    quote: async (_p: unknown, bps: number): Promise<Quote> => {
      const c = next("quote", `a quote at ${bps} bps`);
      if (c.slippageBps !== bps) throw new ReplayError(`externals: quote ${i} was requested at ${c.slippageBps} bps, the recomputation asks ${bps} bps`);
      return reviveQuote(c.quote);
    },
    balances: async () => reviveBalances(next("balances", "the balances").balances),
    clock: () => next("clock", "the clock").now,
    executedHas: (key: string) => {
      const c = next("executed", `whether ${key} was executed`);
      if (c.key !== key) throw new ReplayError(`externals: call ${i} checked ${c.key}, the recomputation checks ${key}`);
      return c.value;
    },
    llm: async (): Promise<LlmReview> => {
      const c = next("llm", "the LLM");
      if (c.error !== undefined) throw new Error(c.error);
      if (!c.review) throw new ReplayError(`externals: LLM call ${i} has neither a review nor an error`);
      return c.review;
    },
  };
  return { io, left: () => calls.length - i };
}

/** A record read from JSON carries bigints as strings. */
function reviveQuote(q: Quote): Quote {
  const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(v as string));
  return { ...q, amountIn: big(q.amountIn), amountOut: big(q.amountOut), minAmountOut: big(q.minAmountOut) };
}

function reviveBalances(b: Readonly<Record<AssetSymbol, bigint>>): Record<AssetSymbol, bigint> {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === "bigint" ? v : BigInt(v as unknown as string)])) as Record<AssetSymbol, bigint>;
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

function firstDifference(a: unknown, b: unknown, path: string): { path: string; a: unknown; b: unknown } | null {
  if (a === b) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = Array.isArray(a)
      ? Array.from({ length: Math.max(a.length, (b as unknown[]).length) }, (_, i) => String(i))
      : [...new Set([...Object.keys(a), ...Object.keys(b as object)])].sort();
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return { path, a, b };
}

const show = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v).slice(0, 120));


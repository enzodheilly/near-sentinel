import { beforeAll, describe, expect, it } from "vitest";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { runTick, type Decision, type EngineDeps, type LlmContext, type TickInput, type TickMarket } from "../../src/decision/engine.ts";
import type { Candle, ExecutionReport, LlmReview, PortfolioSnapshot, Position, Quote, TradeProposal } from "../../src/types.ts";

const H = 3_600_000;
const A = cfg.assets;

async function market(name: "demo-entry" | "demo-refusal"): Promise<{ market: TickMarket; barTime: number }> {
  const set = await loadFixtureSet(new URL(`../../fixtures/${name}/`, import.meta.url).pathname);
  const barTime = set.signalBarTime;
  const upTo = (cs: readonly Candle[]) => cs.filter((c) => c.openTime <= barTime); // closed at tick time
  return {
    barTime,
    market: {
      candles1h: { NEAR: upTo(set.series["NEARUSDT"]!["1h"]!.candles), BTC: upTo(set.series["BTCUSDT"]!["1h"]!.candles) },
      btc4h: set.series["BTCUSDT"]!["4h"]!.candles,
    },
  };
}

const flat = (at: number, over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  at, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000, peakEquityUsd: 1000, dayStartEquityUsd: 1000,
  entriesToday: 0, cooldownUntil: {}, killSwitch: false, ...over,
});

/** Fake 1Click + executor: quotes at the reference price × (1 + slip), fills exactly at the quote. */
function fakes(opts: { slip?: (p: TradeProposal, bps: number) => number; llm?: (c: LlmContext) => Promise<LlmReview>; now: number }) {
  const log: string[] = [];
  const llmCalls: LlmContext[] = [];
  const dec = (s: "BTC" | "NEAR" | "USDC") => A[s].decimals;
  const units = (x: number, d: number) => BigInt(Math.round(x * 1e6)) * 10n ** BigInt(d - 6);
  const deps: EngineDeps = {
    authenticated: true,
    clock: () => opts.now,
    balances: async () => ({ USDC: 10n ** 12n, BTC: 10n ** 12n, NEAR: 10n ** 30n }),
    quote: async (p, bps) => {
      log.push(`quote ${p.kind} ${p.asset} ${bps}`);
      const price = p.referencePrice * (1 + (opts.slip?.(p, bps) ?? 0));
      const buy = p.kind === "ENTRY";
      const usd = buy ? p.notionalUsd : p.quantity * price;
      const qty = buy ? usd / price : p.quantity;
      return {
        originAsset: buy ? A.USDC.assetId : A[p.asset].assetId, destinationAsset: buy ? A[p.asset].assetId : A.USDC.assetId,
        amountIn: buy ? units(usd, dec("USDC")) : units(qty, dec(p.asset)), amountOut: buy ? units(qty, dec(p.asset)) : units(usd, dec("USDC")),
        minAmountOut: 0n, deadline: "", receivedAt: opts.now, raw: { price, bps },
      } satisfies Quote;
    },
    execute: async (p, q) => {
      log.push(`execute ${p.kind} ${p.asset}`);
      const price = (q.raw as { price: number }).price;
      const fill = p.kind === "ENTRY"
        ? { quantityIn: p.notionalUsd, quantityOut: p.notionalUsd / price, price }
        : { quantityIn: p.quantity, quantityOut: p.quantity * price, price };
      return { mode: "replay", status: "SIMULATED", txRefs: [], fill } satisfies ExecutionReport;
    },
    llm: async (c) => {
      llmCalls.push(c);
      log.push(`llm ${c.asset}`);
      return opts.llm ? opts.llm(c) : { model: cfg.llm.model, verdict: "approve", sizeMultiplier: 1, rationale: "ok", chatId: "chat-1" };
    },
    onDecision: (d) => { log.push(`record ${d.asset} ${d.outcome.action}${"reason" in d.outcome ? ` ${d.outcome.reason}` : ""}`); },
  };
  return { deps, log, llmCalls };
}

const summary = (ds: readonly Decision[]) => ds.map((d) => `${d.asset} ${d.outcome.action}${"reason" in d.outcome ? ` ${d.outcome.reason}` : ""}`);

describe("runTick on the frozen fixtures", () => {
  let entry: Awaited<ReturnType<typeof market>>;
  let refusal: Awaited<ReturnType<typeof market>>;
  beforeAll(async () => { entry = await market("demo-entry"); refusal = await market("demo-refusal"); });
  const input = (m: typeof entry, portfolio?: PortfolioSnapshot, executed = new MemoryKeys()): TickInput =>
    ({ barTime: m.barTime, market: m.market, portfolio: portfolio ?? flat(m.barTime), executed });

  it("demo-entry: BTC then NEAR in that order; NEAR trades $250 after quote, checks, cost filter and LLM", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000 });
    const r = await runTick(input(entry), f.deps, cfg);
    expect(summary(r.decisions)).toEqual(["BTC HOLD NO_SIGNAL", "NEAR TRADE"]);
    expect(f.log).toEqual(["record BTC HOLD NO_SIGNAL", "quote ENTRY NEAR 50", "llm NEAR", "record NEAR TRADE", "execute ENTRY NEAR"]);
    const t = r.decisions[1]!;
    expect(t.outcome).toMatchObject({ action: "TRADE", proposal: { kind: "ENTRY", asset: "NEAR", referencePrice: 1.936 } });
    const prop = (t.outcome as { proposal: { notionalUsd: number; stopPrice: number } }).proposal;
    expect(prop.notionalUsd).toBeCloseTo(250, 9); // 25% position cap binds
    expect(prop.stopPrice).toBeCloseTo(1.9103765930298526, 8);
    expect(t.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["breakout", "confirmations", "stop_max_distance", "cap_position", "price_sanity", "reward_to_cost"]));
    expect(t.llm?.verdict).toBe("approve");
    // the LLM only sees numbers
    expect(f.llmCalls[0]).toMatchObject({ asset: "NEAR", notionalUsd: expect.closeTo(250, 9), last24Closes: expect.any(Array) });
    expect(f.llmCalls[0]!.last24Closes).toHaveLength(24);
    // portfolio after the fill
    expect(r.portfolio.positions).toHaveLength(1);
    expect(r.portfolio.positions[0]).toMatchObject({ asset: "NEAR", entryPrice: 1.936, tp1Hit: false });
    expect(r.portfolio.balances.USDC).toBeCloseTo(750, 9);
    expect(r.portfolio.entriesToday).toBe(1);
  });

  it("same tick replayed twice → no double execution (DUPLICATE)", async () => {
    const executed = new MemoryKeys();
    const f = fakes({ now: entry.barTime + H + 30_000 });
    await runTick(input(entry, undefined, executed), f.deps, cfg);
    const again = await runTick(input(entry, undefined, executed), f.deps, cfg); // same input portfolio, same keys
    expect(summary(again.decisions)).toEqual(["BTC HOLD NO_SIGNAL", "NEAR REJECT DUPLICATE"]);
    expect(f.log.filter((l) => l.startsWith("execute"))).toHaveLength(1);
  });

  it("demo-refusal: REJECT VETO_RSI_EXHAUSTION, no quote, no LLM", async () => {
    const f = fakes({ now: refusal.barTime + H + 30_000 });
    const r = await runTick(input(refusal), f.deps, cfg);
    expect(summary(r.decisions)).toEqual(["BTC HOLD NO_SIGNAL", "NEAR REJECT VETO_RSI_EXHAUSTION"]);
    expect(f.log.some((l) => l.startsWith("quote") || l.startsWith("llm"))).toBe(false);
  });

  it("no entry when a limit blocks: HOLD with the reason for every asset", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000 });
    const r = await runTick(input(entry, flat(entry.barTime, { balances: { USDC: 960, BTC: 0, NEAR: 0 } })), f.deps, cfg);
    expect(summary(r.decisions)).toEqual(["BTC HOLD DAILY_LOSS_LIMIT", "NEAR HOLD DAILY_LOSS_LIMIT"]);
    expect(f.log.some((l) => l.startsWith("quote"))).toBe(false);
  });

  it("stale data blocks entries", async () => {
    const f = fakes({ now: entry.barTime + 3 * H });
    expect(summary((await runTick(input(entry), f.deps, cfg)).decisions)).toEqual(["BTC HOLD STALE_DATA", "NEAR HOLD STALE_DATA"]);
  });

  it("open positions are managed before any entry (a BTC stop executes before the NEAR entry)", async () => {
    const btcBar = entry.market.candles1h.BTC.at(-1)!;
    const btcPos: Position = {
      asset: "BTC", quantity: 0.001, entryPrice: btcBar.close * 1.02, entryBarTime: entry.barTime - 5 * H, initialStop: btcBar.low * 1.001,
      stopPrice: btcBar.low * 1.001, takeProfit: [btcBar.close * 2, btcBar.close * 3], tp1Hit: false, highestCloseSinceEntry: btcBar.close * 1.02,
    };
    const f = fakes({ now: entry.barTime + H + 30_000 });
    const p = flat(entry.barTime, { balances: { USDC: 1000 - 0.001 * btcPos.entryPrice, BTC: 0.001, NEAR: 0 }, positions: [btcPos],
      equityUsd: 1000, dayStartEquityUsd: 1000 });
    const r = await runTick(input(entry, p), f.deps, cfg);
    expect(f.log.slice(0, 3)).toEqual(["quote EXIT BTC 150", "record BTC TRADE", "execute EXIT BTC"]);
    expect(f.log.indexOf("execute EXIT BTC")).toBeLessThan(f.log.indexOf("quote ENTRY NEAR 50"));
    expect(r.portfolio.positions.map((x) => x.asset)).toEqual(["NEAR"]);
    expect(r.portfolio.cooldownUntil.BTC).toBe(entry.barTime + 4 * H); // the stop started the cooldown
  });

  it("LLM reject → REJECT LLM_VETO, nothing executed", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000, llm: async () => ({ model: "m", verdict: "reject", sizeMultiplier: 0, rationale: "no" }) });
    const r = await runTick(input(entry), f.deps, cfg);
    expect(summary(r.decisions).at(-1)).toBe("NEAR REJECT LLM_VETO");
    expect(r.executions).toHaveLength(0);
  });

  it("LLM reduce → half size, re-quoted and re-checked for the new amount", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000, llm: async () => ({ model: "m", verdict: "reduce", sizeMultiplier: 0.5, rationale: "half" }) });
    const r = await runTick(input(entry), f.deps, cfg);
    expect(f.log.filter((l) => l.startsWith("quote"))).toEqual(["quote ENTRY NEAR 50", "quote ENTRY NEAR 50"]);
    expect((r.decisions.at(-1)!.outcome as { proposal: { notionalUsd: number } }).proposal.notionalUsd).toBeCloseTo(125, 9);
  });

  it("LLM failure or inconsistent answer → safe fallback: reduce × 0.5 with the reason recorded", async () => {
    for (const llm of [async () => { throw new Error("502 Bad Gateway"); },
                       async () => ({ model: "m", verdict: "approve" as const, sizeMultiplier: 0 as const, rationale: "?" })]) {
      const f = fakes({ now: entry.barTime + H + 30_000, llm });
      const d = (await runTick(input(entry), f.deps, cfg)).decisions.at(-1)!;
      expect(d.outcome.action).toBe("TRADE");
      expect(d.llm).toMatchObject({ verdict: "reduce", sizeMultiplier: 0.5, fallbackReason: expect.any(String) });
    }
  });

  it("a bad entry quote is rejected, never re-quoted", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000, slip: () => 0.02 });
    const r = await runTick(input(entry), f.deps, cfg);
    expect(summary(r.decisions).at(-1)).toBe("NEAR REJECT QUOTE_PRICE_DEVIATION");
    expect(f.log.filter((l) => l.startsWith("quote"))).toHaveLength(1);
    expect(f.log.some((l) => l.startsWith("llm"))).toBe(false);
  });

  it("kill switch: closes every position first, asks to pause the contract, holds entries", async () => {
    const pos: Position = { asset: "NEAR", quantity: 100, entryPrice: 2.2, entryBarTime: entry.barTime - 10 * H, initialStop: 1.5, stopPrice: 1.5,
      takeProfit: [5, 6], tp1Hit: false, highestCloseSinceEntry: 2.2 };
    const f = fakes({ now: entry.barTime + H + 30_000 });
    const r = await runTick(input(entry, flat(entry.barTime, { balances: { USDC: 600, BTC: 0, NEAR: 100 }, positions: [pos], peakEquityUsd: 1000 })), f.deps, cfg);
    expect(r.pauseContract).toBe(true);
    expect(summary(r.decisions)).toEqual(["NEAR TRADE", "BTC HOLD KILL_SWITCH", "NEAR HOLD KILL_SWITCH"]);
    expect((r.decisions[0]!.outcome as { proposal: { reason: string } }).proposal.reason).toBe("KILL_SWITCH");
    expect(r.portfolio.positions).toEqual([]);
    expect(r.alerts[0]).toMatch(/Kill switch/);
  });

  it("an exit refused twice holds entries (EXIT_PENDING), keeps the position and alerts", async () => {
    const bar = entry.market.candles1h.NEAR.at(-1)!;
    const pos: Position = { asset: "NEAR", quantity: 10, entryPrice: bar.close, entryBarTime: entry.barTime - 5 * H, initialStop: bar.low * 1.01,
      stopPrice: bar.low * 1.01, takeProfit: [9, 10], tp1Hit: false, highestCloseSinceEntry: bar.close };
    const f = fakes({ now: entry.barTime + H + 30_000, slip: (p) => (p.kind === "EXIT" ? -0.05 : 0) });
    const r = await runTick(input(entry, flat(entry.barTime, { balances: { USDC: 980, BTC: 0, NEAR: 10 }, positions: [pos] })), f.deps, cfg);
    expect(f.log.filter((l) => l.startsWith("quote"))).toEqual(["quote EXIT NEAR 150", "quote EXIT NEAR 250"]);
    expect(summary(r.decisions)).toEqual(["NEAR REJECT QUOTE_PRICE_DEVIATION", "BTC HOLD EXIT_PENDING", "NEAR HOLD EXIT_PENDING"]);
    expect(r.portfolio.positions[0]).toMatchObject({ asset: "NEAR", quantity: 10 });
    expect(r.alerts.some((a) => /refused twice/.test(a))).toBe(true);
  });

  it("every decision is handed to onDecision before its trade executes", async () => {
    const f = fakes({ now: entry.barTime + H + 30_000 });
    await runTick(input(entry), f.deps, cfg);
    expect(f.log.indexOf("record NEAR TRADE")).toBeLessThan(f.log.indexOf("execute ENTRY NEAR"));
  });
});

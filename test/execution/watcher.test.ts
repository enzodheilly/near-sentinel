import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candleSourceFor } from "../../src/cli/verify.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash, type RiskConfig } from "../../src/config/schema.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { runWatch, type TickMarket } from "../../src/decision/engine.ts";
import { watchExit } from "../../src/decision/exits.ts";
import { readRecord, recorder } from "../../src/decision/record.ts";
import { verifyRecord } from "../../src/decision/verify.ts";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { replayLlm, ReplayExecutor } from "../../src/execution/replay.ts";
import { HEARTBEAT_MAX_AGE_MS, heartbeatAlert, PriceWatcher, type Heartbeat } from "../../src/execution/watcher.ts";
import type { PortfolioSnapshot, Position } from "../../src/types.ts";

const H = 3_600_000;
const pos: Position = {
  asset: "NEAR", quantity: 100, entryPrice: 2, entryBarTime: 0, initialStop: 1.96, stopPrice: 1.96,
  takeProfit: [2.06, 2.09], tp1Hit: false, highestCloseSinceEntry: 2,
};
const AT = Date.parse("2026-07-20T12:25:00Z");

describe("watchExit (between ticks)", () => {
  it("nothing breached → null", () => {
    expect(watchExit(pos, 2.0, AT, cfg.exits)).toBeNull();
  });
  it("stop breached → STOP for everything, at the observed price, in the current hour", () => {
    const s = watchExit(pos, 1.95, AT, cfg.exits)!;
    expect(s.position).toBeNull();
    expect(s.exits).toEqual([{ kind: "EXIT", asset: "NEAR", barTime: Date.parse("2026-07-20T12:00:00Z"), reason: "STOP", referencePrice: 1.95, quantity: 100, fraction: 1 }]);
  });
  it("TP1 → partial, stop to breakeven, trailing reference untouched", () => {
    const s = watchExit(pos, 2.07, AT, cfg.exits)!;
    expect(s.exits.map((e) => e.reason)).toEqual(["TAKE_PROFIT_1"]);
    expect(s.position).toMatchObject({ tp1Hit: true, stopPrice: 2, quantity: 100 * (1 - cfg.exits.tp1Fraction), highestCloseSinceEntry: 2, entryBarTime: 0 });
  });
  it("TP2 after TP1 → the rest", () => {
    const s = watchExit({ ...pos, tp1Hit: true, quantity: 50, stopPrice: 2 }, 2.1, AT, cfg.exits)!;
    expect(s.exits.map((e) => [e.reason, e.quantity])).toEqual([["TAKE_PROFIT_2", 50]]);
  });
  it("a jump through both targets sells TP1 then TP2", () => {
    expect(watchExit(pos, 2.2, AT, cfg.exits)!.exits.map((e) => e.reason)).toEqual(["TAKE_PROFIT_1", "TAKE_PROFIT_2"]);
  });
});

describe("runWatch", () => {
  it("a stop breach between ticks exits now; the record carries the observed price and verifies", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    const set = await loadFixtureSet(join(root, "fixtures", "demo-entry"));
    const near = set.series["NEARUSDT"]!["1h"]!.candles;
    const barTime = set.signalBarTime + 2 * H; // last closed bar
    const upTo = (cs: typeof near) => cs.filter((c) => c.openTime <= barTime);
    const market: TickMarket = { candles1h: { NEAR: upTo(near), BTC: upTo(set.series["BTCUSDT"]!["1h"]!.candles) }, btc4h: set.series["BTCUSDT"]!["4h"]!.candles };
    const close = market.candles1h.NEAR.at(-1)!.close;
    const position: Position = { ...pos, entryPrice: close, initialStop: close * 0.98, stopPrice: close * 0.98, takeProfit: [close * 1.03, close * 1.045], highestCloseSinceEntry: close, entryBarTime: barTime };
    const portfolio: PortfolioSnapshot = { at: barTime, balances: { USDC: 800, BTC: 0, NEAR: 100 }, positions: [position], equityUsd: 800 + 100 * close,
      peakEquityUsd: 1000, dayStartEquityUsd: 1000, entriesToday: 1, cooldownUntil: {}, killSwitch: false };
    const at = barTime + H + 25 * 60_000; // 25 minutes into the next hour
    const executor = new ReplayExecutor(cfg, { USDC: 800, BTC: 0, NEAR: 100 }, () => at);
    const meta = { agentVersion: "test", configHash: configHash(cfg) };
    const dir = await mkdtemp(join(tmpdir(), "watch-"));
    const rec = recorder(dir, market, meta);
    const price = close * 0.975;

    const r = await runWatch({ barTime, market, portfolio, prices: { NEAR: price, BTC: 70_000 }, at, executed: new MemoryKeys() }, {
      authenticated: true, clock: () => at, balances: () => executor.balances(), quote: (p, b) => executor.quote(p, b), execute: (p, q) => executor.execute(p, q),
      llm: () => replayLlm(cfg), onDecision: rec.sink,
    }, cfg);

    expect(r.executions.map((e) => [e.proposal.kind, e.report.status])).toEqual([["EXIT", "SIMULATED"]]);
    expect(r.portfolio.positions).toEqual([]);
    expect(r.portfolio.balances.NEAR).toBeCloseTo(0, 9);
    expect(r.portfolio.cooldownUntil.NEAR).toBeGreaterThan(at);
    expect(r.decisions.every((d) => d.outcome.action === "TRADE")).toBe(true);

    const record = await readRecord(dir, rec.hashes[0]!);
    expect(record.inputs.trigger).toEqual({ kind: "watcher", price, at });
    const configs = new Map<string, RiskConfig>([[meta.configHash, cfg]]);
    const v = await verifyRecord(record, { configs, candles: candleSourceFor(record, [set]).candles, expectedHash: rec.hashes[0]! });
    expect(v.problems).toEqual([]);
    expect(v.notes.join()).toMatch(/watcher exit: price/);

    // a forged trigger price (re-hashed) no longer matches the exit the machine derives
    const { hashRecord, recordBytes } = await import("../../src/decision/record.ts");
    const { writeFile } = await import("node:fs/promises");
    const forged = { ...record, inputs: { ...record.inputs, trigger: { kind: "watcher" as const, price: close, at } } };
    await writeFile(join(dir, `${hashRecord(forged)}.json`), recordBytes(forged));
    const bad = await verifyRecord(await readRecord(dir, hashRecord(forged)), { configs, candles: candleSourceFor(record, [set]).candles, expectedHash: hashRecord(forged) });
    expect(bad.ok).toBe(false);
  });

  it("no breach, no position or no price → nothing happens", async () => {
    const market: TickMarket = { candles1h: { NEAR: [], BTC: [] }, btc4h: [] };
    const portfolio: PortfolioSnapshot = { at: 0, balances: { USDC: 0, BTC: 0, NEAR: 100 }, positions: [pos], equityUsd: 200, peakEquityUsd: 200,
      dayStartEquityUsd: 200, entriesToday: 0, cooldownUntil: {}, killSwitch: false };
    const deps = { authenticated: true, clock: () => AT, balances: async () => ({ USDC: 0n, BTC: 0n, NEAR: 0n }),
      quote: async () => { throw new Error("no quote expected"); }, execute: async () => { throw new Error("no execution expected"); }, llm: () => replayLlm(cfg) };
    for (const prices of [{ NEAR: 2.0 }, {}, { BTC: 1 }]) {
      const r = await runWatch({ barTime: 0, market, portfolio, prices, at: AT, executed: new MemoryKeys() }, deps, cfg);
      expect(r.decisions).toEqual([]);
    }
  });
});

describe("PriceWatcher", () => {
  afterEach(() => vi.useRealTimers());

  it("polls every 60 s, hands prices to the exit step at once, writes a heartbeat each time", async () => {
    vi.useFakeTimers({ now: AT });
    const seen: number[] = [];
    const beats: Heartbeat[] = [];
    const w = new PriceWatcher({
      pollMs: 60_000, mode: "paper", clock: () => Date.now(),
      prices: async () => ({ NEAR: 1.95 }),
      onPrices: async (_p, at) => { seen.push(at); },
      heartbeat: { write: async (h) => { beats.push(h); } },
    });
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([AT]); // first poll immediately: a breach is acted on without waiting
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([AT, AT + 60_000, AT + 120_000]);
    expect(beats.map((b) => [b.status, b.mode])).toEqual([["ok", "paper"], ["ok", "paper"], ["ok", "paper"]]);
    await w.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(seen).toHaveLength(3);
  });

  it("a failed price read is logged, heartbeats say so, and the next poll retries", async () => {
    vi.useFakeTimers({ now: AT });
    let n = 0;
    const beats: Heartbeat[] = [];
    const logs: string[] = [];
    const w = new PriceWatcher({
      pollMs: 60_000, mode: "paper",
      prices: async () => { if (++n === 1) throw new Error("HTTP 503"); return { NEAR: 2 }; },
      onPrices: async () => {}, heartbeat: { write: async (h) => { beats.push(h); } }, log: (l) => logs.push(l),
    });
    w.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats.map((b) => b.status)).toEqual(["price_error", "ok"]);
    expect(logs[0]).toMatch(/HTTP 503/);
    await w.stop();
  });

  it("stop() waits for a poll in progress (an exit is never cut in half)", async () => {
    let release!: () => void;
    let finished = false;
    const w = new PriceWatcher({
      pollMs: 60_000, mode: "paper", prices: async () => ({ NEAR: 1 }),
      onPrices: () => new Promise<void>((r) => { release = () => { finished = true; r(); }; }),
      heartbeat: { write: async () => {} },
    });
    w.start();
    await new Promise((r) => setTimeout(r, 5));
    const stopping = w.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
  });
});

describe("heartbeatAlert", () => {
  const hb: Heartbeat = { at: AT, pid: 1, mode: "paper", status: "ok" };
  it("alive within 5 minutes, alert beyond, alert when missing or unhealthy", () => {
    expect(heartbeatAlert(hb, AT + HEARTBEAT_MAX_AGE_MS)).toBeNull();
    expect(heartbeatAlert(hb, AT + HEARTBEAT_MAX_AGE_MS + 1)).toMatch(/no heartbeat for 5 min/);
    expect(heartbeatAlert(undefined, AT)).toMatch(/no heartbeat/);
    expect(heartbeatAlert({ ...hb, status: "price_error", detail: "HTTP 503" }, AT)).toMatch(/price_error: HTTP 503/);
  });
});

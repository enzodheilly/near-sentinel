import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash, type RiskConfig } from "../../src/config/schema.ts";
import { loadFixtureSet, type FixtureSet } from "../../src/data/fixtures.ts";
import { runTick, type EngineDeps, type TickMarket } from "../../src/decision/engine.ts";
import { readRecord, recorder } from "../../src/decision/record.ts";
import { verifyRecord, type VerifyContext } from "../../src/decision/verify.ts";
import type { Candle, DecisionRecord, Interval, PortfolioSnapshot, Quote } from "../../src/types.ts";

const H = 3_600_000;
const A = cfg.assets;
const META = { agentVersion: "test", configHash: configHash(cfg) };
const CONFIGS = new Map<string, RiskConfig>([[META.configHash, cfg]]);

/** Deterministic replay executor: quotes at the reference price, fills at the quote. LLM approves. */
function deps(now: () => number, onDecision: NonNullable<EngineDeps["onDecision"]>): EngineDeps {
  const u = (x: number, d: number) => BigInt(Math.round(x * 1e6)) * 10n ** BigInt(d - 6);
  return {
    authenticated: true, clock: now, balances: async () => ({ USDC: 10n ** 12n, BTC: 10n ** 12n, NEAR: 10n ** 30n }),
    quote: async (p, bps) => {
      const buy = p.kind === "ENTRY";
      const usd = buy ? p.notionalUsd : p.quantity * p.referencePrice;
      const qty = buy ? usd / p.referencePrice : p.quantity;
      return { originAsset: buy ? A.USDC.assetId : A[p.asset].assetId, destinationAsset: buy ? A[p.asset].assetId : A.USDC.assetId,
        amountIn: buy ? u(usd, 6) : u(qty, A[p.asset].decimals), amountOut: buy ? u(qty, A[p.asset].decimals) : u(usd, 6), minAmountOut: 0n,
        deadline: new Date(now() + 120_000).toISOString(), receivedAt: now(), raw: { bps } } satisfies Quote;
    },
    execute: async (p) => ({ mode: "replay", status: "SIMULATED", txRefs: [],
      fill: p.kind === "ENTRY" ? { quantityIn: p.notionalUsd, quantityOut: p.quantity, price: p.referencePrice } : { quantityIn: p.quantity, quantityOut: p.quantity * p.referencePrice, price: p.referencePrice } }),
    llm: async () => ({ model: cfg.llm.model, verdict: "approve", sizeMultiplier: 1, rationale: "ok", chatId: "c" }),
    onDecision,
  };
}

const source = (set: FixtureSet): VerifyContext["candles"] => (symbol: string, interval: Interval) => set.series[symbol]?.[interval]?.candles;

/** Runs the engine bar by bar over the whole fixture, recording every decision to `dir`. */
async function fullReplay(set: FixtureSet, dir: string) {
  const near = set.series["NEARUSDT"]!["1h"]!.candles;
  const btc = set.series["BTCUSDT"]!["1h"]!.candles;
  const btc4h = set.series["BTCUSDT"]!["4h"]!.candles;
  let portfolio: PortfolioSnapshot = { at: near[200]!.openTime, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000,
    peakEquityUsd: 1000, dayStartEquityUsd: 1000, entriesToday: 0, cooldownUntil: {}, killSwitch: false };
  const executed = new MemoryKeys();
  const hashes: string[] = [];
  for (let t = 200; t < near.length; t++) {
    const barTime = near[t]!.openTime;
    const upTo = (cs: readonly Candle[]) => cs.filter((c) => c.openTime <= barTime);
    const market: TickMarket = { candles1h: { NEAR: upTo(near), BTC: upTo(btc) }, btc4h };
    const rec = recorder(dir, market, META);
    const r = await runTick({ barTime, market, portfolio, executed }, deps(() => barTime + H + 30_000, rec.sink), cfg);
    portfolio = r.portfolio;
    hashes.push(...rec.hashes);
  }
  return hashes;
}

let entrySet: FixtureSet;
let refusalSet: FixtureSet;
let dir: string;
let entryHashes: string[];
let refusalHashes: string[];

beforeAll(async () => {
  entrySet = await loadFixtureSet(new URL("../../fixtures/demo-entry/", import.meta.url).pathname);
  refusalSet = await loadFixtureSet(new URL("../../fixtures/demo-refusal/", import.meta.url).pathname);
  dir = await mkdtemp(join(tmpdir(), "verify-"));
  entryHashes = await fullReplay(entrySet, join(dir, "entry"));
  refusalHashes = await fullReplay(refusalSet, join(dir, "refusal"));
}, 60_000);

describe("verifyRecord on a full replay", () => {
  it("every record of both fixtures verifies, read back from disk", async () => {
    for (const [set, hashes, sub] of [[entrySet, entryHashes, "entry"], [refusalSet, refusalHashes, "refusal"]] as const) {
      expect(hashes.length).toBeGreaterThan(150); // two assets × ~100 bars, plus exits
      expect((await readdir(join(dir, sub))).length).toBe(new Set(hashes).size);
      for (const h of hashes) {
        const res = await verifyRecord(await readRecord(join(dir, sub), h), { configs: CONFIGS, candles: source(set), expectedHash: h });
        expect(res.problems, h).toEqual([]);
        expect(res.ok).toBe(true);
      }
    }
  }, 60_000);

  it("the replay covers trades, exits, rejections and holds", async () => {
    const recs = await Promise.all(entryHashes.map((h) => readRecord(join(dir, "entry"), h)));
    const kinds = new Set(recs.map((r) => ("proposal" in r.outcome ? `${r.outcome.action} ${r.outcome.proposal?.kind === "EXIT" ? r.outcome.proposal.reason : "ENTRY"}` : `${r.outcome.action} ${r.outcome.reason}`)));
    for (const k of ["TRADE ENTRY", "TRADE TAKE_PROFIT_1", "TRADE TAKE_PROFIT_2", "HOLD NO_SIGNAL"]) expect([...kinds]).toContain(k);
    const refusal = await Promise.all(refusalHashes.map((h) => readRecord(join(dir, "refusal"), h)));
    expect(refusal.some((r) => r.outcome.action === "REJECT" && r.outcome.reason === "VETO_RSI_EXHAUSTION")).toBe(true);
  });
});

describe("verifyRecord: a tampered record fails with a precise message", () => {
  let trade: DecisionRecord;
  let hash: string;
  const check = (r: DecisionRecord, expectedHash = hash) => verifyRecord(r, { configs: CONFIGS, candles: source(entrySet), expectedHash });
  beforeAll(async () => {
    const recs = await Promise.all(entryHashes.map(async (h) => [h, await readRecord(join(dir, "entry"), h)] as const));
    [hash, trade] = recs.find(([, r]) => r.outcome.action === "TRADE" && r.outcome.proposal.kind === "ENTRY")!;
  });

  it("a changed field is caught by the hash", async () => {
    const r = await check({ ...trade, barTime: trade.barTime });
    expect(r.ok).toBe(true);
    const bad = await check({ ...trade, agentVersion: "evil" });
    expect(bad.problems[0]).toMatch(/^hash: the record hashes to [0-9a-f]{64}, not [0-9a-f]{64}/);
  });

  it("a rewritten outcome is caught by the recomputation, even with a matching hash", async () => {
    const forged = { ...trade, outcome: { action: "REJECT" as const, reason: "LLM_VETO" as const } };
    const r = await verifyRecord(forged, { configs: CONFIGS, candles: source(entrySet) }); // no expected hash: recompute only
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/^recomputed decision differs at outcome\.action: record has "REJECT", recomputation gives "TRADE"/)]);
  });

  it("a doctored portfolio changes the size and says where", async () => {
    const p = trade.inputs.portfolio;
    const forged = { ...trade, inputs: { ...trade.inputs, portfolio: { ...p, balances: { ...p.balances, USDC: 400 } } } };
    const r = await verifyRecord(forged, { configs: CONFIGS, candles: source(entrySet) });
    expect(r.problems[0]).toMatch(/^recomputed decision differs at (checks|outcome)/);
  });

  it("a forged LLM verdict no longer matches the recorded LLM answer", async () => {
    const forged = { ...trade, llm: { ...trade.llm!, verdict: "reduce" as const, sizeMultiplier: 0.5 as const } };
    const r = await verifyRecord(forged, { configs: CONFIGS, candles: source(entrySet) });
    expect(r.problems[0]).toMatch(/differs at llm\.sizeMultiplier: record has 0\.5, recomputation gives 1/);
  });

  it("different candle data is named, window by window", async () => {
    const near = entrySet.series["NEARUSDT"]!["1h"]!.candles.map((c, i) => (i === 150 ? { ...c, close: c.close * 1.001 } : c));
    const r = await verifyRecord(trade, { configs: CONFIGS, candles: (s, iv) => (s === "NEARUSDT" && iv === "1h" ? near : source(entrySet)(s, iv)), expectedHash: hash });
    expect(r.problems).toEqual([expect.stringMatching(/^candles NEARUSDT 1h: the data does not match the record \(record 201 candles/)]);
  });

  it("an unknown configuration is reported, not guessed", async () => {
    const r = await verifyRecord(trade, { configs: new Map(), candles: source(entrySet), expectedHash: hash });
    expect(r.problems).toEqual([expect.stringMatching(/^configHash [0-9a-f]{64}: unknown configuration/)]);
  });

  it("missing or reordered externals are reported with the call number", async () => {
    const calls = trade.inputs.externals.calls;
    const cut = { ...trade, inputs: { ...trade.inputs, externals: { ...trade.inputs.externals, calls: calls.slice(0, 2) } } };
    expect((await verifyRecord(cut, { configs: CONFIGS, candles: source(entrySet) })).problems[0]).toMatch(/^externals: the recomputation asks for the clock \(call 3\), but the record has no more calls/);
    const swapped = { ...trade, inputs: { ...trade.inputs, externals: { ...trade.inputs.externals, calls: [calls[1]!, calls[0]!, ...calls.slice(2)] } } };
    expect((await verifyRecord(swapped, { configs: CONFIGS, candles: source(entrySet) })).problems[0]).toMatch(/^externals: the recomputation asks for the balances at call 1, the record has a quote there/);
  });

  it("a forged exit is not one the exit machine would produce", async () => {
    const recs = await Promise.all(entryHashes.map((h) => readRecord(join(dir, "entry"), h)));
    const exit = recs.find((r) => r.outcome.action === "TRADE" && r.outcome.proposal.kind === "EXIT")!;
    const prop = (exit.outcome as unknown as { proposal: Record<string, unknown> }).proposal;
    const forged = { ...exit, outcome: { action: "TRADE" as const, proposal: { ...prop, quantity: (prop["quantity"] as number) * 2 } } } as DecisionRecord;
    const r = await verifyRecord(forged, { configs: CONFIGS, candles: source(entrySet) });
    expect(r.problems[0]).toMatch(/^outcome\.proposal: the exit TAKE_PROFIT_1 of .* NEAR is not what the exit machine produces/);
  });
});

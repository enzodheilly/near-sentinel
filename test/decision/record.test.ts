import fc from "fast-check";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { configHash } from "../../src/config/schema.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { loadFixtureSet, windowRef } from "../../src/data/fixtures.ts";
import { runTick, type Decision, type EngineDeps, type TickMarket } from "../../src/decision/engine.ts";
import { buildRecord, decisionWindows, hashRecord, readRecord, recordBytes, recorder, writeRecord } from "../../src/decision/record.ts";
import { sha256Hex } from "../../src/lib/canonical.ts";
import type { Candle, DecisionRecord, PortfolioSnapshot, Quote } from "../../src/types.ts";

const H = 3_600_000;
const META = { agentVersion: "53499de", configHash: configHash(cfg) };

let market: TickMarket;
let barTime: number;
let decisions: readonly Decision[];
const portfolio = (at: number): PortfolioSnapshot => ({
  at, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000, peakEquityUsd: 1000, dayStartEquityUsd: 1000,
  entriesToday: 0, cooldownUntil: {}, killSwitch: false,
});

/** Same fakes as the engine tests, condensed: quotes at the reference price, fills at the quote. */
function deps(onDecision?: EngineDeps["onDecision"], now = 0): EngineDeps {
  const A = cfg.assets;
  const u = (x: number, d: number) => BigInt(Math.round(x * 1e6)) * 10n ** BigInt(d - 6);
  return {
    authenticated: true, clock: () => now, balances: async () => ({ USDC: 10n ** 12n, BTC: 10n ** 12n, NEAR: 10n ** 30n }),
    quote: async (p) => {
      const buy = p.kind === "ENTRY";
      const usd = buy ? p.notionalUsd : p.quantity * p.referencePrice;
      const qty = buy ? usd / p.referencePrice : p.quantity;
      return { originAsset: buy ? A.USDC.assetId : A[p.asset].assetId, destinationAsset: buy ? A[p.asset].assetId : A.USDC.assetId,
        amountIn: buy ? u(usd, 6) : u(qty, A[p.asset].decimals), amountOut: buy ? u(qty, A[p.asset].decimals) : u(usd, 6), minAmountOut: 0n,
        deadline: "2026-07-20T10:02:00Z", receivedAt: now, raw: { quoteId: "q-1", amountIn: "250000000" } } satisfies Quote;
    },
    execute: async (p) => ({ mode: "replay", status: "SIMULATED", txRefs: [],
      fill: p.kind === "ENTRY" ? { quantityIn: p.notionalUsd, quantityOut: p.quantity, price: p.referencePrice } : { quantityIn: p.quantity, quantityOut: p.quantity * p.referencePrice, price: p.referencePrice } }),
    llm: async () => ({ model: cfg.llm.model, verdict: "approve", sizeMultiplier: 1, rationale: "ok", chatId: "chat-1", signature: "0xsig", signingAddress: "0xabc", signatureKind: "provider_tee" }),
    ...(onDecision ? { onDecision } : {}),
  };
}

beforeAll(async () => {
  const set = await loadFixtureSet(new URL("../../fixtures/demo-entry/", import.meta.url).pathname);
  barTime = set.signalBarTime;
  const upTo = (cs: readonly Candle[]) => cs.filter((c) => c.openTime <= barTime);
  market = { candles1h: { NEAR: upTo(set.series["NEARUSDT"]!["1h"]!.candles), BTC: upTo(set.series["BTCUSDT"]!["1h"]!.candles) }, btc4h: set.series["BTCUSDT"]!["4h"]!.candles };
  decisions = (await runTick({ barTime, market, portfolio: portfolio(barTime), executed: new Set() }, deps(undefined, barTime + H + 30_000), cfg)).decisions;
});

const tradeRecord = (): DecisionRecord => {
  const d = decisions.find((x) => x.outcome.action === "TRADE")!;
  return buildRecord(d, decisionWindows(market, d.asset, d.barTime), META);
};

describe("buildRecord", () => {
  it("captures inputs, signals, checks, LLM evidence and outcome of the demo-entry trade", () => {
    const r = tradeRecord();
    expect(r).toMatchObject({ version: 1, agentVersion: "53499de", configHash: META.configHash, asset: "NEAR", barTime, outcome: { action: "TRADE" } });
    expect(r.inputs.candles.map((c) => `${c.symbol} ${c.interval}`)).toEqual(["NEARUSDT 1h", "BTCUSDT 1h", "BTCUSDT 4h"]);
    expect(r.inputs.candles[0]).toMatchObject({ lastOpenTime: barTime, count: 201 });
    expect(r.inputs.quote).toEqual({ quoteId: "q-1", amountIn: "250000000" });
    expect(r.llm).toMatchObject({ verdict: "approve", signature: "0xsig", signatureKind: "provider_tee" });
    expect(r.signals.map((s) => s.kind)).toEqual(["BB_BREAKOUT", "RSI_MOMENTUM", "FVG_SUPPORT", "BTC_REGIME"]);
  });

  it("the BTC 4h window holds only candles closed by the bar's close; a BTC decision has no separate BTC 1h", () => {
    const r = tradeRecord();
    const w4 = r.inputs.candles.find((c) => c.interval === "4h")!;
    expect(w4.lastOpenTime + 4 * H).toBeLessThanOrEqual(barTime + H);
    expect(decisionWindows(market, "BTC", barTime).map((c) => `${c.symbol} ${c.interval}`)).toEqual(["BTCUSDT 1h", "BTCUSDT 4h"]);
  });

  it("the candle refs are the hashes of exactly the candles the engine read", () => {
    const own = market.candles1h.NEAR.filter((c) => c.openTime <= barTime);
    expect(tradeRecord().inputs.candles[0]!.sha256).toBe(windowRef("NEARUSDT", "1h", own).sha256);
  });

  it("rejections and holds are recorded too", () => {
    const hold = decisions.find((x) => x.outcome.action === "HOLD")!;
    const r = buildRecord(hold, decisionWindows(market, hold.asset, barTime), META);
    expect(r.outcome).toEqual({ action: "HOLD", reason: "NO_SIGNAL" });
    expect(r).not.toHaveProperty("llm");
    expect(r.inputs).not.toHaveProperty("quote");
  });
});

describe("hashRecord", () => {
  it("same inputs → same hash, byte for byte, across independent runs", async () => {
    const again = (await runTick({ barTime, market, portfolio: portfolio(barTime), executed: new Set() }, deps(undefined, barTime + H + 30_000), cfg)).decisions;
    const d = again.find((x) => x.outcome.action === "TRADE")!;
    const r2 = buildRecord(d, decisionWindows(market, d.asset, d.barTime), META);
    expect(recordBytes(r2)).toBe(recordBytes(tradeRecord()));
    expect(hashRecord(r2)).toBe(hashRecord(tradeRecord()));
    expect(hashRecord(tradeRecord())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("property: key order never changes the hash (RFC 8785)", () => {
    const shuffle = (v: unknown, seed: number): unknown => {
      if (Array.isArray(v)) return v.map((x) => shuffle(x, seed));
      if (v && typeof v === "object") {
        const keys = Object.keys(v);
        const order = keys.map((k, i) => [k, Math.sin(seed * (i + 1)) ] as const).sort((a, b) => a[1] - b[1]).map(([k]) => k);
        return Object.fromEntries(order.map((k) => [k, shuffle((v as Record<string, unknown>)[k], seed)]));
      }
      return v;
    };
    const base = tradeRecord();
    fc.assert(fc.property(fc.integer({ min: 1, max: 1e6 }), (seed) => {
      expect(hashRecord(shuffle(base, seed) as DecisionRecord)).toBe(hashRecord(base));
    }), { numRuns: 50 });
  });

  it("tampered record → different hash, whatever field is touched", () => {
    const base = tradeRecord();
    const h = hashRecord(base);
    const tampered: DecisionRecord[] = [
      { ...base, barTime: base.barTime + 1 },
      { ...base, configHash: "0".repeat(64) },
      { ...base, outcome: { action: "REJECT", reason: "LLM_VETO" } },
      { ...base, llm: { ...base.llm!, verdict: "reduce" } },
      { ...base, inputs: { ...base.inputs, portfolio: { ...base.inputs.portfolio, equityUsd: 1000.000001 } } },
      { ...base, signals: base.signals.slice(1) },
      { ...base, checks: base.checks.map((c, i) => (i === 0 ? { ...c, ok: !c.ok } : c)) },
      { ...base, inputs: { ...base.inputs, candles: base.inputs.candles.map((c, i) => (i === 0 ? { ...c, sha256: "f".repeat(64) } : c)) } },
    ];
    for (const t of tampered) expect(hashRecord(t)).not.toBe(h);
  });
});

describe("writeRecord / readRecord", () => {
  it("writes <hash>.json whose bytes hash to its name; writing twice is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "records-"));
    const r = tradeRecord();
    const h = await writeRecord(dir, r);
    expect(h).toBe(hashRecord(r));
    const bytes = await readFile(join(dir, `${h}.json`), "utf8");
    expect(sha256Hex(bytes)).toBe(h);
    expect(await writeRecord(dir, r)).toBe(h);
    expect(await readRecord(dir, h)).toEqual(JSON.parse(recordBytes(r)));
  });

  it("readRecord refuses a file edited after it was written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "records-"));
    const h = await writeRecord(dir, tradeRecord());
    const p = join(dir, `${h}.json`);
    await writeFile(p, (await readFile(p, "utf8")).replace('"TRADE"', '"REJECT"'));
    await expect(readRecord(dir, h)).rejects.toThrow(/modified after it was written/);
  });
});

describe("recorder (engine sink)", () => {
  it("records every decision of a tick before its trade executes, and anchors each hash first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "records-"));
    const log: string[] = [];
    const rec = recorder(dir, market, META, async (h) => { log.push(`anchor ${h.slice(0, 8)}`); });
    const d = deps(async (x) => { await rec.sink(x); log.push(`recorded ${x.asset} ${x.outcome.action}`); }, barTime + H + 30_000);
    const exec = d.execute;
    const r = await runTick({ barTime, market, portfolio: portfolio(barTime), executed: new Set() },
      { ...d, execute: async (p, q) => { log.push("execute"); return exec(p, q); } }, cfg);
    expect(rec.hashes).toHaveLength(r.decisions.length);
    expect(log.map((l) => l.replace(/[0-9a-f]{8}$/, "#"))).toEqual(["anchor #", "recorded BTC HOLD", "anchor #", "recorded NEAR TRADE", "execute"]);
    for (const h of rec.hashes) expect((await readRecord(dir, h)).barTime).toBe(barTime);
  });
});

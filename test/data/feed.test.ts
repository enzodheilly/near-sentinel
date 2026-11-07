import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { BinanceClient, BinanceError } from "../../src/data/binance.ts";
import { CandleArchive, contiguousTail, findGaps, isStale, MarketFeed } from "../../src/data/feed.ts";
import { entryGate } from "../../src/decision/limits.ts";
import { marketFacts } from "../../src/decision/engine.ts";
import type { Candle, PortfolioSnapshot } from "../../src/types.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-11-07T00:00:00Z");
const candle = (openTime: number, close = 2.5): Candle => ({ openTime, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10 });
/** Binance kline row: [openTime, "o", "h", "l", "c", "v", closeTime, ...] */
const row = (c: Candle, step: number) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.openTime + step - 1, "0", 1, "0", "0", "0"];

type Series = Record<string, Candle[]>;
const fakeBinance = (series: Series, calls: string[] = []) =>
  (async (u: string) => {
    const url = new URL(u);
    calls.push(url.search);
    const key = `${url.searchParams.get("symbol")}-${url.searchParams.get("interval")}`;
    const step = url.searchParams.get("interval") === "4h" ? 4 * H : H;
    const limit = Number(url.searchParams.get("limit"));
    return new Response(JSON.stringify((series[key] ?? []).slice(-limit).map((c) => row(c, step))), { status: 200 });
  }) as unknown as typeof fetch;

const run = (n: number, step: number, from = T0 - n * step) => Array.from({ length: n }, (_, i) => candle(from + i * step, 2.5 + i * 0.001));

describe("BinanceClient", () => {
  it("drops the candle that is not closed yet", async () => {
    const now = T0 + 30 * 60_000; // 00:30: the 00:00 candle is still open
    const series = { "NEARUSDT-1h": [...run(3, H), candle(T0)] };
    const c = await new BinanceClient({ fetch: fakeBinance(series) }).closedCandles({ symbol: "NEARUSDT", interval: "1h", limit: 10 }, now);
    expect(c.map((x) => x.openTime)).toEqual([T0 - 3 * H, T0 - 2 * H, T0 - H]);
    expect(c[0]).toEqual({ openTime: T0 - 3 * H, open: 2.5, high: 2.525, low: 2.475, close: 2.5, volume: 10 });
  });

  it("the candle closing exactly at now counts as closed", async () => {
    const c = await new BinanceClient({ fetch: fakeBinance({ "NEARUSDT-1h": run(2, H) }) }).closedCandles({ symbol: "NEARUSDT", interval: "1h", limit: 10 }, T0);
    expect(c).toHaveLength(2);
  });

  it.each([
    [429, "rate_limit"], [418, "rate_limit"], [451, "region"], [500, "http"],
  ])("HTTP %i → %s", async (status, kind) => {
    const f = (async () => new Response("x", { status })) as unknown as typeof fetch;
    const e = await new BinanceClient({ fetch: f }).closedCandles({ symbol: "X", interval: "1h", limit: 1 }, T0).catch((x: unknown) => x);
    expect((e as BinanceError).kind).toBe(kind);
  });

  it("a malformed or inconsistent row is a schema error, never a NaN candle", async () => {
    for (const body of [[[1, "a", "1", "1", "1", "1", 2]], [[T0 - H, "2", "1", "3", "2", "1", T0 - 1]], { code: -1 }]) {
      const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
      const e = await new BinanceClient({ fetch: f }).closedCandles({ symbol: "X", interval: "1h", limit: 5 }, T0).catch((x: unknown) => x);
      expect((e as BinanceError).kind).toBe("schema");
    }
  });
});

describe("gaps and staleness", () => {
  it("finds missing candles and keeps the contiguous tail", () => {
    const c = run(6, H).filter((_, i) => i !== 2);
    expect(findGaps(c, "1h")).toEqual([T0 - 4 * H]);
    expect(contiguousTail(c, "1h").map((x) => x.openTime)).toEqual([T0 - 3 * H, T0 - 2 * H, T0 - H]);
  });

  it("stale beyond 1.5 bars", () => {
    const last = candle(T0 - H); // closes at T0
    expect(isStale(last, "1h", T0 + 1.5 * H, 1.5)).toBe(false);
    expect(isStale(last, "1h", T0 + 1.5 * H + 1, 1.5)).toBe(true);
    expect(isStale(undefined, "1h", T0, 1.5)).toBe(true);
  });
});

const fresh = (now: number): Series => ({
  "NEARUSDT-1h": run(500, H, now - 500 * H),
  "BTCUSDT-1h": run(500, H, now - 500 * H),
  "BTCUSDT-4h": run(300, 4 * H, now - 300 * 4 * H),
});
const portfolio: PortfolioSnapshot = { at: T0, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000, peakEquityUsd: 1000,
  dayStartEquityUsd: 1000, entriesToday: 0, cooldownUntil: {}, killSwitch: false };

describe("MarketFeed", () => {
  it("a fresh snapshot: three series, bar time = last closed NEAR candle, no problems, archived", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feed-"));
    const archive = new CandleArchive(dir);
    const s = await new MarketFeed(cfg, new BinanceClient({ fetch: fakeBinance(fresh(T0)) }), archive).snapshot(T0 + 60_000);
    expect(s.problems).toEqual([]);
    expect(s.barTime).toBe(T0 - H);
    expect(s.market.candles1h.NEAR).toHaveLength(500);
    expect(s.market.btc4h).toHaveLength(300);
    expect(await archive.read("NEARUSDT", "1h")).toEqual(s.market.candles1h.NEAR);
  });

  it("a gap cuts the history after it and is reported", async () => {
    const series = fresh(T0);
    series["NEARUSDT-1h"] = series["NEARUSDT-1h"]!.filter((_, i) => i !== 450);
    const s = await new MarketFeed(cfg, new BinanceClient({ fetch: fakeBinance(series) })).snapshot(T0 + 60_000);
    expect(s.problems.join()).toMatch(/NEAR 1h: 1 missing candle/);
    expect(s.market.candles1h.NEAR).toHaveLength(49);
  });

  it("stale data is reported and the engine gate refuses entries (STALE_DATA)", async () => {
    const now = T0 + 2 * H; // last closed candle ended at T0, 2 bars ago
    const s = await new MarketFeed(cfg, new BinanceClient({ fetch: fakeBinance(fresh(T0)) })).snapshot(now);
    expect(s.problems.filter((p) => p.includes("stale"))).toHaveLength(2); // the two 1h series; 4h is still within 1.5 bars
    const gate = entryGate(portfolio, marketFacts(s.market, s.barTime!, portfolio).freshness, now, cfg.limits);
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.reason).toBe("STALE_DATA");
  });

  it("a candle revised at the source after archiving: the archived value is kept and reported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feed-"));
    const archive = new CandleArchive(dir);
    const series = fresh(T0);
    await new MarketFeed(cfg, new BinanceClient({ fetch: fakeBinance(series) }), archive).snapshot(T0 + 60_000);
    const original = series["NEARUSDT-1h"]!.at(-1)!;
    series["NEARUSDT-1h"]![series["NEARUSDT-1h"]!.length - 1] = { ...original, close: 9 , high: 9 };
    const s = await new MarketFeed(cfg, new BinanceClient({ fetch: fakeBinance(series) }), archive).snapshot(T0 + 60_000);
    expect(s.problems.join()).toMatch(/changed at the source/);
    expect(s.market.candles1h.NEAR.at(-1)).toEqual(original);
  });
});


/** Live market feed check (network, pnpm test:live): Binance data-api, three series, closed and fresh. */
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { BinanceClient } from "../../src/data/binance.ts";
import { MarketFeed } from "../../src/data/feed.ts";

describe("market feed live", () => {
  it("NEAR 1h, BTC 1h, BTC 4h: closed, contiguous, fresh", async () => {
    const now = Date.now();
    const s = await new MarketFeed(cfg, new BinanceClient()).snapshot(now);
    console.log(`feed: NEAR ${s.market.candles1h.NEAR.at(-1)?.close} BTC ${s.market.candles1h.BTC.at(-1)?.close}, last bar ${new Date(s.barTime!).toISOString()}`);
    expect(s.problems).toEqual([]);
    expect(s.market.candles1h.NEAR.length).toBeGreaterThan(cfg.warmupBars.exec);
    expect(s.barTime! + 3_600_000).toBeLessThanOrEqual(now);
  }, 30_000);
});

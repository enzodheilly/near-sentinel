import { describe, expect, it } from "vitest";
import { hyperliquidCandles } from "../../src/data/hyperliquid.ts";

describe("hyperliquidCandles", () => {
  it("asks the info endpoint for a candle snapshot and returns [t, o, h, l, c], oldest first", async () => {
    let body: unknown;
    const f = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify([
        { t: 1000, T: 1999, s: "NEAR", i: "15m", o: "3.5", c: "3.6", h: "3.62", l: "3.48", v: "10", n: 4 },
        { t: 2000, T: 2999, s: "NEAR", i: "15m", o: "3.6", c: "3.55", h: "3.5", l: "3.4", v: "1", n: 1 }, // high below open: dropped
        { t: 3000, T: 3999, s: "NEAR", i: "15m", o: "3.6", c: "3.55", h: "3.61", l: "3.5", v: "1", n: 1 },
      ]));
    }) as unknown as typeof fetch;
    const now = 10_000_000;
    const out = await hyperliquidCandles("NEAR", "15m", 2, now, { fetch: f });
    expect(body).toEqual({ type: "candleSnapshot", req: { coin: "NEAR", interval: "15m", startTime: now - 3 * 900_000, endTime: now } });
    expect(out).toEqual([[1000, 3.5, 3.62, 3.48, 3.6], [3000, 3.6, 3.61, 3.5, 3.55]]);
  });

  it("reports an HTTP error or a malformed answer", async () => {
    const http = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(hyperliquidCandles("NEAR", "1h", 5, 0, { fetch: http })).rejects.toThrow(/HTTP 500/);
    const bad = (async () => new Response(JSON.stringify([{ t: "x" }]))) as unknown as typeof fetch;
    await expect(hyperliquidCandles("NEAR", "1h", 5, 0, { fetch: bad })).rejects.toThrow(/unexpected answer/);
  });
});

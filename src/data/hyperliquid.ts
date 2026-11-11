/**
 * Hyperliquid market data for the dashboard chart only (never for decisions): NEAR perpetual candles, the market
 * near.com's perps trade on. Public, keyless. REST snapshot from the info endpoint; the page then follows the live
 * candle over Hyperliquid's WebSocket (wss://api.hyperliquid.xyz/ws).
 */

import { z } from "zod";

export const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws";

/** Chart intervals the dashboard offers (Hyperliquid names). */
export const CHART_INTERVALS = ["15m", "30m", "1h", "4h", "1d", "1w", "1M"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

const STEP_MS: Record<ChartInterval, number> = { "15m": 9e5, "30m": 18e5, "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5, "1M": 31 * 864e5 };

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);
const candle = z.object({ t: z.number().int(), o: num, h: num, l: num, c: num });

/** [openTime, open, high, low, close], oldest first, the candle still forming included. */
export type ChartCandle = [number, number, number, number, number];

export async function hyperliquidCandles(
  coin: string, interval: ChartInterval, count: number, now: number,
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChartCandle[]> {
  const body = { type: "candleSnapshot", req: { coin, interval, startTime: now - (count + 1) * STEP_MS[interval], endTime: now } };
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(HYPERLIQUID_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
  } catch (e) {
    throw new Error(`Hyperliquid candles: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Hyperliquid candles: HTTP ${res.status}`);
  const parsed = z.array(candle).safeParse(await res.json());
  if (!parsed.success) throw new Error(`Hyperliquid candles: unexpected answer (${parsed.error.issues[0]?.message})`);
  return parsed.data
    .filter((k) => k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c) && k.l > 0)
    .map((k): ChartCandle => [k.t, k.o, k.h, k.l, k.c])
    .slice(-count);
}

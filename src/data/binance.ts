/**
 * Binance market data (keyless): https://data-api.binance.vision/api/v3/klines, the host dedicated to public
 * market data. Closed candles only: a candle whose close time is not yet past `now` is dropped.
 * Every row is validated; anything unexpected is a BinanceError with a kind, never a silent NaN.
 */

import { z } from "zod";
import { INTERVAL_MS, type Candle, type Interval } from "../types.ts";

export const BINANCE_BASE = "https://data-api.binance.vision";
export const MARKET_USER_AGENT = "near-sentinel/0.1 (+https://github.com/enzodheilly/near-sentinel)";

export type BinanceErrorKind = "network" | "timeout" | "rate_limit" | "region" | "http" | "schema";

export class BinanceError extends Error {
  readonly kind: BinanceErrorKind;
  readonly status: number | undefined;
  constructor(kind: BinanceErrorKind, message: string, status?: number) {
    super(`Binance klines: ${message}`);
    this.kind = kind;
    this.status = status;
  }
}

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).transform(Number);
/** [openTime, open, high, low, close, volume, closeTime, ...] */
const row = z.tuple([z.number().int(), num, num, num, num, num, z.number().int()]).rest(z.unknown());
const rows = z.array(row);

export interface KlineQuery {
  readonly symbol: string;
  readonly interval: Interval;
  readonly limit: number; // ≤ 1000
  readonly endTime?: number;
}

export interface BinanceOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class BinanceClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: BinanceOptions = {}) {
    this.base = (o.baseUrl ?? BINANCE_BASE).replace(/\/$/, "");
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  /** The latest `limit` candles of `symbol`, closed at `now`, oldest first. */
  async closedCandles(q: KlineQuery, now: number): Promise<Candle[]> {
    const qs = new URLSearchParams({ symbol: q.symbol, interval: q.interval, limit: String(Math.min(1000, q.limit + 1)), ...(q.endTime ? { endTime: String(q.endTime) } : {}) });
    let res: Response;
    try {
      res = await this.f(`${this.base}/api/v3/klines?${qs}`, { headers: { accept: "application/json", "user-agent": MARKET_USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const t = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new BinanceError(t ? "timeout" : "network", t ? `no answer within ${this.timeoutMs} ms` : e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    if (res.status === 429 || res.status === 418) throw new BinanceError("rate_limit", `HTTP ${res.status}: rate limited`, res.status);
    if (res.status === 451) throw new BinanceError("region", "HTTP 451: not available from this region", 451);
    if (!res.ok) throw new BinanceError("http", `HTTP ${res.status}: ${text.slice(0, 160)}`, res.status);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BinanceError("schema", `answer is not JSON: ${text.slice(0, 160)}`, res.status);
    }
    const parsed = rows.safeParse(json);
    if (!parsed.success) throw new BinanceError("schema", `unexpected row at ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`, res.status);
    const step = INTERVAL_MS[q.interval];
    const out: Candle[] = [];
    for (const [openTime, open, high, low, close, volume] of parsed.data) {
      if (openTime + step > now) continue; // not closed yet
      if (!(high >= Math.max(open, close) && low <= Math.min(open, close) && low > 0 && volume >= 0)) {
        throw new BinanceError("schema", `inconsistent candle at ${new Date(openTime).toISOString()}`);
      }
      out.push({ openTime, open, high, low, close, volume });
    }
    return out.slice(-q.limit);
  }
}

/**
 * Price watcher and heartbeat (RISK_ENGINE.md §5.6).
 *
 * NEAR Intents has no resting stop orders, so between candle closes the agent polls the reference price every
 * `cfg.execution.watcherPollSec` (60 s) and hands it to `onPrices`, which runs the engine's watcher step: a
 * breached stop or target exits immediately. Polls never overlap; a failed price read is logged and retried
 * at the next poll, it never stops the watcher.
 *
 * Every poll writes a heartbeat. If no heartbeat is written for 5 minutes the agent is not protecting its
 * positions: `heartbeatAlert` says so (used by `pnpm status`, the run loop and any external cron).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TradableAsset } from "../types.ts";

export const HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

export interface Heartbeat {
  readonly at: number;
  readonly pid: number;
  readonly mode: string;
  readonly status: "ok" | "price_error" | "watch_error";
  readonly prices?: Partial<Record<TradableAsset, number>>;
  readonly detail?: string;
}

export interface HeartbeatSink {
  write(h: Heartbeat): Promise<void>;
}

export class FileHeartbeat implements HeartbeatSink {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async write(h: Heartbeat) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, `${JSON.stringify(h)}\n`);
    await rename(`${this.path}.tmp`, this.path);
  }
}

export async function readHeartbeat(path: string): Promise<Heartbeat | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Heartbeat;
  } catch {
    return undefined;
  }
}

/** An alert when the last heartbeat is missing or older than `maxAgeMs`; null when the agent is alive. */
export function heartbeatAlert(h: Heartbeat | undefined, now: number, maxAgeMs = HEARTBEAT_MAX_AGE_MS): string | null {
  if (!h) return "no heartbeat: the agent has not run (open positions are not watched)";
  const age = now - h.at;
  if (age > maxAgeMs) return `no heartbeat for ${Math.round(age / 60_000)} min (last ${new Date(h.at).toISOString()}): open positions are not watched`;
  if (h.status !== "ok") return `last heartbeat reports ${h.status}${h.detail ? `: ${h.detail}` : ""}`;
  return null;
}

export interface WatcherOptions {
  readonly pollMs: number;
  readonly mode: string;
  readonly prices: () => Promise<Partial<Record<TradableAsset, number>>>;
  /** Runs the engine's watcher step on these prices (exits only). */
  readonly onPrices: (prices: Partial<Record<TradableAsset, number>>, at: number) => Promise<void>;
  readonly heartbeat: HeartbeatSink;
  readonly clock?: () => number;
  readonly log?: (line: string) => void;
}

export class PriceWatcher {
  private readonly o: WatcherOptions;
  private readonly clock: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(o: WatcherOptions) {
    this.o = o;
    this.clock = o.clock ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Stops polling and waits for a poll in progress to finish (an exit is never cut in half). */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One poll: read prices, run the watcher step, write the heartbeat. Never throws. */
  async pollOnce(): Promise<void> {
    const at = this.clock();
    let prices: Partial<Record<TradableAsset, number>>;
    try {
      prices = await this.o.prices();
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.o.log?.(`watcher: price read failed (${detail}); retry in ${this.o.pollMs / 1000} s`);
      await this.beat({ at, status: "price_error", detail });
      return;
    }
    try {
      await this.o.onPrices(prices, at);
      await this.beat({ at, status: "ok", prices });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.o.log?.(`watcher: exit step failed (${detail})`);
      await this.beat({ at, status: "watch_error", prices, detail });
    }
  }

  private async beat(h: Omit<Heartbeat, "pid" | "mode">) {
    try {
      await this.o.heartbeat.write({ ...h, pid: process.pid, mode: this.o.mode });
    } catch (e) {
      this.o.log?.(`watcher: heartbeat not written (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.pollOnce().finally(() => {
        this.inFlight = undefined;
        this.schedule(this.o.pollMs);
      });
    }, ms);
  }
}

/**
 * Idempotency registry (ARCHITECTURE.md §12): a trade key `(asset, barTime, reason)` executes at most once,
 * including across restarts.
 *
 * A key is written as `pending` BEFORE the trade is sent and as `done` after it settles. A crash between the
 * two leaves it `pending`: on restart it still counts as executed (refused as DUPLICATE) and is listed by
 * `pending()` for the owner to reconcile against the chain. Buying twice is worse than missing one trade.
 * Only a failure known for certain (FAILED, REFUNDED) releases the key.
 *
 * Storage: one JSON object per line, appended and fsynced; the last line for a key wins. Readable with any tool.
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type KeyState = "pending" | "done" | "released";

/** What the engine needs: a set it can ask, and a two-step write around each execution. */
export interface ExecutedKeys {
  has(key: string): boolean;
  begin(key: string): void;
  complete(key: string): void;
  release(key: string): void;
}

/** In-memory registry, for tests and replays that do not need to survive a restart. */
export class MemoryKeys implements ExecutedKeys {
  protected readonly state = new Map<string, KeyState>();
  has(key: string): boolean {
    const s = this.state.get(key);
    return s === "pending" || s === "done";
  }
  begin(key: string): void {
    if (this.has(key)) throw new Error(`idempotency: ${key} already ${this.state.get(key)}`);
    this.set(key, "pending");
  }
  complete(key: string): void {
    this.set(key, "done");
  }
  release(key: string): void {
    this.set(key, "released");
  }
  pending(): string[] {
    return [...this.state].filter(([, s]) => s === "pending").map(([k]) => k);
  }
  protected set(key: string, s: KeyState): void {
    this.state.set(key, s);
  }
}

/** File-backed registry: every change is on disk before the call returns. */
export class FileKeys extends MemoryKeys {
  private readonly path: string;
  private readonly clock: () => number;
  constructor(path: string, clock: () => number = Date.now) {
    super();
    this.path = path;
    this.clock = clock;
    if (existsSync(path)) {
      for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
        if (!line.trim()) continue;
        let e: { key?: unknown; state?: unknown };
        try {
          e = JSON.parse(line) as typeof e;
        } catch {
          throw new Error(`idempotency: ${path} line ${i + 1} is not valid JSON; refusing to start rather than risk a double trade`);
        }
        if (typeof e.key !== "string" || !["pending", "done", "released"].includes(e.state as string)) {
          throw new Error(`idempotency: ${path} line ${i + 1} is malformed; refusing to start rather than risk a double trade`);
        }
        this.state.set(e.key, e.state as KeyState);
      }
    } else mkdirSync(dirname(path), { recursive: true });
  }
  protected override set(key: string, s: KeyState): void {
    const fd = openSync(this.path, "a");
    try {
      appendFileSync(fd, `${JSON.stringify({ key, state: s, at: this.clock() })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    super.set(key, s);
  }
}

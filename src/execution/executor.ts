/**
 * Executor contract (ARCHITECTURE.md §5, §7) and the one place where a trade is actually sent.
 *
 * Every mode (replay, paper, live) implements `Executor`. `executeOnce` wraps a call with the idempotency
 * registry: refused if the key is already pending or done; marked pending before the call; done after a
 * fill; released only on a certain failure (FAILED, REFUNDED). A throw leaves it pending (outcome unknown).
 */

import { idempotencyKey, type ExecutionReport, type Executor, type Quote, type TradeProposal } from "../types.ts";
import type { ExecutedKeys } from "./idempotency.ts";

export type { Executor };

export class DuplicateExecutionError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`refusing to execute ${key} twice`);
    this.key = key;
  }
}

export async function executeOnce(executor: Pick<Executor, "execute">, keys: ExecutedKeys, p: TradeProposal, q: Quote): Promise<ExecutionReport> {
  const key = idempotencyKey(p);
  if (keys.has(key)) throw new DuplicateExecutionError(key);
  keys.begin(key);
  const report = await executor.execute(p, q); // a throw here leaves the key pending: outcome unknown
  if (report.status === "FAILED" || report.status === "REFUNDED") keys.release(key);
  else keys.complete(key);
  return report;
}

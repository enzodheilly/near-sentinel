/**
 * On-chain anchoring of decision hashes (ARCHITECTURE.md §9–10, contract `record_decision`).
 *
 * In live mode every decision record's hash is written to the guardrail contract BEFORE its trade executes.
 * If anchoring fails, the error propagates out of the engine's `onDecision`, so the trade is never executed
 * (the record stays on disk, unanchored, and the next tick starts over; trades executed earlier in the same
 * step are kept by the runner, see `StepAborted`). A TRADE refused by the contract
 * (paused, daily cap) is refused for the agent too: the contract is the last word. Exits are anchored as EXIT,
 * which the contract always accepts: a cap or a pause must never keep the agent from cutting a loss.
 *
 * `verify` uses `lookup` to check that a record's hash is on chain with the same kind.
 */

/** TRADE is a new position (counted, refused while paused); EXIT closes or reduces one (never blocked). */
export type AnchorKind = "TRADE" | "REJECT" | "HOLD" | "EXIT";

export interface AnchorEntry {
  readonly hash: string;
  readonly kind: AnchorKind;
  readonly recorded_at_ms: number;
  readonly seq: number;
}

export interface Anchor {
  record(hash: string, kind: AnchorKind): Promise<number>;
  lookup(hash: string): Promise<AnchorEntry | null>;
  /** Pauses the contract (kill switch). The agent key may pause; only the owner can unpause. */
  pause?(): Promise<void>;
}

export class AnchorError extends Error {
  readonly hash: string;
  constructor(hash: string, message: string) {
    super(`anchor ${hash.slice(0, 12)}…: ${message}`);
    this.hash = hash;
  }
}

/** The subset of a near-kit `Near` the anchor needs. */
export interface NearLike {
  call<T>(contractId: string, method: string, args: object, options: { signerId: string; gas?: string; waitUntil?: "FINAL" }): Promise<T>;
  view<T>(contractId: string, method: string, args: object): Promise<T | undefined>;
}

/** The JSON value a function call returned, from its execution outcome (`status.SuccessValue`, base64). */
export function callResult<T>(outcome: unknown): T {
  const v = (outcome as { status?: { SuccessValue?: string } } | null)?.status?.SuccessValue;
  if (v === undefined) return outcome as T; // already a plain value (test doubles)
  const text = Buffer.from(v, "base64").toString("utf8");
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export class ContractAnchor implements Anchor {
  private readonly near: NearLike;
  private readonly contractId: string;
  private readonly agentId: string;
  private readonly warn: (msg: string) => void;
  /** The deployed contract predates EXIT: exits are anchored as TRADE (subject to its cap and pause). */
  legacyExits = false;
  constructor(o: { near: NearLike; contractId: string; agentId: string; warn?: (msg: string) => void }) {
    this.warn = o.warn ?? (() => {});
    this.near = o.near;
    this.contractId = o.contractId;
    this.agentId = o.agentId;
  }
  async record(hash: string, kind: AnchorKind): Promise<number> {
    const send = async (k: AnchorKind) => callResult<number>(await this.near.call<unknown>(this.contractId, "record_decision", { hash, kind: k }, { signerId: this.agentId, gas: "30 Tgas" }));
    try {
      if (kind === "EXIT" && this.legacyExits) return await send("TRADE");
      return await send(kind);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (kind === "EXIT" && !this.legacyExits && /unknown variant/i.test(m)) {
        // a contract deployed before EXIT existed: still anchor the exit, as the old contract understands it
        this.legacyExits = true;
        this.warn(`ALERT ${this.contractId} predates EXIT: exits are anchored as TRADE, so its daily cap and pause can block a stop. Redeploy the contract (scripts/deploy-guardrail.ts --upgrade).`);
        try {
          return await send("TRADE");
        } catch (e2) {
          throw new AnchorError(hash, e2 instanceof Error ? e2.message : String(e2));
        }
      }
      throw new AnchorError(hash, m);
    }
  }
  async pause(): Promise<void> {
    await this.near.call<unknown>(this.contractId, "pause", {}, { signerId: this.agentId, gas: "30 Tgas" });
  }
  async lookup(hash: string): Promise<AnchorEntry | null> {
    return (await this.near.view<AnchorEntry | null>(this.contractId, "get_decision", { hash })) ?? null;
  }
}

/** In-memory stand-in with the contract's rules that matter here (tests, offline paper runs). */
export class MemoryAnchor implements Anchor {
  readonly entries = new Map<string, AnchorEntry>();
  private readonly clock: () => number;
  failWith: string | undefined;
  paused = false;
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }
  async record(hash: string, kind: AnchorKind): Promise<number> {
    if (this.failWith) throw new AnchorError(hash, this.failWith);
    if (this.entries.has(hash)) throw new AnchorError(hash, "decision already recorded");
    const seq = this.entries.size + 1;
    this.entries.set(hash, { hash, kind, recorded_at_ms: this.clock(), seq });
    return seq;
  }
  async pause(): Promise<void> {
    this.paused = true;
  }
  async lookup(hash: string): Promise<AnchorEntry | null> {
    return this.entries.get(hash) ?? null;
  }
}

/** The recorder's `anchor` hook: awaits the on-chain write; any failure stops the trade. */
export const anchorHook = (a: Anchor) => async (hash: string, kind: AnchorKind): Promise<void> => {
  await a.record(hash, kind);
};

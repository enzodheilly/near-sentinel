/**
 * Paper executor (ARCHITECTURE.md §7): real market, zero funds at risk.
 *
 * - Quote: a real 1Click quote with `dry: true` (nothing is reserved, nothing is signed). Amounts, fees and
 *   minAmountOut are 1Click's, so the §7.2 checks run on real prices and the partner fee schedule.
 * - Fill: simulated at the quote's `amountOut`, the amount 1Click says would be delivered after its fees.
 *   No slippage beyond the quote is invented; a real fill could be worse, down to minAmountOut.
 * - Balances: simulated in base units, persisted after every fill (atomic write), so a restart resumes the
 *   same paper portfolio. A full exit sells what is held when float arithmetic rounds a few units above it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RiskConfig } from "../config/schema.ts";
import type { AssetSymbol, ExecutionReport, Executor, Quote, TradeProposal } from "../types.ts";
import type { OneClickClient, QuoteRequest } from "./oneclick.ts";
import { toBase, toHuman } from "./units.ts";

export const PAPER_ACCOUNT = "near-sentinel-paper.near";

export type Balances = Record<AssetSymbol, bigint>;

/** Where paper balances live between runs. */
export interface BalanceStore {
  load(): Promise<Balances | undefined>;
  save(b: Readonly<Balances>): Promise<void>;
}

export class MemoryBalanceStore implements BalanceStore {
  private b: Balances | undefined;
  constructor(initial?: Balances) {
    this.b = initial ? { ...initial } : undefined;
  }
  async load() {
    return this.b ? { ...this.b } : undefined;
  }
  async save(b: Readonly<Balances>) {
    this.b = { ...b };
  }
}

/** JSON file, amounts as strings of base units; written to a temp file then renamed. */
export class FileBalanceStore implements BalanceStore {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<Balances | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const j = JSON.parse(text) as { balances?: Record<string, string> };
    const b = j.balances ?? {};
    for (const k of ["USDC", "BTC", "NEAR"]) if (!/^\d+$/.test(b[k] ?? "")) throw new Error(`${this.path}: balance ${k} is not a base-unit integer`);
    return { USDC: BigInt(b["USDC"]!), BTC: BigInt(b["BTC"]!), NEAR: BigInt(b["NEAR"]!) };
  }
  async save(b: Readonly<Balances>) {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ mode: "paper", updatedAt: new Date().toISOString(), balances: { USDC: b.USDC.toString(), BTC: b.BTC.toString(), NEAR: b.NEAR.toString() } }, null, 2)}\n`);
    await rename(tmp, this.path);
  }
}

export interface PaperOptions {
  readonly cfg: RiskConfig;
  readonly client: Pick<OneClickClient, "quote" | "toQuote">;
  readonly store: BalanceStore;
  /** Used when the store is empty (first run), in human units. */
  readonly start?: Readonly<Record<AssetSymbol, number>>;
  readonly clock?: () => number;
  readonly account?: string;
}

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  private readonly cfg: RiskConfig;
  private readonly client: PaperOptions["client"];
  private readonly store: BalanceStore;
  private readonly clock: () => number;
  private readonly account: string;
  private bal: Balances;

  private constructor(o: PaperOptions, bal: Balances) {
    this.cfg = o.cfg;
    this.client = o.client;
    this.store = o.store;
    this.clock = o.clock ?? Date.now;
    this.account = o.account ?? PAPER_ACCOUNT;
    this.bal = bal;
  }

  /** Loads the persisted paper balances, or starts from `start` (default 1000 USDC) and saves them. */
  static async open(o: PaperOptions): Promise<PaperExecutor> {
    const saved = await o.store.load();
    if (saved) return new PaperExecutor(o, saved);
    const s = o.start ?? { USDC: 1000, BTC: 0, NEAR: 0 };
    const A = o.cfg.assets;
    const bal = { USDC: toBase(s.USDC, A.USDC.decimals), BTC: toBase(s.BTC, A.BTC.decimals), NEAR: toBase(s.NEAR, A.NEAR.decimals) };
    await o.store.save(bal);
    return new PaperExecutor(o, bal);
  }

  /** The 1Click request for `p`: exact input, INTENTS on both sides, dry. */
  request(p: TradeProposal, slippageBps: number): QuoteRequest {
    const A = this.cfg.assets;
    const buy = p.kind === "ENTRY";
    const [origin, dest] = buy ? [A.USDC, A[p.asset]] : [A[p.asset], A.USDC];
    let amount = buy ? toBase(p.notionalUsd, origin.decimals) : toBase(p.quantity, origin.decimals);
    if (!buy && p.fraction === 1) {
      const held = this.bal[p.asset];
      const dust = toBase(p.quantity * 1e-6, origin.decimals);
      if (amount > held && amount - held <= dust) amount = held; // sell what is there, not what float says
    }
    return {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: slippageBps,
      originAsset: origin.assetId, destinationAsset: dest.assetId, amount: amount.toString(),
      depositType: "INTENTS", recipient: this.account, recipientType: "INTENTS", refundTo: this.account, refundType: "INTENTS",
      deadline: new Date(this.clock() + this.cfg.execution.deadlineSec * 1000).toISOString(),
    };
  }

  async quote(p: TradeProposal, slippageBps: number): Promise<Quote> {
    const req = this.request(p, slippageBps);
    const res = await this.client.quote(req);
    return this.client.toQuote(res, req, this.clock());
  }

  async execute(p: TradeProposal, q: Quote): Promise<ExecutionReport> {
    const A = this.cfg.assets;
    const sym = (id: string) => (Object.keys(A) as AssetSymbol[]).find((k) => A[k].assetId === id);
    const from = sym(q.originAsset);
    const to = sym(q.destinationAsset);
    if (!from || !to) return { mode: "paper", status: "FAILED", quote: q, txRefs: [], error: `unknown asset in quote ${q.originAsset} → ${q.destinationAsset}` };
    if (this.bal[from] < q.amountIn) return { mode: "paper", status: "FAILED", quote: q, txRefs: [], error: `paper balance ${from} too low` };
    const next = { ...this.bal, [from]: this.bal[from] - q.amountIn, [to]: this.bal[to] + q.amountOut };
    await this.store.save(next); // persisted before it is reported as filled
    this.bal = next;
    const quantityIn = toHuman(q.amountIn, A[from].decimals);
    const quantityOut = toHuman(q.amountOut, A[to].decimals);
    const price = p.kind === "ENTRY" ? quantityIn / quantityOut : quantityOut / quantityIn;
    return { mode: "paper", status: "SIMULATED", quote: q, txRefs: [], fill: { quantityIn, quantityOut, price } };
  }

  async balances(): Promise<Readonly<Balances>> {
    return { ...this.bal };
  }
}

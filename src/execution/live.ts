/**
 * Live executor (ARCHITECTURE.md §7, Tier 1 §8.2): real swaps inside NEAR Intents, signed by the agent's key.
 *
 *   quote (dry: false, INTENTS on both sides, the agent account as recipient and refund)
 *   → generate-intent (1Click prepares the NEP-413 transfer of the input to the quote's deposit address)
 *   → CHECK the payload before signing: signer, deadline (≤ 96 h; 1Click uses 72 h), and exactly one transfer of exactly the quoted input
 *     token and amount to exactly the quoted deposit address. Anything else is refused, never signed.
 *   → sign (NEP-413, ed25519) → submit-intent → poll status until SUCCESS / REFUNDED / FAILED / timeout.
 *
 * Safety rails on top of the engine's: a hard per-trade notional cap (`maxNotionalUsd`, set by the owner for the
 * first live trades), and balances read from `intents.near` itself, never assumed.
 */

import type { RiskConfig } from "../config/schema.ts";
import type { AssetSymbol, ExecutionReport, Executor, Quote, TradeProposal } from "../types.ts";
import type { GenerateIntentResponse, Nep413Signed, OneClickClient, QuoteRequest, StatusResponse } from "./oneclick.ts";
import { TERMINAL } from "./oneclick.ts";
import { toBase, toHuman } from "./units.ts";

export const INTENTS_CONTRACT = "intents.near";
/** Longest intent deadline we sign. */
export const MAX_INTENT_DEADLINE_MS = 96 * 3_600_000;

/** What the executor needs from a NEAR client (near-kit `Near`). */
export interface NearSigner {
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array; callbackUrl?: string }, o: { signerId: string }): Promise<{ publicKey: string; signature: string }>;
  view<T>(contractId: string, method: string, args: object): Promise<T | undefined>;
}

export interface LiveOptions {
  readonly cfg: RiskConfig;
  readonly client: Pick<OneClickClient, "quote" | "toQuote" | "generateIntent" | "submitIntent" | "status">;
  readonly near: NearSigner;
  readonly account: string;
  /** Hard cap per trade in USD (entries: notional; exits: quantity × reference price). */
  readonly maxNotionalUsd: number;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly statusTimeoutMs?: number;
  readonly pollMs?: number;
}

/** Checks the NEP-413 payload 1Click asks us to sign against the quote. Returns the problems (empty = sign). */
export function checkIntentPayload(g: GenerateIntentResponse, q: Quote, account: string, now: number): string[] {
  const problems: string[] = [];
  if (g.intent.payload.recipient !== INTENTS_CONTRACT) problems.push(`recipient is ${g.intent.payload.recipient}, not ${INTENTS_CONTRACT}`);
  let m: { signer_id?: unknown; deadline?: unknown; intents?: unknown };
  try {
    m = JSON.parse(g.intent.payload.message);
  } catch {
    return [...problems, "message is not JSON"];
  }
  if (m.signer_id !== account) problems.push(`signer_id is ${String(m.signer_id)}, not ${account}`);
  const deadline = typeof m.deadline === "string" ? Date.parse(m.deadline) : NaN;
  // 1Click sets the intent deadline 72 h ahead (seen live on 10 Nov). The transfer is bound to this quote's deposit
  // address, amount and nonce, so a late or replayed submission can only be refunded to us; still, cap it.
  if (!(deadline > now) || deadline - now > MAX_INTENT_DEADLINE_MS) problems.push(`deadline ${String(m.deadline)} is not within the next ${MAX_INTENT_DEADLINE_MS / 3_600_000} h`);
  const intents = Array.isArray(m.intents) ? (m.intents as Record<string, unknown>[]) : [];
  if (intents.length !== 1) problems.push(`expected exactly one intent, got ${intents.length}`);
  const t = intents[0];
  if (t) {
    if (t["intent"] !== "transfer") problems.push(`intent is ${String(t["intent"])}, not transfer`);
    if (t["receiver_id"] !== q.depositAddress) problems.push(`receiver ${String(t["receiver_id"])} is not the quote's deposit address`);
    const tokens = (t["tokens"] ?? {}) as Record<string, unknown>;
    const keys = Object.keys(tokens);
    if (keys.length !== 1 || keys[0] !== q.originAsset) problems.push(`tokens ${keys.join(",")} are not exactly ${q.originAsset}`);
    else if (String(tokens[q.originAsset]) !== q.amountIn.toString()) problems.push(`amount ${String(tokens[q.originAsset])} is not the quoted ${q.amountIn}`);
  }
  return problems;
}

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  private readonly o: LiveOptions;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: LiveOptions) {
    this.o = o;
    this.clock = o.clock ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  request(p: TradeProposal, slippageBps: number, heldBase?: bigint): QuoteRequest {
    const A = this.o.cfg.assets;
    const buy = p.kind === "ENTRY";
    const [origin, dest] = buy ? [A.USDC, A[p.asset]] : [A[p.asset], A.USDC];
    let amount = buy ? toBase(p.notionalUsd, origin.decimals) : toBase(p.quantity, origin.decimals);
    if (!buy && p.fraction === 1 && heldBase !== undefined) {
      const dust = toBase(p.quantity * 1e-6, origin.decimals);
      if (amount > heldBase && amount - heldBase <= dust) amount = heldBase;
    }
    const a = this.o.account;
    return {
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: slippageBps, originAsset: origin.assetId, destinationAsset: dest.assetId,
      amount: amount.toString(), depositType: "INTENTS", recipient: a, recipientType: "INTENTS", refundTo: a, refundType: "INTENTS",
      deadline: new Date(this.clock() + this.o.cfg.execution.deadlineSec * 1000).toISOString(),
    };
  }

  async quote(p: TradeProposal, slippageBps: number): Promise<Quote> {
    const usd = p.kind === "ENTRY" ? p.notionalUsd : p.quantity * p.referencePrice;
    if (p.kind === "ENTRY" && usd > this.o.maxNotionalUsd) {
      throw new Error(`live cap: $${usd.toFixed(2)} is above the owner's per-trade cap of $${this.o.maxNotionalUsd}`);
    }
    const held = p.kind === "EXIT" ? (await this.balances())[p.asset] : undefined;
    const req = this.request(p, slippageBps, held);
    const res = await this.o.client.quote(req);
    const q = this.o.client.toQuote(res, req, this.clock());
    if (!q.depositAddress) throw new Error("1Click returned no depositAddress for an INTENTS quote");
    return q;
  }

  async execute(p: TradeProposal, q: Quote): Promise<ExecutionReport> {
    const base = { mode: "live" as const, quote: q };
    let gen: GenerateIntentResponse;
    try {
      gen = await this.o.client.generateIntent(q.depositAddress!, this.o.account);
    } catch (e) {
      return { ...base, status: "FAILED", txRefs: [], error: `generate-intent: ${msg(e)}` };
    }
    const problems = checkIntentPayload(gen, q, this.o.account, this.clock());
    if (problems.length) return { ...base, status: "FAILED", txRefs: [], error: `refused to sign: ${problems.join("; ")}` };

    const pl = gen.intent.payload;
    const signed = await this.o.near.signMessage(
      { message: pl.message, recipient: pl.recipient, nonce: Buffer.from(pl.nonce, "base64"), ...(pl.callbackUrl ? { callbackUrl: pl.callbackUrl } : {}) },
      { signerId: this.o.account },
    );
    const signedData: Nep413Signed = {
      standard: "nep413", payload: { message: pl.message, nonce: pl.nonce, recipient: pl.recipient, ...(pl.callbackUrl ? { callbackUrl: pl.callbackUrl } : {}) },
      public_key: signed.publicKey as `ed25519:${string}`, signature: intentsSignature(signed.signature),
    };
    let intentHash: string;
    try {
      intentHash = (await this.o.client.submitIntent(signedData)).intentHash;
    } catch (e) {
      // not known to be submitted: report FAILED; the idempotency key stays pending, so it is never re-sent blindly
      return { ...base, status: "FAILED", txRefs: [], error: `submit-intent: ${msg(e)}` };
    }

    const until = this.clock() + (this.o.statusTimeoutMs ?? 180_000);
    let st: StatusResponse | undefined;
    while (this.clock() < until) {
      try {
        st = await this.o.client.status(q.depositAddress!);
        if (TERMINAL.has(st.status)) break;
      } catch {
        // transient: keep polling until the deadline
      }
      await this.sleep(this.o.pollMs ?? 3000);
    }
    const txRefs = [intentHash, ...(st?.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash), ...(st?.swapDetails?.originChainTxHashes ?? []).map((t) => t.hash)];
    const withHash = { ...base, intentHash, txRefs };
    if (!st || !TERMINAL.has(st.status)) return { ...withHash, status: "FAILED", error: `no final status within ${(this.o.statusTimeoutMs ?? 180_000) / 1000} s (last ${st?.status ?? "none"}); check ${intentHash}` };
    if (st.status !== "SUCCESS") return { ...withHash, status: st.status === "REFUNDED" ? "REFUNDED" : "FAILED", error: st.swapDetails?.refundReason ?? st.status };

    const A = this.o.cfg.assets;
    const sym = (id: string) => (Object.keys(A) as AssetSymbol[]).find((k) => A[k].assetId === id)!;
    const amountIn = BigInt(st.swapDetails?.amountIn ?? q.amountIn.toString());
    const amountOut = BigInt(st.swapDetails?.amountOut ?? q.amountOut.toString());
    const quantityIn = toHuman(amountIn, A[sym(q.originAsset)].decimals);
    const quantityOut = toHuman(amountOut, A[sym(q.destinationAsset)].decimals);
    const price = p.kind === "ENTRY" ? quantityIn / quantityOut : quantityOut / quantityIn;
    return { ...withHash, status: "SUCCESS", fill: { quantityIn, quantityOut, price } };
  }

  /** The agent's balances inside NEAR Intents (mt_batch_balance_of on intents.near), in base units. */
  async balances(): Promise<Readonly<Record<AssetSymbol, bigint>>> {
    const A = this.o.cfg.assets;
    const ids = [A.USDC.assetId, A.BTC.assetId, A.NEAR.assetId];
    const r = (await this.o.near.view<string[]>(INTENTS_CONTRACT, "mt_batch_balance_of", { account_id: this.o.account, token_ids: ids })) ?? [];
    if (r.length !== 3) throw new Error(`intents.near returned ${r.length} balances for 3 tokens`);
    return { USDC: BigInt(r[0]!), BTC: BigInt(r[1]!), NEAR: BigInt(r[2]!) };
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * Intents wants `ed25519:<base58>` for the signature (MultiPayload nep413). Wallets and near-kit return NEP-413
 * signatures base64-encoded (the NEP-413 wallet convention): normalise to what the verifier accepts.
 */
export function intentsSignature(sig: string): `ed25519:${string}` {
  if (sig.startsWith("ed25519:")) return sig as `ed25519:${string}`;
  const bytes = Buffer.from(sig, "base64");
  if (bytes.length !== 64) throw new Error(`unexpected NEP-413 signature length ${bytes.length}`);
  return `ed25519:${base58(bytes)}`;
}

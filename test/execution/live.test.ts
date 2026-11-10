import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { checkIntentPayload, LiveExecutor, type NearSigner } from "../../src/execution/live.ts";
import type { GenerateIntentResponse, OneClickClient, QuoteRequest, QuoteResponse, StatusResponse } from "../../src/execution/oneclick.ts";
import { OneClickClient as Client } from "../../src/execution/oneclick.ts";
import type { EntryProposal, ExitProposal, Quote } from "../../src/types.ts";

const A = cfg.assets;
const NOW = Date.parse("2026-11-11T10:00:30Z");
const AGENT = "agent.near-sentinel.near";
const DEPOSIT = "deposit-addr-123";
const entry: EntryProposal = { kind: "ENTRY", asset: "NEAR", barTime: NOW - 3_630_000, referencePrice: 3.6, notionalUsd: 5, quantity: 5 / 3.6, stopPrice: 3.5, takeProfit: [3.75, 3.82], riskUsd: 0.14, signals: [] };

const intentFor = (q: { originAsset: string; amountIn: bigint }, over: Record<string, unknown> = {}): GenerateIntentResponse => ({
  correlationId: "c",
  intent: {
    standard: "nep413",
    payload: {
      recipient: "intents.near", nonce: Buffer.alloc(32, 7).toString("base64"),
      message: JSON.stringify({ signer_id: AGENT, deadline: new Date(NOW + 120_000).toISOString(), intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [q.originAsset]: q.amountIn.toString() } }], ...over }),
    },
  },
});

function fakes(o: { statuses?: StatusResponse["status"][]; intent?: (q: Quote) => GenerateIntentResponse; balances?: string[] } = {}) {
  const calls: { kind: string; body?: unknown }[] = [];
  let lastQuote: Quote | undefined;
  const statuses = [...(o.statuses ?? ["PROCESSING", "SUCCESS"])];
  const real = new Client({});
  const client: Pick<OneClickClient, "quote" | "toQuote" | "generateIntent" | "submitIntent" | "status"> = {
    quote: async (req: QuoteRequest): Promise<QuoteResponse> => {
      calls.push({ kind: "quote", body: req });
      const out = req.originAsset === A.USDC.assetId ? (BigInt(req.amount) * 10n ** 24n) / 3_600_000n : (BigInt(req.amount) * 3_600_000n) / 10n ** 24n;
      return { timestamp: new Date(NOW).toISOString(), quoteRequest: { ...req }, quote: { depositAddress: DEPOSIT, amountIn: req.amount, amountInFormatted: "", amountOut: out.toString(), amountOutFormatted: "", minAmountOut: ((out * 995n) / 1000n).toString() } };
    },
    toQuote: (r, req, at) => (lastQuote = real.toQuote(r, req, at)),
    generateIntent: async (dep, signer) => { calls.push({ kind: "generate", body: { dep, signer } }); return (o.intent ?? intentFor)(lastQuote!); },
    submitIntent: async (sd) => { calls.push({ kind: "submit", body: sd }); return { intentHash: "IH123", correlationId: "c" }; },
    status: async () => {
      const s = statuses.shift() ?? "SUCCESS";
      return { status: s, updatedAt: "", swapDetails: { amountIn: lastQuote!.amountIn.toString(), amountOut: lastQuote!.amountOut.toString(), originChainTxHashes: [], destinationChainTxHashes: [{ hash: "TX9" }] } };
    },
  };
  const signs: unknown[] = [];
  const near: NearSigner = {
    signMessage: async (p, so) => { signs.push({ ...p, nonceLen: p.nonce.length, signer: so.signerId }); return { publicKey: "ed25519:PUB", signature: "ed25519:SIG" }; },
    view: async <T>() => (o.balances ?? ["5000000", "0", "0"]) as T,
  };
  const x = new LiveExecutor({ cfg, client, near, account: AGENT, maxNotionalUsd: 10, clock: () => NOW, sleep: async () => {}, pollMs: 1 });
  return { x, calls, signs };
}

describe("LiveExecutor", () => {
  it("quote → check → sign → submit → SUCCESS with the real fill and tx refs", async () => {
    const { x, calls, signs } = await Promise.resolve(fakes());
    const q = await x.quote(entry, 50);
    expect(calls[0]!.body).toMatchObject({ dry: false, depositType: "INTENTS", recipient: AGENT, refundTo: AGENT, amount: "5000000", originAsset: A.USDC.assetId });
    const r = await x.execute(entry, q);
    expect(r).toMatchObject({ mode: "live", status: "SUCCESS", intentHash: "IH123", txRefs: ["IH123", "TX9"] });
    expect(r.fill!.quantityIn).toBe(5);
    expect(r.fill!.price).toBeCloseTo(3.6, 6);
    expect(signs[0]).toMatchObject({ recipient: "intents.near", nonceLen: 32, signer: AGENT });
    expect(calls.find((c) => c.kind === "submit")!.body).toMatchObject({ standard: "nep413", public_key: "ed25519:PUB", signature: "ed25519:SIG" });
  });

  it("the owner's per-trade cap is enforced before any quote", async () => {
    const { x, calls } = fakes();
    await expect(x.quote({ ...entry, notionalUsd: 50 }, 50)).rejects.toThrow(/live cap: \$50.00/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["another receiver", (q: Quote) => intentFor(q, { intents: [{ intent: "transfer", receiver_id: "attacker.near", tokens: { [q.originAsset]: q.amountIn.toString() } }] }), /receiver/],
    ["a bigger amount", (q: Quote) => intentFor({ ...q, amountIn: q.amountIn * 10n }), /amount/],
    ["another token", (q: Quote) => intentFor({ ...q, originAsset: A.NEAR.assetId }), /tokens/],
    ["two intents", (q: Quote) => intentFor(q, { intents: [{ intent: "transfer", receiver_id: DEPOSIT, tokens: { [q.originAsset]: q.amountIn.toString() } }, { intent: "transfer", receiver_id: "x", tokens: {} }] }), /exactly one/],
    ["another signer", (q: Quote) => intentFor(q, { signer_id: "someone.near" }), /signer_id/],
    ["a far deadline", (q: Quote) => intentFor(q, { deadline: new Date(NOW + 86_400_000).toISOString() }), /deadline/],
  ])("refuses to sign a payload with %s", async (_n, intent, why) => {
    const { x, signs, calls } = fakes({ intent });
    const r = await x.execute(entry, await x.quote(entry, 50));
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(why);
    expect(signs).toHaveLength(0);
    expect(calls.some((c) => c.kind === "submit")).toBe(false);
  });

  it("REFUNDED and no final status are reported, not filled", async () => {
    const refunded = fakes({ statuses: ["REFUNDED"] });
    expect((await refunded.x.execute(entry, await refunded.x.quote(entry, 50))).status).toBe("REFUNDED");
    const stuck = fakes({ statuses: Array(10_000).fill("PROCESSING") });
    let t = NOW;
    const x = new LiveExecutor({ ...(stuck.x as unknown as { o: object }).o, clock: () => (t += 10_000) } as never);
    const r = await x.execute(entry, await x.quote(entry, 50));
    expect(r.status).toBe("FAILED");
    expect(r.error).toMatch(/no final status/);
    expect(r.fill).toBeUndefined();
  });

  it("balances come from intents.near; a full exit sells exactly what is held", async () => {
    const held = 1_388_000_000_000_000_000_000_000n; // 1.388 NEAR
    const { x, calls } = fakes({ balances: ["0", "0", held.toString()] });
    expect(await x.balances()).toEqual({ USDC: 0n, BTC: 0n, NEAR: held });
    const exit: ExitProposal = { kind: "EXIT", asset: "NEAR", barTime: NOW, reason: "STOP", referencePrice: 3.5, quantity: 1.388 + 1e-12, fraction: 1 };
    await x.quote(exit, 150);
    expect((calls[0]!.body as QuoteRequest).amount).toBe(held.toString());
  });

  it("checkIntentPayload accepts the exact transfer", () => {
    const q = { originAsset: A.USDC.assetId, amountIn: 5_000_000n, depositAddress: DEPOSIT } as Quote;
    expect(checkIntentPayload(intentFor(q), q, AGENT, NOW)).toEqual([]);
  });
});

describe("pnpm live refuses to start unsafely", () => {
  it("without the flag, without keys, or without the on-chain guardrail", async () => {
    const { runLive } = await import("../../src/cli/run.ts");
    const out: string[] = [];
    const write = (l: string) => out.push(l);
    const base = { root: "/nonexistent", write };
    expect(await runLive({ ...base, env: {}, args: [] })).toBe(2);
    expect(out.pop()).toMatch(/--yes-real-funds/);
    expect(await runLive({ ...base, env: {}, args: ["--yes-real-funds"] })).toBe(2);
    expect(out.pop()).toMatch(/AGENT_ACCOUNT and AGENT_PRIVATE_KEY/);
    expect(await runLive({ ...base, env: { AGENT_ACCOUNT: "a.near", AGENT_PRIVATE_KEY: "ed25519:x" }, args: ["--yes-real-funds"] })).toBe(2);
    expect(out.pop()).toMatch(/on-chain guardrail/);
  });
});

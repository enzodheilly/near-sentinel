import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { OneClickClient, OneClickError, TERMINAL, USER_AGENT, type QuoteRequest } from "../../src/execution/oneclick.ts";

const req: QuoteRequest = {
  dry: true, swapType: "EXACT_INPUT", slippageTolerance: 50, originAsset: cfg.assets.USDC.assetId, destinationAsset: cfg.assets.NEAR.assetId,
  amount: "25000000", depositType: "INTENTS", recipient: "agent.near", recipientType: "INTENTS", refundTo: "agent.near", refundType: "INTENTS",
  deadline: "2026-11-06T22:02:00.000Z",
};
/** Shape from the 1Click reference (api-quote.md). A response recorded live replaces it when present. */
const DOC_QUOTE = {
  correlationId: "c-1", timestamp: "2026-11-06T22:00:00.000Z", quoteRequest: { ...req },
  quote: { amountIn: "25000000", amountInFormatted: "25", amountInUsd: "25.00", amountOut: "12895600000000000000000000", amountOutFormatted: "12.8956",
    amountOutUsd: "24.95", minAmountOut: "12831122000000000000000000", deadline: "2026-11-06T22:02:00.000Z", timeEstimate: 10 },
};
const RECORDED = new URL("../live/recorded/quote-dry.json", import.meta.url).pathname;

type Call = { url: string; init: RequestInit };
const fake = (status: number, body: unknown, calls: Call[] = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe("OneClickClient", () => {
  it("quote: posts the request with the partner key and our User-Agent, returns a validated response", async () => {
    const calls: Call[] = [];
    const c = new OneClickClient({ jwt: "eyJpartner", fetch: fake(200, DOC_QUOTE, calls) });
    const r = await c.quote(req);
    expect(r.quote.amountOut).toBe("12895600000000000000000000");
    expect(calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ "x-api-key": "eyJpartner", "user-agent": USER_AGENT, "content-type": "application/json" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(req);
    expect(c.authenticated).toBe(true);
  });

  it("toQuote: bigint amounts, minAmountOut, the exact payload kept for the record", () => {
    const c = new OneClickClient({ fetch: fake(200, {}) });
    const q = c.toQuote(DOC_QUOTE as never, req, 123);
    expect(q).toMatchObject({ amountIn: 25_000_000n, amountOut: 12_895_600n * 10n ** 18n, minAmountOut: 12_831_122n * 10n ** 18n, receivedAt: 123, deadline: req.deadline });
    expect(q.raw).toBe(DOC_QUOTE);
  });

  it("without a key, no X-API-Key header is sent", async () => {
    const calls: Call[] = [];
    await new OneClickClient({ jwt: "", fetch: fake(200, DOC_QUOTE, calls) }).quote(req);
    expect(calls[0]!.init.headers).not.toHaveProperty("x-api-key");
  });

  it("tokens and status are parsed; terminal statuses are known", async () => {
    const tok = [{ assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: "1.93", priceUpdatedAt: "2026-11-06T22:00:00Z", contractAddress: "wrap.near" }];
    expect((await new OneClickClient({ fetch: fake(200, tok) }).tokens())[0]).toMatchObject({ price: 1.93, decimals: 24 });
    const st = { correlationId: "c-1", status: "SUCCESS", updatedAt: "2026-11-06T22:01:00Z", swapDetails: { amountIn: "25000000", amountOut: "1", originChainTxHashes: [], destinationChainTxHashes: [{ hash: "abc", explorerUrl: "https://nearblocks.io/txns/abc" }] } };
    const calls: Call[] = [];
    const s = await new OneClickClient({ fetch: fake(200, st, calls) }).status("dep 1");
    expect(s.status).toBe("SUCCESS");
    expect(TERMINAL.has(s.status)).toBe(true);
    expect(calls[0]!.url).toBe("https://1click.chaindefuser.com/v0/status?depositAddress=dep+1");
  });

  it("submitIntent wraps the NEP-413 payload as a swap_transfer", async () => {
    const calls: Call[] = [];
    const signed = { standard: "nep413", payload: { message: "{}", nonce: "AAAA", recipient: "intents.near" }, public_key: "ed25519:abc", signature: "ed25519:def" } as const;
    const r = await new OneClickClient({ fetch: fake(200, { intentHash: "44Xp", correlationId: "c-2" }, calls) }).submitIntent(signed);
    expect(r).toEqual({ intentHash: "44Xp", correlationId: "c-2" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ type: "swap_transfer", signedData: signed });
  });

  it("unexpected answers become typed errors, never a silent value", async () => {
    const err = (f: typeof fetch) => new OneClickClient({ fetch: f }).quote(req).then(() => null, (e: unknown) => e as OneClickError);
    const bad = { ...DOC_QUOTE, quote: { ...DOC_QUOTE.quote, amountOut: "12.89" } };
    expect(await err(fake(200, bad))).toMatchObject({ kind: "schema", message: "1Click POST /v0/quote: unexpected answer at quote.amountOut: an integer amount in base units" });
    expect(await err(fake(200, "<html>oops</html>"))).toMatchObject({ kind: "schema", message: expect.stringMatching(/answer is not JSON: <html>/) });
    expect(await err(fake(401, { message: "Invalid token" }))).toMatchObject({ kind: "auth", status: 401 });
    expect(await err(fake(403, "error code: 1010"))).toMatchObject({ kind: "auth", message: expect.stringMatching(/Cloudflare refused the client/) });
    expect(await err(fake(400, { message: "amount too low" }))).toMatchObject({ kind: "http", status: 400, message: expect.stringMatching(/amount too low/) });
    expect(await err((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toMatchObject({ kind: "network" });
    const slow = (async (_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    expect(await new OneClickClient({ fetch: slow, timeoutMs: 20 }).quote(req).catch((e: OneClickError) => e)).toMatchObject({ kind: "timeout" });
    expect(await err(fake(200, { ...DOC_QUOTE, quote: undefined }))).toBeInstanceOf(OneClickError);
  });

  it.runIf(existsSync(RECORDED))("a response recorded live (pnpm test:live) still parses", () => {
    const rec = JSON.parse(readFileSync(RECORDED, "utf8")) as { request: QuoteRequest; response: unknown };
    const c = new OneClickClient({ fetch: fake(200, rec.response) });
    return expect(c.quote(rec.request)).resolves.toMatchObject({ quote: { amountIn: expect.stringMatching(/^\d+$/) } });
  });
});

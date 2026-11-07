import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NearAiClient, NearAiError, NEARAI_USER_AGENT, type ChatRequest } from "../../../src/decision/llm/client.ts";

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const req: ChatRequest = { model: MODEL, temperature: 0, messages: [{ role: "system", content: "rules" }, { role: "user", content: '{"rsi":63.1}' }] };
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

type Call = { url: string; init: RequestInit };
/** Answers with these exact bytes (deliberately odd spacing: a re-serialisation would change the hash). */
const fake = (status: number, body: string, calls: Call[] = []) =>
  (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;

const ODD = '{ "id" : "chat-1",\n  "model":"Qwen/Qwen3.6-35B-A3B-FP8", "choices":[{"message":{"role":"assistant","content":"{\\"verdict\\":\\"approve\\"}"},"finish_reason":"stop"}] }';

describe("NearAiClient.chat", () => {
  it("sends the canonical-model headers and hashes the exact bytes sent and received", async () => {
    const calls: Call[] = [];
    const c = new NearAiClient({ apiKey: "sk-test", fetch: fake(200, ODD, calls), clock: () => 42 });
    const x = await c.chat(req);

    expect(calls[0]!.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer sk-test", "x-no-aliasing": "true", "accept-encoding": "identity", "content-type": "application/json", "user-agent": NEARAI_USER_AGENT,
    });
    const sent = calls[0]!.init.body as Uint8Array;
    expect(Buffer.from(sent).equals(Buffer.from(x.requestBytes))).toBe(true); // the bytes kept are the bytes sent
    expect(x.requestSha256).toBe(sha(sent));
    expect(x.responseSha256).toBe(sha(ODD)); // raw body, not JSON.stringify(JSON.parse(body))
    expect(x.responseSha256).not.toBe(sha(JSON.stringify(JSON.parse(ODD))));
    expect(new TextDecoder().decode(x.responseBytes)).toBe(ODD);
    expect(x).toMatchObject({ chatId: "chat-1", model: MODEL, content: '{"verdict":"approve"}', receivedAt: 42 });
  });

  it("keeps non-ASCII bytes exactly (hash over UTF-8, not over a JS string length)", async () => {
    const body = ODD.replace("approve", "approuvé");
    const x = await new NearAiClient({ apiKey: "k", fetch: fake(200, body) }).chat({ ...req, messages: [{ role: "user", content: "é" }] });
    expect(x.responseSha256).toBe(sha(Buffer.from(body, "utf8")));
    expect(x.requestSha256).toBe(sha(Buffer.from(JSON.stringify({ ...req, messages: [{ role: "user", content: "é" }] }), "utf8")));
  });

  it("empty content when the model returns null", async () => {
    const x = await new NearAiClient({ apiKey: "k", fetch: fake(200, '{"id":"c","choices":[{"message":{"content":null}}]}') }).chat(req);
    expect(x.content).toBe("");
  });

  it.each([
    [401, "unauthorized", "auth"],
    [403, "forbidden", "auth"],
    [500, "boom", "http"],
    [429, "slow down", "http"],
  ])("HTTP %i → %s error", async (status, body, kind) => {
    const err = await new NearAiClient({ apiKey: "k", fetch: fake(status, body) }).chat(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearAiError);
    expect((err as NearAiError).kind).toBe(kind);
    expect((err as NearAiError).status).toBe(status);
  });

  it("not JSON or wrong shape → schema error", async () => {
    for (const body of ["<html>", '{"id":"c","choices":[]}', '{"choices":[{"message":{"content":"x"}}]}']) {
      const err = await new NearAiClient({ apiKey: "k", fetch: fake(200, body) }).chat(req).catch((e: unknown) => e);
      expect((err as NearAiError).kind).toBe("schema");
    }
  });

  it("network failure and timeout are typed", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(((await new NearAiClient({ apiKey: "k", fetch: down }).chat(req).catch((e: unknown) => e)) as NearAiError).kind).toBe("network");

    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const err = (await new NearAiClient({ apiKey: "k", fetch: hang, timeoutMs: 20 }).chat(req).catch((e: unknown) => e)) as NearAiError;
    expect(err.kind).toBe("timeout");
  });

  it("a caller abort also stops the call", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = new NearAiClient({ apiKey: "k", fetch: hang, timeoutMs: 60_000 }).chat(req, ac.signal).catch((e: unknown) => e);
    ac.abort();
    expect(((await p) as NearAiError).kind).toBe("timeout");
  });

  it("refuses to start without a key", () => {
    expect(() => new NearAiClient({ apiKey: "" })).toThrow(/NEARAI_API_KEY/);
  });
});

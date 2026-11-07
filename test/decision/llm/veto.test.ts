import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../../src/config/default.ts";
import { reviewSafely, type LlmContext } from "../../../src/decision/engine.ts";
import { chatRequest, nearAiVeto, parseVerdict, promptPayload, SYSTEM_PROMPT } from "../../../src/decision/llm/veto.ts";
import { LLM_SIZE_MULTIPLIER } from "../../../src/types.ts";
import { cloud, PUB } from "./fake-cloud.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const ctx: LlmContext = {
  asset: "NEAR", notionalUsd: 250, referencePrice: 1.936, stopPrice: 1.91038, takeProfit: [1.9744, 2.0128],
  signals: [{ kind: "BB_BREAKOUT", direction: "bullish", strength: 0.4231, evidence: { upper: 1.93, close: 1.936 } }],
  last24Closes: [1.9, 1.91, 1.936], dayPnlPct: -0.4, openExposureUsd: 0,
};

const noSleep = async () => {};

describe("prompt", () => {
  it("numbers and fixed fields only, deterministic", () => {
    const req = chatRequest(ctx, cfg);
    expect(req).toMatchObject({ model: cfg.llm.model, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    expect(req.messages[0]!.content).toBe(SYSTEM_PROMPT);
    const user = JSON.parse(req.messages[1]!.content);
    expect(user).toMatchObject({ asset: "NEAR", side: "BUY", notionalUsd: 250, entry: 1.936, stop: 1.91038, dayPnlPct: -0.4 });
    expect(user.signals[0]).toEqual({ kind: "BB_BREAKOUT", direction: "bullish", strength: 0.423, evidence: { upper: 1.93, close: 1.936 } });
    expect(promptPayload(ctx)).toBe(promptPayload({ ...ctx }));
    // every leaf is a number or one of our enums/fixed strings
    const leaves: unknown[] = [];
    JSON.parse(promptPayload(ctx), (_k, v) => (typeof v !== "object" ? leaves.push(v) : 0, v));
    for (const v of leaves) expect(typeof v === "number" || ["NEAR", "BUY", "BB_BREAKOUT", "bullish"].includes(v as string)).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("accepts the object, fenced or after a think block", () => {
    const v = '{"verdict":"reduce","sizeMultiplier":0.5,"rationale":"RSI 68 is stretched"}';
    for (const c of [v, "```json\n" + v + "\n```", `<think>hmm</think>\n${v}`]) expect(parseVerdict(c, 400)).toMatchObject({ ok: true, verdict: { verdict: "reduce" } });
  });

  it.each([
    ["not json", /not JSON/],
    ['{"verdict":"approve","sizeMultiplier":0.5,"rationale":"x"}', /does not match/],
    ['{"verdict":"approve","sizeMultiplier":2,"rationale":"x"}', /sizeMultiplier/],
    ['{"verdict":"buy more","sizeMultiplier":1,"rationale":"x"}', /verdict/],
    ['{"verdict":"approve","sizeMultiplier":1,"rationale":""}', /rationale/],
    [`{"verdict":"approve","sizeMultiplier":1,"rationale":"${"x".repeat(401)}"}`, /rationale/],
    ['{"verdict":"approve","sizeMultiplier":1,"rationale":"x","notional":9999}', /root|notional/],
  ])("rejects %s", (content, why) => {
    const r = parseVerdict(content, 400);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(why);
  });

  it("property: whatever the model writes, a parsed multiplier is 1, 0.5 or 0 and matches its verdict", () => {
    const arb = fc.oneof(
      fc.string(),
      fc.record({ verdict: fc.constantFrom("approve", "reduce", "reject", "increase"), sizeMultiplier: fc.constantFrom(0, 0.5, 1, 1.5, 2, -1), rationale: fc.string({ maxLength: 500 }) }).map((o) => JSON.stringify(o)),
    );
    fc.assert(fc.property(arb, (c) => {
      const r = parseVerdict(c, 400);
      if (r.ok) expect(LLM_SIZE_MULTIPLIER[r.verdict.verdict]).toBe(r.verdict.sizeMultiplier);
    }));
  });
});

describe("nearAiVeto", () => {
  it("approve: verdict, evidence and a verified attestation", async () => {
    const c = cloud('{"verdict":"approve","sizeMultiplier":1,"rationale":"Breakout with room to TP1."}');
    const r = await nearAiVeto(c.client, cfg, { sleep: noSleep })(ctx);
    expect(c.calls.map((p) => p.split("/").slice(2, 3)[0])).toEqual(["attestation", "chat", "signature"]);
    expect(r).toMatchObject({
      model: cfg.llm.model, verdict: "approve", sizeMultiplier: 1, rationale: "Breakout with room to TP1.", chatId: "chat-9",
      requestSha256: sha(c.sent()), signingAddress: PUB, signatureKind: "provider_tee", attestation: { status: "verified", problems: [] },
    });
    expect(r.fallbackReason).toBeUndefined();
  });

  it("invalid output → fallback × 0.5, evidence kept", async () => {
    const r = await nearAiVeto(cloud("Sure! I think you should buy.").client, cfg, { sleep: noSleep })(ctx);
    expect(r).toMatchObject({ verdict: "reduce", sizeMultiplier: 0.5, chatId: "chat-9", attestation: { status: "verified" } });
    expect(r.fallbackReason).toMatch(/not JSON/);
  });

  it("an attempt to increase the size → fallback, never larger", async () => {
    const r = await nearAiVeto(cloud('{"verdict":"approve","sizeMultiplier":2,"rationale":"double it"}').client, cfg, { sleep: noSleep })(ctx);
    expect(r.sizeMultiplier).toBe(0.5);
  });

  it("fallback is reject × 0 when configured so", async () => {
    const strict = { ...cfg, llm: { ...cfg.llm, fallbackMultiplier: 0 as const } };
    const r = await nearAiVeto(cloud("garbage").client, strict, { sleep: noSleep })(ctx);
    expect(r).toMatchObject({ verdict: "reject", sizeMultiplier: 0 });
  });

  it("signature late: retried; never there: verdict kept, unverified", async () => {
    const late = await nearAiVeto(cloud('{"verdict":"reject","sizeMultiplier":0,"rationale":"Day already -2%."}', { signatureAfter: 2 }).client, cfg, { sleep: noSleep })(ctx);
    expect(late).toMatchObject({ verdict: "reject", attestation: { status: "verified" } });
    const never = await nearAiVeto(cloud('{"verdict":"reject","sizeMultiplier":0,"rationale":"x"}', { signatureAfter: 99 }).client, cfg, { sleep: noSleep })(ctx);
    expect(never).toMatchObject({ verdict: "reject", sizeMultiplier: 0, attestation: { status: "unverified" } });
    expect(never.signature).toBeUndefined();
  });

  it("preflight down: verdict kept, unverified with the reason", async () => {
    const r = await nearAiVeto(cloud('{"verdict":"approve","sizeMultiplier":1,"rationale":"ok"}', { reportStatus: 503 }).client, cfg, { sleep: noSleep })(ctx);
    expect(r.verdict).toBe("approve");
    expect(r.attestation?.status).toBe("unverified");
    expect(r.attestation?.problems[0]).toMatch(/preflight failed/);
  });

  it("API error in the engine → reduce × 0.5 with the reason (reviewSafely)", async () => {
    const down = cloud(() => { throw new TypeError("fetch failed"); });
    const veto = nearAiVeto(down.client, cfg, { sleep: noSleep });
    const r = await reviewSafely({ llm: veto }, ctx, cfg);
    expect(r).toMatchObject({ verdict: "reduce", sizeMultiplier: 0.5 });
    expect(r.fallbackReason).toMatch(/fetch failed/);
  });
});

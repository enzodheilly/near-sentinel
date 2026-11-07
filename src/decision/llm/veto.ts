/**
 * The LLM veto (ARCHITECTURE.md §11, RISK_ENGINE.md §8): an attested second opinion that can only shrink a trade.
 *
 * `nearAiVeto(client, cfg)` returns the engine's `llm` dependency. For one proposal that already passed every
 * deterministic rule it:
 *   1. fetches a preflight attestation report with a fresh nonce (signer keys);
 *   2. sends a numbers-only prompt (no external free text reaches the model) and keeps the exact bytes;
 *   3. validates the answer with Zod: {verdict, sizeMultiplier, rationale}, multiplier consistent with verdict;
 *   4. fetches and checks the response signature with what is left of the time budget.
 *
 * Safety:
 * - One budget (cfg.llm.timeoutMs, 10 s) covers all of it. The engine races the same budget and applies the
 *   fallback on timeout, so a slow model can never hold a decision.
 * - An answer that is not valid veto JSON becomes the fallback (reduce × 0.5, or reject × 0 if so configured),
 *   WITH its evidence (chat id, hashes, signature): the record proves what the model actually said.
 * - API errors throw; the engine's reviewSafely turns them into the fallback with the reason.
 * - The size multiplier is 1, 0.5 or 0: the LLM can make a trade smaller, never larger. Exits never come here.
 * - Missing or weak attestation never changes the verdict; it is recorded as `unverified` / `invalid`.
 */

import { z } from "zod";
import type { RiskConfig } from "../../config/schema.ts";
import { LLM_SIZE_MULTIPLIER, type LlmReview } from "../../types.ts";
import type { LlmContext } from "../engine.ts";
import { checkAttestation, fetchSignature, preflight, type Preflight } from "./attestation.ts";
import type { ChatExchange, ChatRequest, NearAiClient } from "./client.ts";

export const SYSTEM_PROMPT = [
  "You are the risk reviewer of an autonomous spot trading agent (long only, BTC and NEAR against USDC).",
  "The proposal below already passed every deterministic rule: signals, stop, size, quote checks and costs.",
  "You may only keep or reduce risk. You never propose a trade and never increase a size.",
  "Reject or reduce when the numbers show a reason: stretched move, weak confluence, a stop too close to noise,",
  "a losing day, or high open exposure. Otherwise approve.",
  'Reply with one JSON object and nothing else: {"verdict":"approve"|"reduce"|"reject","sizeMultiplier":1|0.5|0,"rationale":"..."}.',
  "approve means 1, reduce means 0.5, reject means 0. The rationale is plain text, at most 400 characters, citing the numbers.",
].join("\n");

const round = (x: number, d = 6) => Number(x.toFixed(d));

/** The user message: the engine's numbers, rounded, in a fixed key order. No free text. */
export function promptPayload(ctx: LlmContext): string {
  return JSON.stringify({
    asset: ctx.asset,
    side: "BUY",
    notionalUsd: round(ctx.notionalUsd, 2),
    entry: round(ctx.referencePrice),
    stop: round(ctx.stopPrice),
    takeProfit: ctx.takeProfit.map((x) => round(x)),
    riskPerUnitPct: round(((ctx.referencePrice - ctx.stopPrice) / ctx.referencePrice) * 100, 3),
    signals: ctx.signals.map((s) => ({
      kind: s.kind, direction: s.direction, strength: round(s.strength, 3),
      evidence: Object.fromEntries(Object.entries(s.evidence).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, round(v)])),
    })),
    last24Closes: ctx.last24Closes.map((x) => round(x)),
    dayPnlPct: round(ctx.dayPnlPct, 3),
    openExposureUsd: round(ctx.openExposureUsd, 2),
  });
}

export function chatRequest(ctx: LlmContext, cfg: RiskConfig): ChatRequest {
  return {
    model: cfg.llm.model,
    temperature: 0,
    max_tokens: 400,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: promptPayload(ctx) },
    ],
  };
}

export const verdictSchema = (maxChars: number) =>
  z
    .strictObject({
      verdict: z.enum(["approve", "reduce", "reject"]),
      sizeMultiplier: z.union([z.literal(1), z.literal(0.5), z.literal(0)]),
      rationale: z.string().trim().min(1).max(maxChars),
    })
    .refine((v) => LLM_SIZE_MULTIPLIER[v.verdict] === v.sizeMultiplier, { message: "sizeMultiplier does not match verdict", path: ["sizeMultiplier"] });

export type ParsedVerdict = { ok: true; verdict: z.infer<ReturnType<typeof verdictSchema>> } | { ok: false; reason: string };

/** Accepts the JSON object alone, optionally fenced or after a reasoning block. Nothing is repaired. */
export function parseVerdict(content: string, maxChars: number): ParsedVerdict {
  const text = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `model output is not JSON: ${text.slice(0, 80)}` };
  }
  const r = verdictSchema(maxChars).safeParse(json);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, reason: `model output rejected at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "invalid"}` };
  }
  return { ok: true, verdict: r.data };
}

export interface VetoExchange {
  readonly exchange: ChatExchange;
  readonly preflight: Preflight | undefined;
  readonly review: LlmReview;
}

export interface VetoOptions {
  readonly clock?: () => number;
  /** Signature lookups wait this long between attempts (the serving node may not have it yet). */
  readonly signatureDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Kept for the session: the last exchange and attestation, for the live test and the CLI. */
  readonly onExchange?: (e: VetoExchange) => void;
}

/** The engine's `llm` dependency, backed by NEAR AI Cloud. */
export function nearAiVeto(client: NearAiClient, cfg: RiskConfig, o: VetoOptions = {}): (ctx: LlmContext) => Promise<LlmReview> {
  const clock = o.clock ?? Date.now;
  const delay = o.signatureDelayMs ?? 1500;
  return async (ctx) => {
    const deadline = clock() + cfg.llm.timeoutMs - 250; // leave the engine's race a margin
    const remaining = () => deadline - clock();

    // 1. preflight: evidence, not a gate; its failure leaves the answer unverified
    let pre: Preflight | undefined;
    let preError: string | undefined;
    try {
      pre = await preflight(client, cfg.llm.model, { clock });
    } catch (e) {
      preError = `preflight failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 2. the completion (a throw here is the engine's fallback path)
    const exchange = await client.chat(chatRequest(ctx, cfg), AbortSignal.timeout(Math.max(1, remaining())));

    // 3. the verdict
    const parsed = parseVerdict(exchange.content, cfg.llm.maxRationaleChars);

    // 4. the signature, with what is left of the budget
    const attempts = Math.max(1, Math.floor(remaining() / (delay + 500)));
    const sig = remaining() > 0 ? await fetchSignature(client, exchange, { attempts, delayMs: delay, ...(o.sleep ? { sleep: o.sleep } : {}) }).catch(() => undefined) : undefined;
    const att = checkAttestation(exchange, sig, pre);

    const fallbackMult = cfg.llm.fallbackMultiplier;
    const review: LlmReview = {
      model: exchange.model,
      ...(parsed.ok
        ? { verdict: parsed.verdict.verdict, sizeMultiplier: parsed.verdict.sizeMultiplier, rationale: parsed.verdict.rationale }
        : { verdict: fallbackMult === 0 ? "reject" : "reduce", sizeMultiplier: fallbackMult, rationale: "", fallbackReason: parsed.reason }),
      chatId: exchange.chatId,
      requestSha256: exchange.requestSha256,
      responseSha256: exchange.responseSha256,
      ...(att.signature ? { signature: att.signature } : {}),
      ...(att.signingAddress ? { signingAddress: att.signingAddress } : {}),
      ...(att.signatureKind ? { signatureKind: att.signatureKind } : {}),
      attestation: { status: att.status, problems: preError ? [preError, ...att.problems] : [...att.problems] },
    };
    o.onExchange?.({ exchange, preflight: pre, review });
    return review;
  };
}

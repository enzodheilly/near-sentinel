/**
 * Live NEAR AI Cloud check (network, pnpm test:live). Needs NEARAI_API_KEY in .env (never committed).
 * One real attested veto end to end: preflight report with our nonce → completion → signature → ed25519 check.
 * The evidence (exact request and response bytes, signature, signer keys; never the key) is written to
 * test/live/recorded/nearai-veto.json, which the offline suite re-checks (test/decision/llm/recorded.test.ts).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import type { LlmContext } from "../../src/decision/engine.ts";
import { NearAiClient } from "../../src/decision/llm/client.ts";
import { nearAiVeto, type VetoExchange } from "../../src/decision/llm/veto.ts";

const OUT = new URL("./recorded/nearai-veto.json", import.meta.url).pathname;

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url).pathname);
} catch {
  // no .env
}
const key = process.env["NEARAI_API_KEY"];

/** The demo-entry proposal (fixtures/demo-entry), as the engine hands it to the LLM. */
const ctx: LlmContext = {
  asset: "NEAR", notionalUsd: 250, referencePrice: 1.936, stopPrice: 1.91038, takeProfit: [1.97443, 2.0128],
  signals: [
    { kind: "BB_BREAKOUT", direction: "bullish", strength: 0.42, evidence: { close: 1.936, upper: 1.929 } },
    { kind: "RSI_MOMENTUM", direction: "bullish", strength: 0.55, evidence: { rsi: 63.1 } },
    { kind: "FVG_SUPPORT", direction: "bullish", strength: 0.6, evidence: { fvgBottom: 1.912, fvgTop: 1.921 } },
    { kind: "BTC_REGIME", direction: "bullish", strength: 0.7, evidence: { corr48: 0.71 } },
  ],
  last24Closes: [1.88, 1.884, 1.879, 1.887, 1.892, 1.89, 1.895, 1.9, 1.898, 1.902, 1.905, 1.901, 1.907, 1.91, 1.908, 1.912, 1.915, 1.913, 1.918, 1.92, 1.917, 1.922, 1.925, 1.936],
  dayPnlPct: 0, openExposureUsd: 0,
};

describe.skipIf(!key)("NEAR AI Cloud live", () => {
  it("one attested veto: provider_tee signature, valid ed25519, valid veto JSON", async () => {
    const client = new NearAiClient({ apiKey: key!, timeoutMs: cfg.llm.timeoutMs });
    let captured: VetoExchange | undefined;
    // generous budget for a first live call (cold model, signature on another node); the agent keeps 10 s
    const veto = nearAiVeto(client, { ...cfg, llm: { ...cfg.llm, timeoutMs: 45_000 } }, { onExchange: (e) => (captured = e) });
    const review = await veto(ctx);

    console.log(`NEAR AI veto: ${review.verdict} × ${review.sizeMultiplier} — ${review.rationale || review.fallbackReason}`);
    console.log(`attestation: ${review.attestation?.status} (${review.signatureKind ?? "no kind"}) ${review.attestation?.problems.join("; ") ?? ""}`);

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify({
      recordedAt: new Date().toISOString(),
      model: cfg.llm.model,
      request: new TextDecoder().decode(captured!.exchange.requestBytes),
      response: new TextDecoder().decode(captured!.exchange.responseBytes),
      preflight: captured!.preflight ?? null,
      review,
    }, null, 2)}\n`);

    expect(review.fallbackReason).toBeUndefined(); // valid veto JSON
    expect(review.signatureKind).toBe("provider_tee");
    expect(review.attestation).toEqual({ status: "verified", problems: [] });
  }, 60_000);
});

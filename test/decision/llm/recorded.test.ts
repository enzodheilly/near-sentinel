/**
 * Re-checks the real attested exchange recorded by test/live/nearai.live.test.ts, offline: our hashes of the
 * recorded bytes, the TEE's ed25519 signature, and the signer against the recorded preflight report.
 * Skipped until the live test has been run once (it needs the owner's NEARAI_API_KEY).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkAttestation, recheckReview, type Preflight } from "../../../src/decision/llm/attestation.ts";
import { parseVerdict } from "../../../src/decision/llm/veto.ts";
import type { LlmReview } from "../../../src/types.ts";

const FILE = new URL("../../live/recorded/nearai-veto.json", import.meta.url).pathname;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe.skipIf(!existsSync(FILE))("recorded NEAR AI Cloud exchange", () => {
  const rec = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { model: string; request: string; response: string; preflight: Preflight; review: LlmReview }) : undefined;

  it("our hashes of the recorded bytes are the ones in the review", () => {
    expect(sha(rec!.request)).toBe(rec!.review.requestSha256);
    expect(sha(rec!.response)).toBe(rec!.review.responseSha256);
  });

  it("the TEE signature verifies and the signer is a model key from the preflight", () => {
    const r = rec!.review;
    const sig = { text: `${rec!.model}:${r.requestSha256}:${r.responseSha256}`, signature: r.signature!, signing_address: r.signingAddress!, signature_kind: r.signatureKind! };
    expect(checkAttestation({ model: rec!.model, requestSha256: sha(rec!.request), responseSha256: sha(rec!.response) }, sig, rec!.preflight).status).toBe("verified");
    expect(recheckReview(r).problems).toEqual([]);
  });

  it("the recorded answer parses as the verdict in the review", () => {
    const content = (JSON.parse(rec!.response) as { choices: { message: { content: string } }[] }).choices[0]!.message.content;
    const v = parseVerdict(content, 400);
    expect(v.ok && v.verdict.verdict).toBe(rec!.review.verdict);
  });
});

/**
 * The dashboard's proof tab, server side: the recorded NEAR AI Cloud exchange re-checked now, by this code, from
 * its bytes. Everything else on that tab is either already in /api/state (guardrails, anchors, swaps) or checked
 * by the visitor's own browser (a record's hash and canonical form, from /api/record/<hash>).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkAttestation, type Preflight } from "../decision/llm/attestation.ts";
import type { LlmReview } from "../types.ts";

export interface ProofView {
  readonly llm?: {
    readonly recordedAt: string;
    readonly model: string;
    readonly verdict: string;
    readonly sizeMultiplier: number;
    readonly rationale: string;
    readonly signingAddress: string;
    readonly signatureKind: string;
    readonly checks: readonly { readonly label: string; readonly ok: boolean; readonly detail: string }[];
  };
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export async function buildProof(root: string): Promise<ProofView> {
  let rec: { recordedAt: string; model: string; request: string; response: string; preflight: Preflight; review: LlmReview };
  try {
    rec = JSON.parse(await readFile(join(root, "test", "live", "recorded", "nearai-veto.json"), "utf8"));
  } catch {
    return {};
  }
  const r = rec.review;
  const reqHash = sha(rec.request), resHash = sha(rec.response);
  const att = r.signature && r.signingAddress && r.signatureKind
    ? checkAttestation({ model: rec.model, requestSha256: reqHash, responseSha256: resHash }, { text: `${rec.model}:${reqHash}:${resHash}`, signature: r.signature, signing_address: r.signingAddress, signature_kind: r.signatureKind }, rec.preflight)
    : undefined;
  const signerListed = !!r.signingAddress && rec.preflight.modelSigners.includes(r.signingAddress.replace(/^0x/, "").toLowerCase());
  return {
    llm: {
      recordedAt: rec.recordedAt,
      model: rec.model,
      verdict: r.verdict,
      sizeMultiplier: r.sizeMultiplier,
      rationale: r.rationale,
      signingAddress: r.signingAddress ?? "",
      signatureKind: r.signatureKind ?? "",
      checks: [
        { label: "The question we sent hashes to what the review says", ok: reqHash === r.requestSha256, detail: `SHA-256 ${reqHash.slice(0, 16)}…` },
        { label: "The answer we received hashes to what the review says", ok: resHash === r.responseSha256, detail: `SHA-256 ${resHash.slice(0, 16)}…` },
        { label: "The ed25519 signature over model, question and answer is valid", ok: !!att && att.status !== "invalid", detail: `signed by ${(r.signingAddress ?? "").slice(0, 16)}…` },
        { label: "The signer is a model key from the TEE attestation report, fetched with our own nonce", ok: signerListed && rec.preflight.nonceEchoed, detail: `${rec.preflight.modelSigners.length} model key(s) in the report` },
      ],
    },
  };
}

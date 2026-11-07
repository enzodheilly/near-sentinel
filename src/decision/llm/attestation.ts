/**
 * Attested LLM evidence (ARCHITECTURE.md §11): who signed the answer, and was it the answer we received?
 * Reference: .agents/skills/near-ai-cloud (chat-verification.md, model-verification.md, gateway-verification.md).
 *
 * Chain checked here:
 *   preflight report (fresh client nonce) → signer public keys of the gateway TEE and the model TEEs
 *   → response signature for our chat id → ed25519 over `text`
 *   → `text` is exactly the expected payload for its `signature_kind`, built from OUR hashes of the bytes
 *   → the signer is one the preflight listed for that kind (model TEE for provider_tee, gateway TEE for gateway).
 *
 * Out of scope (stated, not hidden): Intel TDX quote and NVIDIA GPU evidence verification. We keep the signer
 * keys the attestation report bound to the hardware, we do not re-verify the hardware quotes here.
 *
 * Outcomes:
 *   verified   — every link holds;
 *   invalid    — the signature does not verify for the claimed key (tampered text, signature or key);
 *   unverified — the evidence is incomplete or does not bind to us (no signature, missing or unknown kind, text
 *                that is not ours, signer not in the preflight, nonce not echoed). The decision still records it.
 * Only `verified` is presented as attested. The veto never depends on the outcome: a trade can only get
 * smaller because of the LLM, so weak evidence costs credibility, not money.
 */

import { createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import { NearAiError, type ChatExchange, type NearAiClient } from "./client.ts";

export const SIGNING_ALGO = "ed25519"; // the same explicit algo for the report and the signature (defaults differ)

export type SignatureKind = "provider_tee" | "gateway";

const hexKey = z.string().regex(/^(0x)?[0-9a-fA-F]+$/);
const signerFields = z.object({ signing_address: hexKey.optional(), signing_public_key: hexKey.optional() });

export const reportSchema = z.object({
  gateway_attestation: signerFields.extend({ request_nonce: z.string().optional() }).optional(),
  model_attestations: z.array(signerFields.passthrough()).default([]),
});

export const signatureSchema = z.object({
  text: z.string(),
  signature: hexKey,
  signing_address: hexKey,
  signing_algo: z.string().optional(),
  signature_kind: z.enum(["provider_tee", "gateway"]).optional(),
});
export type ChatSignature = z.infer<typeof signatureSchema>;

export interface Preflight {
  readonly nonce: string;
  readonly model: string;
  readonly nonceEchoed: boolean;
  /** Lower-case hex public keys, without 0x. */
  readonly gatewaySigners: readonly string[];
  readonly modelSigners: readonly string[];
  readonly fetchedAt: number;
}

export const normKey = (k: string): string => (k.startsWith("0x") || k.startsWith("0X") ? k.slice(2) : k).toLowerCase();
const signerOf = (a: z.infer<typeof signerFields>): string | undefined => {
  const k = a.signing_public_key ?? a.signing_address;
  return k === undefined ? undefined : normKey(k);
};

/** GET /attestation/report with a fresh 32-byte nonce, before the completion. */
export async function preflight(client: NearAiClient, model: string, o: { nonce?: string; clock?: () => number } = {}): Promise<Preflight> {
  const nonce = o.nonce ?? randomBytes(32).toString("hex");
  const qs = new URLSearchParams({ signing_algo: SIGNING_ALGO, nonce, model });
  const r = await client.getJson("GET /attestation/report", `/attestation/report?${qs}`, reportSchema);
  const gw = r.gateway_attestation ? signerOf(r.gateway_attestation) : undefined;
  return {
    nonce, model,
    nonceEchoed: r.gateway_attestation?.request_nonce === nonce,
    gatewaySigners: gw ? [gw] : [],
    modelSigners: [...new Set(r.model_attestations.map(signerOf).filter((k): k is string => k !== undefined))],
    fetchedAt: (o.clock ?? Date.now)(),
  };
}

/**
 * GET /signature/{chat_id}. The signature lives on the TEE node that served the completion, so a lookup can
 * transiently answer "not found": retried `attempts` times, `delayMs` apart. Returns undefined when it never
 * appears (the caller records "unverified", it does not fail the decision).
 */
export async function fetchSignature(
  client: NearAiClient,
  x: Pick<ChatExchange, "chatId" | "model">,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ChatSignature | undefined> {
  const attempts = o.attempts ?? 5;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const qs = new URLSearchParams({ model: x.model, signing_algo: SIGNING_ALGO });
  for (let i = 1; i <= attempts; i++) {
    try {
      return await client.getJson("GET /signature", `/signature/${encodeURIComponent(x.chatId)}?${qs}`, signatureSchema);
    } catch (e) {
      const transient = e instanceof NearAiError && (e.status === 404 || e.kind === "schema" || e.kind === "network" || e.kind === "timeout" || (e.status ?? 0) >= 500);
      if (!transient || i === attempts) {
        if (e instanceof NearAiError && e.kind === "auth") throw e;
        return undefined;
      }
      await sleep(o.delayMs ?? 1500);
    }
  }
  return undefined;
}

/** The payload a TEE signs for a given kind (chat-verification.md). */
export const expectedText = (kind: SignatureKind, model: string, requestSha256: string, responseSha256: string): string =>
  kind === "provider_tee" ? `${model}:${requestSha256}:${responseSha256}` : `${requestSha256}:${responseSha256}`;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** ed25519 over the UTF-8 text. False (never a throw) for any malformed key or signature. */
export function verifyEd25519(text: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const raw = Buffer.from(normKey(publicKeyHex), "hex");
    const sig = Buffer.from(normKey(signatureHex), "hex");
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(text, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export type AttestationStatus = "verified" | "unverified" | "invalid";

export interface AttestationResult {
  readonly status: AttestationStatus;
  readonly problems: readonly string[];
  readonly signatureKind?: SignatureKind;
  readonly signingAddress?: string;
  readonly signature?: string;
}

/**
 * Checks one exchange against its signature and the preflight. `preflight` may be omitted when re-checking a
 * stored record: then only the signature and the payload are checked and the signer binding is reported as not
 * checked (status at best `unverified`).
 */
export function checkAttestation(
  x: Pick<ChatExchange, "model" | "requestSha256" | "responseSha256">,
  sig: ChatSignature | undefined,
  pre: Preflight | undefined,
): AttestationResult {
  if (!sig) return { status: "unverified", problems: ["no signature available for this chat id"] };
  const base = { signingAddress: normKey(sig.signing_address), signature: normKey(sig.signature), ...(sig.signature_kind ? { signatureKind: sig.signature_kind } : {}) };
  if (!verifyEd25519(sig.text, sig.signature, sig.signing_address)) {
    return { status: "invalid", problems: ["ed25519 signature does not verify for the claimed signer"], ...base };
  }
  const problems: string[] = [];
  const kind = sig.signature_kind;
  if (!kind) problems.push("signature_kind missing: provenance unknown");
  else if (sig.text !== expectedText(kind, x.model, x.requestSha256, x.responseSha256)) {
    problems.push(`signed text is not ${kind === "provider_tee" ? "model:request:response" : "request:response"} for our bytes`);
  }
  if (!pre) problems.push("signer not checked against a preflight report");
  else {
    if (pre.model !== x.model) problems.push(`preflight was for model ${pre.model}, not ${x.model}`);
    if (!pre.nonceEchoed) problems.push("preflight report did not echo our nonce");
    if (kind) {
      const allowed = kind === "provider_tee" ? pre.modelSigners : pre.gatewaySigners;
      if (!allowed.includes(base.signingAddress)) problems.push(`signer is not a ${kind === "provider_tee" ? "model" : "gateway"} TEE key from the preflight`);
    }
  }
  return { status: problems.length ? "unverified" : "verified", problems, ...base };
}

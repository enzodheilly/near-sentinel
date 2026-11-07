import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { defaultRiskConfig as cfg } from "../../../src/config/default.ts";
import { expectedText } from "../../../src/decision/llm/attestation.ts";
import { NearAiClient } from "../../../src/decision/llm/client.ts";

export const { publicKey, privateKey } = generateKeyPairSync("ed25519");
export const PUB = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A fake NEAR AI Cloud: report, completion with `content`, then a provider_tee signature over the real hashes. */
export function cloud(content: string | (() => never), o: { signatureAfter?: number; reportStatus?: number } = {}) {
  let sent: Uint8Array | undefined;
  let received = "";
  let sigCalls = 0;
  const calls: string[] = [];
  const f = (async (u: string, init: RequestInit) => {
    const url = new URL(u);
    calls.push(url.pathname);
    if (url.pathname.endsWith("/attestation/report")) {
      if (o.reportStatus) return new Response("down", { status: o.reportStatus });
      return Response.json({ gateway_attestation: { request_nonce: url.searchParams.get("nonce") }, model_attestations: [{ signing_address: PUB }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      if (typeof content === "function") content();
      sent = init.body as Uint8Array;
      received = JSON.stringify({ id: "chat-9", choices: [{ message: { role: "assistant", content } }] });
      return new Response(received, { status: 200 });
    }
    if (++sigCalls <= (o.signatureAfter ?? 0)) return new Response("{}", { status: 404 });
    const text = expectedText("provider_tee", cfg.llm.model, sha(sent!), sha(received));
    return Response.json({ text, signature: sign(null, Buffer.from(text), privateKey).toString("hex"), signing_address: PUB, signing_algo: "ed25519", signature_kind: "provider_tee" });
  }) as unknown as typeof fetch;
  return { client: new NearAiClient({ apiKey: "k", fetch: f }), calls, sent: () => sent! };
}

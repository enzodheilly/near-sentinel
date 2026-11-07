import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkAttestation, expectedText, fetchSignature, preflight, verifyEd25519, type ChatSignature, type Preflight } from "../../../src/decision/llm/attestation.ts";
import { NearAiClient, NearAiError } from "../../../src/decision/llm/client.ts";

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const x = { model: MODEL, requestSha256: sha("request bytes"), responseSha256: sha("response bytes") };

const keypair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  return { pub: raw, priv: privateKey };
};
const signText = (text: string, priv: KeyObject) => `0x${sign(null, Buffer.from(text, "utf8"), priv).toString("hex")}`;

const modelTee = keypair();
const gatewayTee = keypair();
const pre: Preflight = { nonce: "n", model: MODEL, nonceEchoed: true, gatewaySigners: [gatewayTee.pub], modelSigners: [modelTee.pub], fetchedAt: 0 };
const providerSig = (text = expectedText("provider_tee", MODEL, x.requestSha256, x.responseSha256)): ChatSignature => ({
  text, signature: signText(text, modelTee.priv), signing_address: `0x${modelTee.pub}`, signing_algo: "ed25519", signature_kind: "provider_tee",
});

describe("checkAttestation", () => {
  it("provider_tee: valid signature over model:request:response, signer from the preflight → verified", () => {
    const r = checkAttestation(x, providerSig(), pre);
    expect(r).toMatchObject({ status: "verified", problems: [], signatureKind: "provider_tee", signingAddress: modelTee.pub });
  });

  it("gateway: request:response signed by the gateway TEE → verified", () => {
    const text = expectedText("gateway", MODEL, x.requestSha256, x.responseSha256);
    const sig: ChatSignature = { text, signature: signText(text, gatewayTee.priv), signing_address: gatewayTee.pub, signature_kind: "gateway" };
    expect(checkAttestation(x, sig, pre).status).toBe("verified");
  });

  it("tampered text, signature or key → invalid", () => {
    const s = providerSig();
    expect(checkAttestation(x, { ...s, text: s.text.replace(/.$/, "0") }, pre).status).toBe("invalid");
    expect(checkAttestation(x, { ...s, signature: s.signature.replace(/..$/, s.signature.endsWith("00") ? "01" : "00") }, pre).status).toBe("invalid");
    expect(checkAttestation(x, { ...s, signing_address: gatewayTee.pub }, pre).status).toBe("invalid");
    expect(checkAttestation(x, { ...s, signature: "0xzz" }, pre).status).toBe("invalid");
  });

  it("a genuine signature over SOMEONE ELSE's bytes → unverified (text is not ours)", () => {
    const other = expectedText("provider_tee", MODEL, sha("other request"), x.responseSha256);
    const r = checkAttestation(x, providerSig(other), pre);
    expect(r.status).toBe("unverified");
    expect(r.problems.join()).toMatch(/signed text/);
  });

  it("wrong text for the kind (gateway payload under provider_tee) → unverified", () => {
    expect(checkAttestation(x, providerSig(`${x.requestSha256}:${x.responseSha256}`), pre).status).toBe("unverified");
  });

  it("unknown signer, or a model key used for a gateway signature → unverified", () => {
    const stranger = keypair();
    const text = expectedText("provider_tee", MODEL, x.requestSha256, x.responseSha256);
    const r = checkAttestation(x, { ...providerSig(), signature: signText(text, stranger.priv), signing_address: stranger.pub }, pre);
    expect(r).toMatchObject({ status: "unverified" });
    expect(r.problems.join()).toMatch(/not a model TEE key/);

    const gwText = expectedText("gateway", MODEL, x.requestSha256, x.responseSha256);
    const wrongRole: ChatSignature = { text: gwText, signature: signText(gwText, modelTee.priv), signing_address: modelTee.pub, signature_kind: "gateway" };
    expect(checkAttestation(x, wrongRole, pre).status).toBe("unverified");
  });

  it("missing signature_kind (legacy) → unverified even if the crypto holds", () => {
    const { signature_kind: _k, ...legacy } = providerSig();
    const r = checkAttestation(x, legacy, pre);
    expect(r.status).toBe("unverified");
    expect(r.problems.join()).toMatch(/signature_kind missing/);
  });

  it("no signature, no preflight, nonce not echoed, other model → unverified", () => {
    expect(checkAttestation(x, undefined, pre).status).toBe("unverified");
    expect(checkAttestation(x, providerSig(), undefined).problems).toEqual(["signer not checked against a preflight report"]);
    expect(checkAttestation(x, providerSig(), { ...pre, nonceEchoed: false }).status).toBe("unverified");
    expect(checkAttestation(x, providerSig(), { ...pre, model: "other/model" }).status).toBe("unverified");
  });
});

describe("verifyEd25519", () => {
  it("never throws on malformed input", () => {
    expect(verifyEd25519("t", "nothex", "nothex")).toBe(false);
    expect(verifyEd25519("t", "00", modelTee.pub)).toBe(false);
  });
});

// ---------------------------------------------------------------- HTTP side
type Call = { url: string };
const routes = (handler: (url: URL) => { status: number; body: unknown }, calls: Call[] = []) =>
  (async (u: string) => {
    calls.push({ url: u });
    const r = handler(new URL(u));
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;

describe("preflight", () => {
  it("asks with our nonce, model and ed25519; keeps the signer keys normalised", async () => {
    const calls: Call[] = [];
    const client = new NearAiClient({
      apiKey: "k",
      fetch: routes((u) => ({ status: 200, body: {
        gateway_attestation: { signing_address: `0x${gatewayTee.pub.toUpperCase()}`, request_nonce: u.searchParams.get("nonce") },
        model_attestations: [{ signing_address: `0x${modelTee.pub}`, intel_quote: "q" }, { signing_public_key: modelTee.pub }],
      } }), calls),
    });
    const p = await preflight(client, MODEL, { nonce: "ab".repeat(32), clock: () => 7 });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/attestation/report");
    expect(Object.fromEntries(u.searchParams)).toEqual({ signing_algo: "ed25519", nonce: "ab".repeat(32), model: MODEL });
    expect(p).toEqual({ nonce: "ab".repeat(32), model: MODEL, nonceEchoed: true, gatewaySigners: [gatewayTee.pub], modelSigners: [modelTee.pub], fetchedAt: 7 });
  });

  it("a random nonce by default; a report that ignores it is flagged", async () => {
    const client = new NearAiClient({ apiKey: "k", fetch: routes(() => ({ status: 200, body: { gateway_attestation: { request_nonce: "stale" } } })) });
    const p = await preflight(client, MODEL);
    expect(p.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(p.nonceEchoed).toBe(false);
    expect(p.modelSigners).toEqual([]);
  });
});

describe("fetchSignature", () => {
  const noSleep = async () => {};
  it("retries 'not found' until the serving node answers", async () => {
    let n = 0;
    const calls: Call[] = [];
    const client = new NearAiClient({ apiKey: "k", fetch: routes(() => (++n < 3 ? { status: 404, body: { detail: "Chat id not found or expired" } } : { status: 200, body: providerSig() }), calls) });
    const s = await fetchSignature(client, { chatId: "chat/1", model: MODEL }, { sleep: noSleep });
    expect(s?.signature_kind).toBe("provider_tee");
    expect(calls).toHaveLength(3);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/signature/chat%2F1");
    expect(Object.fromEntries(u.searchParams)).toEqual({ model: MODEL, signing_algo: "ed25519" });
  });

  it("gives up after the attempts (undefined, not a throw); a bad key is an error", async () => {
    const missing = new NearAiClient({ apiKey: "k", fetch: routes(() => ({ status: 404, body: "{}" })) });
    expect(await fetchSignature(missing, { chatId: "c", model: MODEL }, { attempts: 2, sleep: noSleep })).toBeUndefined();
    const bad = new NearAiClient({ apiKey: "k", fetch: routes(() => ({ status: 401, body: "no" })) });
    await expect(fetchSignature(bad, { chatId: "c", model: MODEL }, { sleep: noSleep })).rejects.toBeInstanceOf(NearAiError);
  });
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candleSourceFor } from "../../../src/cli/verify.ts";
import { defaultRiskConfig as cfg } from "../../../src/config/default.ts";
import { configHash, type RiskConfig } from "../../../src/config/schema.ts";
import { loadFixtureSet } from "../../../src/data/fixtures.ts";
import { recheckReview } from "../../../src/decision/llm/attestation.ts";
import { nearAiVeto } from "../../../src/decision/llm/veto.ts";
import { hashRecord, readRecord, recordBytes } from "../../../src/decision/record.ts";
import { verifyRecord } from "../../../src/decision/verify.ts";
import { runReplay } from "../../../src/execution/replay.ts";
import type { DecisionRecord, LlmReview } from "../../../src/types.ts";
import { cloud, PUB } from "./fake-cloud.ts";

const META = { agentVersion: "test", configHash: configHash(cfg) };
const configs = new Map<string, RiskConfig>([[META.configHash, cfg]]);
const root = new URL("../../../", import.meta.url).pathname;

/** demo-entry replayed with the attested veto (fake cloud, real ed25519) instead of the replay stub. */
async function attestedRun(content: string) {
  const set = await loadFixtureSet(join(root, "fixtures", "demo-entry"));
  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  const veto = nearAiVeto(cloud(content).client, cfg, { sleep: async () => {} });
  const run = await runReplay({ set, cfg, meta: META, dir, llm: veto });
  const records = await Promise.all(run.hashes.map(async (h) => ({ hash: h, rec: await readRecord(dir, h) })));
  const entry = records.find((r) => r.rec.llm)!;
  return { set, dir, run, entry };
}

describe("LLM evidence in decision records", () => {
  it("the entry record stores model, verdict, chat id, hashes, signature, signer, kind and status; verify checks the signature", async () => {
    const { set, entry } = await attestedRun('{"verdict":"approve","sizeMultiplier":1,"rationale":"Breakout above the band, stop under the gap."}');
    expect(entry.rec.llm).toMatchObject({
      model: cfg.llm.model, verdict: "approve", sizeMultiplier: 1, chatId: "chat-9", signingAddress: PUB, signatureKind: "provider_tee",
      attestation: { status: "verified", problems: [] },
    });
    expect(entry.rec.llm!.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.rec.llm!.signature).toMatch(/^[0-9a-f]{128}$/);
    // the same review is on the tape the verifier replays
    expect(entry.rec.inputs.externals.calls.find((c) => c.kind === "llm")).toMatchObject({ review: { chatId: "chat-9" } });

    const res = await verifyRecord(entry.rec, { configs, candles: candleSourceFor(entry.rec, [set]).candles, expectedHash: entry.hash });
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.notes.join("\n")).toMatch(/signed by the provider_tee key/);
  });

  it("a reduce verdict halves the trade and is recorded", async () => {
    const full = await attestedRun('{"verdict":"approve","sizeMultiplier":1,"rationale":"ok"}');
    const half = await attestedRun('{"verdict":"reduce","sizeMultiplier":0.5,"rationale":"RSI already high."}');
    const n = (r: typeof full) => r.run.executions[0]!.proposal;
    expect(half.entry.rec.llm?.verdict).toBe("reduce");
    expect((n(half) as { notionalUsd: number }).notionalUsd).toBeCloseTo((n(full) as { notionalUsd: number }).notionalUsd / 2, 6);
  });

  it("a record whose signature or hashes were changed (and re-hashed) fails verify", async () => {
    const { set, dir, entry } = await attestedRun('{"verdict":"approve","sizeMultiplier":1,"rationale":"ok"}');
    const forge = (patch: Partial<LlmReview>): DecisionRecord => {
      const llm = { ...entry.rec.llm!, ...patch };
      const calls = entry.rec.inputs.externals.calls.map((c) => (c.kind === "llm" ? { ...c, review: llm } : c));
      return { ...entry.rec, llm, inputs: { ...entry.rec.inputs, externals: { ...entry.rec.inputs.externals, calls } } };
    };
    for (const patch of [
      { signature: entry.rec.llm!.signature!.replace(/^./, (c) => (c === "0" ? "1" : "0")) },
      { responseSha256: "0".repeat(64) },
      { model: "some/other-model" },
    ]) {
      const forged = forge(patch);
      const hash = hashRecord(forged);
      await writeFile(join(dir, `${hash}.json`), recordBytes(forged));
      const res = await verifyRecord(await readRecord(dir, hash), { configs, candles: candleSourceFor(forged, [set]).candles, expectedHash: hash });
      expect(res.ok).toBe(false);
      expect(res.problems.join()).toMatch(/does not verify/);
    }
  });
});

describe("recheckReview", () => {
  const base = { model: cfg.llm.model };
  it("replay stub: nothing to check, a note", () => {
    expect(recheckReview({ model: "none (replay)" })).toEqual({ problems: [], notes: ["llm: no model call to check (none (replay))"] });
  });
  it("claims verified without evidence → problem", () => {
    expect(recheckReview({ ...base, attestation: { status: "verified", problems: [] } }).problems).toHaveLength(1);
    expect(recheckReview({ ...base, chatId: "c", attestation: { status: "verified", problems: [] } }).problems).toHaveLength(1);
  });
  it("honest unverified without a signature → note with the reason", () => {
    const r = recheckReview({ ...base, chatId: "c", attestation: { status: "unverified", problems: ["no signature available for this chat id"] } });
    expect(r.problems).toEqual([]);
    expect(r.notes[0]).toMatch(/no signature available/);
  });
});

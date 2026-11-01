import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureError, loadFixtureSet, windowRef } from "../../src/data/fixtures.ts";
import type { Candle } from "../../src/types.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function candles(n: number, step = H, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 3 + 0.01 * Math.sin(i);
    return { openTime: start + i * step, open: p, high: p + 0.02, low: p - 0.02, close: p + 0.005, volume: 1000 + i };
  });
}

/** Writes a fixture set in the frozen layout: bare candle arrays plus a manifest hashing their bytes. */
async function writeSet(dir: string, opts: { manifest?: Record<string, unknown>; series?: Record<string, Candle[]> } = {}) {
  const series = opts.series ?? { NEARUSDT_1h: candles(10), BTCUSDT_4h: candles(4, 4 * H) };
  const files: Record<string, unknown> = {};
  for (const [key, cs] of Object.entries(series)) {
    const text = JSON.stringify(cs);
    await writeFile(join(dir, `${key}.json`), text);
    files[key] = { candles: cs.length, from: iso(cs[0]!.openTime), to: iso(cs.at(-1)!.openTime), sha256: sha(text) };
  }
  const manifest = {
    name: "demo-entry", asset: "NEAR", breakoutBar: iso(T0 + 5 * H), kind: "ENTRY", reason: "OK", files,
    event: { confirmations: ["RSI_MOMENTUM", "FVG_SUPPORT"], vetoes: [], sim: { resultR: 2 } },
    ...opts.manifest,
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

describe("loadFixtureSet", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentinel-fx-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("loads a valid set and maps the expectation", async () => {
    await writeSet(dir);
    const set = await loadFixtureSet(dir);
    expect(set.series["NEARUSDT"]?.["1h"]?.candles).toHaveLength(10);
    expect(set.series["BTCUSDT"]?.["4h"]?.candles).toHaveLength(4);
    expect(set.signalBarTime).toBe(T0 + 5 * H);
    expect(set.expected).toEqual({ decision: "ENTRY", confirmations: ["RSI_MOMENTUM", "FVG_SUPPORT"], vetoes: [] });
    expect(set.manifest.event["sim"]).toEqual({ resultR: 2 }); // provenance is kept
  });

  it("maps a refusal reason to the engine's RejectReason", async () => {
    await writeSet(dir, { manifest: { kind: "REFUSAL", reason: "RSI_EXHAUSTION", event: { confirmations: [], vetoes: ["RSI_EXHAUSTION"] } } });
    expect((await loadFixtureSet(dir)).expected).toMatchObject({ decision: "REJECT", reason: "VETO_RSI_EXHAUSTION", vetoes: ["RSI_EXHAUSTION"] });
  });

  it("rejects a file whose bytes changed (even a whitespace change)", async () => {
    await writeSet(dir);
    const cs = candles(10);
    await writeFile(join(dir, "NEARUSDT_1h.json"), JSON.stringify(cs, null, 1));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/sha256 mismatch/);
  });

  it("rejects a tampered candle", async () => {
    await writeSet(dir);
    const cs = candles(10);
    cs[3] = { ...cs[3]!, close: cs[3]!.close + 0.001 };
    await writeFile(join(dir, "NEARUSDT_1h.json"), JSON.stringify(cs));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/sha256 mismatch/);
  });

  it("rejects a gap, even when the hash matches", async () => {
    const cs = candles(10);
    cs.splice(4, 1);
    await writeSet(dir, { series: { NEARUSDT_1h: cs }, manifest: { breakoutBar: iso(T0 + 2 * H) } });
    await expect(loadFixtureSet(dir)).rejects.toThrow(/gap of 1 candle/);
  });

  it("rejects inconsistent OHLC", async () => {
    const cs = candles(10);
    cs[2] = { ...cs[2]!, high: cs[2]!.low - 0.1 };
    await writeSet(dir, { series: { NEARUSDT_1h: cs } });
    await expect(loadFixtureSet(dir)).rejects.toThrow(/inconsistent OHLC/);
  });

  it("rejects a count or range that does not match the manifest", async () => {
    const m = await writeSet(dir);
    const files = m.files as Record<string, { candles: number; to: string }>;
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...m, files: { ...files, NEARUSDT_1h: { ...files["NEARUSDT_1h"]!, candles: 11 } } }));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/announces 11 candles/);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...m, files: { ...files, NEARUSDT_1h: { ...files["NEARUSDT_1h"]!, to: iso(T0) } } }));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/last candle/);
  });

  it("rejects a missing file and an unlisted file", async () => {
    await writeSet(dir);
    await writeFile(join(dir, "ETHUSDT_1h.json"), "[]");
    await expect(loadFixtureSet(dir)).rejects.toThrow(/not listed in the manifest: ETHUSDT_1h.json/);
    await rm(join(dir, "ETHUSDT_1h.json"));
    await rm(join(dir, "BTCUSDT_4h.json"));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/missing/);
  });

  it("rejects a signal bar outside the asset's 1h series", async () => {
    await writeSet(dir, { manifest: { breakoutBar: iso(T0 + 50 * H) } });
    await expect(loadFixtureSet(dir)).rejects.toThrow(/signal bar .* is not in NEARUSDT 1h/);
  });

  it("rejects an unknown refusal reason or signal name", async () => {
    await writeSet(dir, { manifest: { kind: "REFUSAL", reason: "BAD_VIBES" } });
    await expect(loadFixtureSet(dir)).rejects.toThrow(/unknown refusal reason/);
    await writeSet(dir, { manifest: { event: { confirmations: ["MOON"], vetoes: [] } } });
    await expect(loadFixtureSet(dir)).rejects.toThrow(FixtureError);
  });
});

describe("windowRef", () => {
  it("hashes candles independently of key order", () => {
    const cs = candles(3);
    const reordered = cs.map(({ volume, close, low, high, open, openTime }) => ({ volume, close, low, high, open, openTime }));
    expect(windowRef("NEARUSDT", "1h", cs).sha256).toBe(windowRef("NEARUSDT", "1h", reordered).sha256);
    expect(windowRef("NEARUSDT", "1h", cs)).toMatchObject({ count: 3, firstOpenTime: T0, lastOpenTime: T0 + 2 * H });
  });
});

// The committed demo fixtures (frozen on 19 Oct 2026, see fixtures/README.md).
describe.each([
  { name: "demo-entry", bar: "2026-07-20T09:00:00.000Z", fourHour: 185, decision: "ENTRY", reason: undefined },
  { name: "demo-refusal", bar: "2026-09-20T16:00:00.000Z", fourHour: 186, decision: "REJECT", reason: "VETO_RSI_EXHAUSTION" },
] as const)("committed fixture $name", ({ name, bar, fourHour, decision, reason }) => {
  const dir = new URL(`../../fixtures/${name}/`, import.meta.url).pathname;

  it("loads and verifies every file against its manifest", async () => {
    const set = await loadFixtureSet(dir);
    for (const sym of ["NEARUSDT", "BTCUSDT"]) {
      expect(set.series[sym]?.["1h"]?.candles).toHaveLength(301);
      expect(set.series[sym]?.["4h"]?.candles).toHaveLength(fourHour);
    }
    expect(iso(set.signalBarTime)).toBe(bar);
    expect(set.expected.decision).toBe(decision);
    expect(set.expected.reason).toBe(reason);
  });

  it("puts the signal bar exactly at index 200, the warm-up boundary (RISK_ENGINE.md §2)", async () => {
    const set = await loadFixtureSet(dir);
    const near1h = set.series["NEARUSDT"]?.["1h"]?.candles ?? [];
    expect(near1h.findIndex((c) => c.openTime === set.signalBarTime)).toBe(200);
  });
});

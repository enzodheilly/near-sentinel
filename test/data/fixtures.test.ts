import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixtureError, loadFixtureSet, parseFixtureFile, windowRef } from "../../src/data/fixtures.ts";
import type { Candle } from "../../src/types.ts";

const H = 3_600_000;
const T0 = Date.parse("2026-07-01T00:00:00Z");

function candles(n: number, step = H, start = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 3 + 0.01 * Math.sin(i);
    return { openTime: start + i * step, open: p, high: p + 0.02, low: p - 0.02, close: p + 0.005, volume: 1000 + i };
  });
}

/** Builds fixture file text exactly as the freezing tool does: sha256 of JSON.stringify(candles). */
function fixtureText(symbol: string, interval: "1h" | "4h", cs: Candle[], extra: Record<string, unknown> = {}): string {
  const sha256 = createHash("sha256").update(JSON.stringify(cs)).digest("hex");
  return JSON.stringify({ meta: { purpose: "test", symbol, interval, count: cs.length, sha256, ...extra }, candles: cs });
}

describe("parseFixtureFile", () => {
  it("accepts a well-formed file and keeps extra provenance fields", () => {
    const s = parseFixtureFile("NEARUSDT_1h.json", fixtureText("NEARUSDT", "1h", candles(5), { source: "binance" }));
    expect(s.candles).toHaveLength(5);
    expect(s.meta["source"]).toBe("binance");
  });

  it("rejects a tampered candle (hash mismatch)", () => {
    const cs = candles(5);
    const text = fixtureText("NEARUSDT", "1h", cs);
    const tampered = text.replace(`"close":${cs[2]!.close}`, `"close":${cs[2]!.close + 0.001}`);
    expect(tampered).not.toBe(text);
    expect(() => parseFixtureFile("NEARUSDT_1h.json", tampered)).toThrow(/sha256 mismatch/);
  });

  it("rejects a gap in the series", () => {
    const cs = candles(6);
    cs.splice(3, 1);
    expect(() => parseFixtureFile("NEARUSDT_1h.json", fixtureText("NEARUSDT", "1h", cs))).toThrow(/gap of 1 candle/);
  });

  it("rejects unsorted or duplicate candles", () => {
    const cs = candles(4);
    cs[2] = { ...cs[1]! };
    expect(() => parseFixtureFile("NEARUSDT_1h.json", fixtureText("NEARUSDT", "1h", cs))).toThrow(/not after/);
  });

  it("rejects inconsistent OHLC", () => {
    const cs = candles(3);
    cs[1] = { ...cs[1]!, high: cs[1]!.low - 0.1 };
    expect(() => parseFixtureFile("NEARUSDT_1h.json", fixtureText("NEARUSDT", "1h", cs))).toThrow(/inconsistent OHLC/);
  });

  it("rejects a count, symbol or interval that does not match", () => {
    const cs = candles(3);
    const sha256 = createHash("sha256").update(JSON.stringify(cs)).digest("hex");
    const bad = (meta: object) => JSON.stringify({ meta: { symbol: "NEARUSDT", interval: "1h", count: 3, sha256, ...meta }, candles: cs });
    expect(() => parseFixtureFile("NEARUSDT_1h.json", bad({ count: 4 }))).toThrow(/meta.count/);
    expect(() => parseFixtureFile("NEARUSDT_1h.json", bad({ symbol: "BTCUSDT" }))).toThrow(/meta.symbol/);
    expect(() => parseFixtureFile("NEARUSDT_1h.json", bad({ interval: "4h" }))).toThrow(/meta.interval/);
  });

  it("rejects bad file names and invalid JSON with a FixtureError", () => {
    expect(() => parseFixtureFile("near.json", "{}")).toThrow(FixtureError);
    expect(() => parseFixtureFile("NEARUSDT_1h.json", "{not json")).toThrow(/invalid JSON/);
  });
});

describe("loadFixtureSet", () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), "sentinel-fx-")), "demo-entry");
    await mkdir(dir);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("loads every series and the shared expectation", async () => {
    const bar = new Date(T0 + 3 * H).toISOString();
    const expected = { decision: "ENTRY", reason: null, confirmations: ["RSI_MOMENTUM", "FVG_SUPPORT"], vetoes: [] };
    await writeFile(join(dir, "NEARUSDT_1h.json"), fixtureText("NEARUSDT", "1h", candles(5), { signalBar: bar, expected }));
    await writeFile(join(dir, "BTCUSDT_4h.json"), fixtureText("BTCUSDT", "4h", candles(3, 4 * H), { signalBar: bar, expected }));
    const set = await loadFixtureSet(dir);
    expect(set.name).toBe("demo-entry");
    expect(set.series["NEARUSDT"]?.["1h"]?.candles).toHaveLength(5);
    expect(set.series["BTCUSDT"]?.["4h"]?.candles).toHaveLength(3);
    expect(set.signalBarTime).toBe(T0 + 3 * H);
    expect(set.expected?.decision).toBe("ENTRY");
  });

  it("rejects files that disagree on the signal bar", async () => {
    await writeFile(join(dir, "NEARUSDT_1h.json"), fixtureText("NEARUSDT", "1h", candles(5), { signalBar: "2026-07-01T03:00:00.000Z" }));
    await writeFile(join(dir, "BTCUSDT_1h.json"), fixtureText("BTCUSDT", "1h", candles(5), { signalBar: "2026-07-01T04:00:00.000Z" }));
    await expect(loadFixtureSet(dir)).rejects.toThrow(/disagree on signalBar/);
  });

  it("rejects an empty directory", async () => {
    await expect(loadFixtureSet(dir)).rejects.toThrow(/no fixture files/);
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

// The real demo fixtures, once committed (TASK_LIST T0.6).
const REAL = [
  { name: "demo-entry", oneHour: 301, fourHour: 185, decision: "ENTRY" },
  { name: "demo-refusal", oneHour: 301, fourHour: 186, decision: "REJECT" },
] as const;

describe.each(REAL)("committed fixture $name", ({ name, oneHour, fourHour, decision }) => {
  const dir = new URL(`../../fixtures/${name}/`, import.meta.url).pathname;
  it.skipIf(!existsSync(dir))("loads, verifies and matches the frozen counts", async () => {
    const set = await loadFixtureSet(dir);
    for (const sym of ["NEARUSDT", "BTCUSDT"]) {
      expect(set.series[sym]?.["1h"]?.candles).toHaveLength(oneHour);
      expect(set.series[sym]?.["4h"]?.candles).toHaveLength(fourHour);
    }
    expect(set.expected?.decision).toBe(decision);
  });
});

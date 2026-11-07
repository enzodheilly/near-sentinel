import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runDemo } from "../../src/cli/demo.ts";
import { runStatus, saveState } from "../../src/cli/status.ts";
import { runVerify } from "../../src/cli/verify.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
let records: string;
let statePath: string;
let demoOut: string;

const run = async (f: (w: (l: string) => void) => Promise<number>) => {
  const lines: string[] = [];
  const code = await f((l) => lines.push(l));
  return { code, out: lines.join("\n") };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  records = join(dir, "records");
  statePath = join(dir, "state", "portfolio.json");
  demoOut = (await run((write) => runDemo({ root, out: records, write, agentVersion: "test", fetch: offline, statePath }))).out;
}, 60_000);

describe("pnpm verify", () => {
  it("--all: every replay record verifies, exit 0", async () => {
    const r = await run((write) => runVerify({ root, records, args: ["--all"], write }));
    const n = readdirSync(records).length;
    expect(r.code).toBe(0);
    expect(r.out).toBe(`✓ ${n} of ${n} record(s) verified`);
  }, 60_000);

  it("one hash (or an 8+ character prefix): says what was checked and what is not checked yet", async () => {
    const h = demoOut.match(/TRADE {2}buy .* ([0-9a-f]{64})/)![1]!;
    const r = await run((write) => runVerify({ root, records, args: [h.slice(0, 10)], write }));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`✓ ${h}  NEAR 2026-07-20 09:00 TRADE`);
    expect(r.out).toMatch(/candles: NEARUSDT 1h \(201\), BTCUSDT 1h \(201\), BTCUSDT 4h \(159\) match demo-entry/);
    expect(r.out).toMatch(/LLM signature: none/);
    expect(r.out).toMatch(/note: llm: no model call to check/);
    expect(r.out).toMatch(/on-chain anchor: not checked yet/);
  });

  it("a tampered record: readable message and a non-zero exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tamper-"));
    const h = demoOut.match(/REJECT VETO_RSI_EXHAUSTION +([0-9a-f]{64})/)![1]!;
    const bytes = readFileSync(join(records, `${h}.json`), "utf8");
    writeFileSync(join(dir, `${h}.json`), bytes.replace('"REJECT"', '"TRADE"'));
    const r = await run((write) => runVerify({ root, records: dir, args: [h], write }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^✗ ${h}\\n {4}record ${h}: file content hashes to [0-9a-f]{64} \\(modified after it was written\\)$`));
  });

  it("a record whose hash was recomputed after tampering is caught by the recomputation", async () => {
    const { hashRecord } = await import("../../src/decision/record.ts");
    const { canonicalJson } = await import("../../src/lib/canonical.ts");
    const dir = mkdtempSync(join(tmpdir(), "forge-"));
    const h = demoOut.match(/REJECT VETO_RSI_EXHAUSTION +([0-9a-f]{64})/)![1]!;
    const rec = JSON.parse(readFileSync(join(records, `${h}.json`), "utf8"));
    const forged = { ...rec, outcome: { action: "HOLD", reason: "NO_SIGNAL" } };
    const fh = hashRecord(forged);
    writeFileSync(join(dir, `${fh}.json`), canonicalJson(forged)); // a consistent file, but a lie
    const r = await run((write) => runVerify({ root, records: dir, args: [fh], write }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/recomputed decision differs at outcome\.action: record has "HOLD", recomputation gives "REJECT"/);
  });

  it("unknown or ambiguous hashes and an empty call are errors", async () => {
    expect((await run((write) => runVerify({ root, records, args: ["deadbeef00"], write }))).out).toMatch(/deadbeef00: no such record/);
    expect((await run((write) => runVerify({ root, records, args: ["xyz"], write }))).code).toBe(1);
    expect((await run((write) => runVerify({ root, records, args: [], write }))).out).toMatch(/usage: pnpm verify/);
  });
});

describe("pnpm status", () => {
  it("shows the last saved state: equity, limits, positions", async () => {
    const r = await run((write) => runStatus({ statePath, records, write }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^NEAR Sentinel status — replay demo-refusal, as of 2026-09-21 \d\d:00 UTC/);
    expect(r.out).toMatch(/today \+0\.00% \(stop new entries at −3%\) · from peak \$1000\.00 \+0\.00% \(kill switch at −10%\)/);
    expect(r.out).toMatch(/entries today 0\/6 · kill switch off/);
  });

  it("lists open positions with stop and targets, and a tripped kill switch", async () => {
    const p = { at: Date.parse("2026-07-20T12:00:00Z"), balances: { USDC: 750, BTC: 0, NEAR: 64.5 }, equityUsd: 870, peakEquityUsd: 1000, dayStartEquityUsd: 1000,
      entriesToday: 1, cooldownUntil: { BTC: Date.parse("2026-07-20T14:00:00Z") }, killSwitch: true,
      positions: [{ asset: "NEAR" as const, quantity: 64.5, entryPrice: 1.936, entryBarTime: Date.parse("2026-07-20T09:00:00Z"), initialStop: 1.91, stopPrice: 1.936, takeProfit: [1.974, 2.013] as const, tp1Hit: true, highestCloseSinceEntry: 1.98 }] };
    const path = join(mkdtempSync(join(tmpdir(), "st-")), "p.json");
    await saveState(path, { savedAt: 0, source: "paper", portfolio: p });
    const r = await run((write) => runStatus({ statePath: path, records, write }));
    expect(r.out).toMatch(/today -13\.00% .* from peak \$1000\.00 -13\.00%/);
    expect(r.out).toMatch(/kill switch ON — owner reset required/);
    expect(r.out).toMatch(/cooldowns BTC until 2026-07-20 14:00/);
    expect(r.out).toMatch(/position NEAR 64\.5 @ 1\.936 .* stop 1\.93600 · TP1 1\.97400 \(hit\) · TP2 2\.01300/);
  });

  it("without saved state, falls back to the latest record and says so; with nothing, exits 1", async () => {
    const r = await run((write) => runStatus({ statePath: "/nonexistent/p.json", records, write }));
    expect(r.out).toMatch(/^\(no \/nonexistent\/p\.json; showing the state recorded with the latest decision\)/);
    expect((await run((write) => runStatus({ statePath: "/nonexistent/p.json", records: "/nonexistent", write }))).code).toBe(1);
  });
});

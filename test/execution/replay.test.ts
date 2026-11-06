import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash } from "../../src/config/schema.ts";
import { loadFixtureSet, type FixtureSet } from "../../src/data/fixtures.ts";
import { readRecord } from "../../src/decision/record.ts";
import { verifyRecord } from "../../src/decision/verify.ts";
import { REPLAY_LLM_RATIONALE, ReplayExecutor, runReplay, scenarioBars, type ReplayRun } from "../../src/execution/replay.ts";
import type { EntryProposal, ExitProposal } from "../../src/types.ts";

const META = { agentVersion: "test", configHash: configHash(cfg) };
const GOLDEN = new URL("../golden/demo-entry.json", import.meta.url).pathname;
const fix = (n: string) => loadFixtureSet(new URL(`../../fixtures/${n}/`, import.meta.url).pathname);
const round = (x: number) => Number(x.toPrecision(10));

/** What the golden file pins: every execution and the end state, rounded to 10 significant digits. */
const summary = (r: ReplayRun) => ({
  bars: r.bars,
  trades: r.executions.map((e) => ({
    bar: new Date(e.barTime).toISOString(),
    kind: e.proposal.kind,
    ...(e.proposal.kind === "EXIT" ? { reason: e.proposal.reason } : {}),
    price: round(e.report.fill!.price),
    quantityIn: round(e.report.fill!.quantityIn),
    quantityOut: round(e.report.fill!.quantityOut),
  })),
  end: { usdc: round(r.end.balances.USDC), near: round(r.end.balances.NEAR), positions: r.end.positions.length },
});

let entrySet: FixtureSet;
let refusalSet: FixtureSet;
let entry: ReplayRun;
let refusal: ReplayRun;
const dirs = { entry: mkdtempSync(join(tmpdir(), "replay-")), refusal: mkdtempSync(join(tmpdir(), "replay-")) };

beforeAll(async () => {
  entrySet = await fix("demo-entry");
  refusalSet = await fix("demo-refusal");
  entry = await runReplay({ set: entrySet, cfg, meta: META, dir: dirs.entry });
  const b = scenarioBars(refusalSet);
  refusal = await runReplay({ set: refusalSet, cfg, meta: META, dir: dirs.refusal, ...(b ? { bars: b } : {}) });
}, 60_000);

describe("replay of demo-entry", () => {
  it("entry → TP1 → TP2 matches the golden file", () => {
    const got = summary(entry);
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) writeFileSync(GOLDEN, `${JSON.stringify(got, null, 2)}\n`);
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    expect(got.trades.map((t) => t.reason ?? t.kind)).toEqual(["ENTRY", "TAKE_PROFIT_1", "TAKE_PROFIT_2"]);
  });

  it("follows the frozen scenario: TP1 3 bars after entry, TP2 17 bars after, +2.25 R", () => {
    const [e, tp1, tp2] = entry.executions;
    expect([(tp1!.barTime - e!.barTime) / 3_600_000, (tp2!.barTime - e!.barTime) / 3_600_000]).toEqual([3, 17]);
    const p = e!.proposal as EntryProposal;
    const pnl = entry.end.balances.USDC - entry.start.balances.USDC;
    expect(pnl / p.riskUsd).toBeCloseTo(2.25, 5); // USDC settles to 6 decimals
    expect(entry.end.positions).toEqual([]);
    expect(entry.end.balances.NEAR).toBe(0); // the last exit sold everything held
  });

  it("every record verifies, and the LLM stage says plainly that no model ran", async () => {
    for (const h of entry.hashes) {
      const rec = await readRecord(dirs.entry, h);
      const res = await verifyRecord(rec, { configs: new Map([[META.configHash, cfg]]), candles: (s, i) => entrySet.series[s]?.[i]?.candles, expectedHash: h });
      expect(res.problems, h).toEqual([]);
    }
    const trade = entry.decisions.find((d) => d.outcome.action === "TRADE" && d.outcome.proposal.kind === "ENTRY")!;
    expect(trade.llm?.rationale).toBe(REPLAY_LLM_RATIONALE);
  });
});

describe("replay of demo-refusal", () => {
  it("produces no trade: the refusal bar is rejected for RSI exhaustion, the next 24 h hold", () => {
    expect(refusal.executions).toEqual([]);
    expect(refusal.bars).toBe(25);
    const rejects = refusal.decisions.filter((d) => d.outcome.action === "REJECT");
    expect(rejects.map((d) => [d.asset, d.barTime, "reason" in d.outcome && d.outcome.reason])).toEqual([["NEAR", refusalSet.signalBarTime, "VETO_RSI_EXHAUSTION"]]);
    expect(refusal.end.balances).toEqual(refusal.start.balances);
  });
});

describe("ReplayExecutor", () => {
  const now = () => 1_790_000_000_000;
  const entryP: EntryProposal = { kind: "ENTRY", asset: "NEAR", barTime: 0, referencePrice: 2, notionalUsd: 100, quantity: 50, stopPrice: 1.9, takeProfit: [2.15, 2.3], riskUsd: 5, signals: [] };

  it("quotes at the reference price moved against the trade, and fills at the quote", async () => {
    const ex = new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, now, { slippageBps: 10 });
    const q = await ex.quote(entryP, 50);
    expect(q).toMatchObject({ originAsset: cfg.assets.USDC.assetId, destinationAsset: cfg.assets.NEAR.assetId, amountIn: 100_000_000n, receivedAt: now() });
    const r = await ex.execute(entryP, q);
    expect(r.status).toBe("SIMULATED");
    expect(r.fill!.price).toBeCloseTo(2.002, 9);
    const b = await ex.balances();
    expect(b.USDC).toBe(900_000_000n);
    expect(Number(b.NEAR) / 1e24).toBeCloseTo(100 / 2.002, 6);
  });

  it("a final exit sells the whole balance when float rounding asks a few base units more", async () => {
    const ex = new ReplayExecutor(cfg, { USDC: 0, BTC: 0, NEAR: 10 }, now);
    const exit: ExitProposal = { kind: "EXIT", asset: "NEAR", barTime: 0, reason: "TAKE_PROFIT_2", referencePrice: 2, quantity: 10.0000000004, fraction: 1 };
    const q = await ex.quote(exit, 150);
    expect(q.amountIn).toBe(10n * 10n ** 24n);
    await ex.execute(exit, q);
    expect((await ex.balances()).NEAR).toBe(0n);
  });

  it("an execution beyond the simulated balance fails instead of going negative", async () => {
    const ex = new ReplayExecutor(cfg, { USDC: 50, BTC: 0, NEAR: 0 }, now);
    expect(await ex.execute(entryP, await ex.quote(entryP, 50))).toMatchObject({ status: "FAILED" });
  });
});

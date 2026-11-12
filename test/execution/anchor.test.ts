import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Runner } from "../../src/cli/run.ts";
import { candleSourceFor } from "../../src/cli/verify.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash, type RiskConfig } from "../../src/config/schema.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import type { FeedSnapshot } from "../../src/data/feed.ts";
import { readRecord } from "../../src/decision/record.ts";
import { verifyRecord } from "../../src/decision/verify.ts";
import { AnchorError, ContractAnchor, MemoryAnchor, type NearLike } from "../../src/execution/anchor.ts";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { replayLlm, ReplayExecutor } from "../../src/execution/replay.ts";

const H = 3_600_000;
const root = new URL("../../", import.meta.url).pathname;
const meta = { agentVersion: "test", configHash: configHash(cfg) };
const configs = new Map<string, RiskConfig>([[meta.configHash, cfg]]);

async function runSignalBar(anchor: MemoryAnchor) {
  const set = await loadFixtureSet(join(root, "fixtures", "demo-entry"));
  const dir = await mkdtemp(join(tmpdir(), "anchor-"));
  const now = set.signalBarTime + H + 15_000;
  let executed = 0;
  const inner = new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, () => now);
  const lines: string[] = [];
  const feed = {
    async snapshot(t: number): Promise<FeedSnapshot> {
      const closed = (iv: "1h" | "4h", s: string) => set.series[s]![iv]!.candles.filter((c) => c.openTime + (iv === "1h" ? H : 4 * H) <= t);
      const near = closed("1h", "NEARUSDT");
      return { at: t, market: { candles1h: { NEAR: near, BTC: closed("1h", "BTCUSDT") }, btc4h: closed("4h", "BTCUSDT") }, barTime: near.at(-1)?.openTime, problems: [] };
    },
  };
  const runner = await Runner.open({
    cfg, meta, mode: "paper", feed, llm: () => replayLlm(cfg), authenticated: true, keys: new MemoryKeys(), prices: async () => ({}),
    executor: { mode: "replay", quote: (p, b) => inner.quote(p, b), balances: () => inner.balances(), execute: (p, q) => { executed++; return inner.execute(p, q); } },
    heartbeat: { write: async () => {} }, recordsDir: join(dir, "records"), statePath: join(dir, "state.json"), clock: () => now, write: (l) => lines.push(l), anchor,
  });
  await runner.tick();
  const hashes = (await readdir(join(dir, "records"))).map((f) => f.slice(0, 64));
  return { set, dir, runner, executed: () => executed, lines, hashes };
}

describe("anchoring", () => {
  it("every decision hash is on chain before its trade; verify finds it with the same kind", async () => {
    const anchor = new MemoryAnchor(() => 42);
    const r = await runSignalBar(anchor);
    expect(r.executed()).toBe(1);
    expect(anchor.entries.size).toBe(r.hashes.length);
    for (const h of r.hashes) {
      const rec = await readRecord(join(r.dir, "records"), h);
      const v = await verifyRecord(rec, { configs, candles: candleSourceFor(rec, [r.set]).candles, expectedHash: h, anchored: (x) => anchor.lookup(x) });
      expect(v.problems).toEqual([]);
      expect(v.notes.join()).toMatch(new RegExp(`anchor: on chain as decision #\\d+, ${rec.outcome.action}`));
    }
  });

  it("anchoring fails → the trade is not executed, the portfolio is unchanged, an alert is raised", async () => {
    const anchor = new MemoryAnchor();
    anchor.failWith = "RPC unreachable";
    const r = await runSignalBar(anchor);
    expect(r.executed()).toBe(0);
    expect(r.runner.state.portfolio.positions).toEqual([]);
    expect(r.runner.state.lastBarTime).toBeUndefined(); // the bar will be retried
    expect(r.lines.join("\n")).toMatch(/ALERT tick stopped: anchor .*RPC unreachable/);
  });

  it("verify: a hash missing on chain, or recorded with another kind, is a problem", async () => {
    const anchor = new MemoryAnchor();
    const r = await runSignalBar(anchor);
    const h = r.hashes[0]!;
    const rec = await readRecord(join(r.dir, "records"), h);
    const ctx = { configs, candles: candleSourceFor(rec, [r.set]).candles, expectedHash: h };
    expect((await verifyRecord(rec, { ...ctx, anchored: async () => null })).problems.join()).toMatch(/not recorded in the guardrail contract/);
    const other = rec.outcome.action === "TRADE" ? "HOLD" : "TRADE";
    expect((await verifyRecord(rec, { ...ctx, anchored: async () => ({ kind: other, recorded_at_ms: 1, seq: 1 }) })).problems.join()).toMatch(/recorded on chain as/);
    expect((await verifyRecord(rec, { ...ctx, anchored: async () => { throw new Error("timeout"); } })).problems.join()).toMatch(/lookup failed/);
  });

  it("ContractAnchor calls record_decision as the agent and wraps failures", async () => {
    const calls: unknown[] = [];
    const near: NearLike = {
      call: async <T>(c: string, m: string, a: object, o: { signerId: string }) => { calls.push([c, m, a, o.signerId]); if ((a as { kind: string }).kind === "TRADE") throw new Error("Smart contract panicked: paused"); return 7 as T; },
      view: async <T>() => ({ hash: "h", kind: "HOLD", recorded_at_ms: 1, seq: 7 }) as T,
    };
    const a = new ContractAnchor({ near, contractId: "guardrail.near", agentId: "agent.near" });
    expect(await a.record("ab".repeat(32), "HOLD")).toBe(7);
    expect(calls[0]).toEqual(["guardrail.near", "record_decision", { hash: "ab".repeat(32), kind: "HOLD" }, "agent.near"]);
    await expect(a.record("cd".repeat(32), "TRADE")).rejects.toBeInstanceOf(AnchorError);
    expect(await a.lookup("h")).toMatchObject({ seq: 7 });
  });

  it("an exit is anchored as EXIT; an old contract without EXIT gets it as TRADE, with a warning, once", async () => {
    const sent: string[] = [];
    const warnings: string[] = [];
    const near: NearLike = {
      call: async <T>(_c: string, m: string, a: object) => {
        if (m === "pause") return undefined as T;
        const k = (a as { kind: string }).kind;
        sent.push(k);
        if (k === "EXIT") throw new Error("Smart contract panicked: Failed to deserialize input from JSON.: Error(\"unknown variant `EXIT`, expected one of `TRADE`, `REJECT`, `HOLD`\")");
        return sent.length as T;
      },
      view: async <T>() => null as T,
    };
    const a = new ContractAnchor({ near, contractId: "old.near", agentId: "agent.near", warn: (m) => warnings.push(m) });
    await a.record("ab".repeat(32), "EXIT");
    await a.record("cd".repeat(32), "EXIT");
    expect(sent).toEqual(["EXIT", "TRADE", "TRADE"]); // tried once, then straight to TRADE
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/predates EXIT/);
    await a.pause();
  });

  it("the recorder anchors exit trades as EXIT and entries as TRADE", async () => {
    const { anchorKind } = await import("../../src/decision/record.ts");
    const exit = { kind: "EXIT", asset: "NEAR", barTime: 0, reason: "STOP", referencePrice: 1, quantity: 1, fraction: 1 } as const;
    expect(anchorKind({ action: "TRADE", proposal: exit } as never)).toBe("EXIT");
    expect(anchorKind({ action: "TRADE", proposal: { kind: "ENTRY" } } as never)).toBe("TRADE");
    expect(anchorKind({ action: "HOLD", reason: "NO_SIGNAL" } as never)).toBe("HOLD");
  });
});

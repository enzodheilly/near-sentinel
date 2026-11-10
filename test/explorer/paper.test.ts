import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Runner } from "../../src/cli/run.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash, type RiskConfig } from "../../src/config/schema.ts";
import { CandleArchive, type FeedSnapshot } from "../../src/data/feed.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { MemoryAnchor } from "../../src/execution/anchor.ts";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { replayLlm, ReplayExecutor } from "../../src/execution/replay.ts";
import { paperScenario } from "../../src/explorer/build.ts";

const H = 3_600_000;
const root = new URL("../../", import.meta.url).pathname;

describe("explorer: the paper run", () => {
  it("records from the live loop, verified against the candle archive, with their on-chain anchors", async () => {
    const set = await loadFixtureSet(join(root, "fixtures", "demo-refusal"));
    const dir = await mkdtemp(join(tmpdir(), "explorer-paper-"));
    const archive = new CandleArchive(join(dir, "data", "candles"));
    let now = set.signalBarTime - 2 * H + 15_000;
    const feed = {
      async snapshot(t: number): Promise<FeedSnapshot> {
        const closed = (iv: "1h" | "4h", s: string) => set.series[s]![iv]!.candles.filter((c) => c.openTime + (iv === "1h" ? H : 4 * H) <= t);
        const m = { NEAR: closed("1h", "NEARUSDT"), BTC: closed("1h", "BTCUSDT"), btc4h: closed("4h", "BTCUSDT") };
        await archive.merge("NEARUSDT", "1h", m.NEAR);
        await archive.merge("BTCUSDT", "1h", m.BTC);
        await archive.merge("BTCUSDT", "4h", m.btc4h);
        return { at: t, market: { candles1h: { NEAR: m.NEAR, BTC: m.BTC }, btc4h: m.btc4h }, barTime: m.NEAR.at(-1)?.openTime, problems: [] };
      },
    };
    const anchor = new MemoryAnchor(() => now);
    const meta = { agentVersion: "test", configHash: configHash(cfg) };
    const exec = new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, () => now);
    const runner = await Runner.open({
      cfg, meta, mode: "paper", feed, executor: exec, llm: () => replayLlm(cfg), authenticated: true, keys: new MemoryKeys(), prices: async () => ({}),
      heartbeat: { write: async () => {} }, recordsDir: join(dir, "records"), statePath: join(dir, "state.json"), clock: () => now, anchor,
    });
    for (let i = 0; i < 4; i++, now += H) await runner.tick(); // bars signal−3 … signal: the refusal is among them

    const configs = new Map<string, RiskConfig>([[meta.configHash, cfg]]);
    const s = await paperScenario({ records: join(dir, "records"), archiveDir: join(dir, "data", "candles"), configs, known: new Set(),
      anchor: { contract: "guardrail.test", network: "testnet", lookup: (h) => anchor.lookup(h) } });
    expect(s).toBeDefined();
    expect(s!.kind).toBe("PAPER");
    expect(s!.decisions).toHaveLength((await readdir(join(dir, "records"))).length);
    expect(s!.decisions.every((d) => d.verified)).toBe(true);
    expect(s!.decisions.every((d) => d.anchor && d.anchor.contract === "guardrail.test")).toBe(true);
    expect(s!.decisions.some((d) => d.record.outcome.action === "REJECT")).toBe(true);
    expect(s!.bars).toBe(4);
    expect(s!.candles.at(-1)![0]).toBe(s!.decisions.at(-1)!.record.barTime);
  });

  it("no archive or no records: no paper tab", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-none-"));
    expect(await paperScenario({ records: join(dir, "records"), archiveDir: join(dir, "nope"), configs: new Map(), known: new Set() })).toBeUndefined();
  });
});

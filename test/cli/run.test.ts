import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runner, type RunnerOptions } from "../../src/cli/run.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash } from "../../src/config/schema.ts";
import { loadFixtureSet, type FixtureSet } from "../../src/data/fixtures.ts";
import type { FeedSnapshot } from "../../src/data/feed.ts";
import { MemoryAnchor, type AnchorKind } from "../../src/execution/anchor.ts";
import { MemoryKeys } from "../../src/execution/idempotency.ts";
import { replayLlm, ReplayExecutor } from "../../src/execution/replay.ts";
import type { Heartbeat } from "../../src/execution/watcher.ts";
import type { ExecutionReport, Executor } from "../../src/types.ts";

const H = 3_600_000;
const root = new URL("../../", import.meta.url).pathname;

/** A feed that serves the demo-entry fixture as if it were live: candles closed by `now`. */
const fixtureFeed = (set: FixtureSet, calls: number[] = []) => ({
  async snapshot(now: number): Promise<FeedSnapshot> {
    calls.push(now);
    const closed = (iv: "1h" | "4h", s: string) => set.series[s]![iv]!.candles.filter((c) => c.openTime + (iv === "1h" ? H : 4 * H) <= now);
    const near = closed("1h", "NEARUSDT");
    return { at: now, market: { candles1h: { NEAR: near, BTC: closed("1h", "BTCUSDT") }, btc4h: closed("4h", "BTCUSDT") }, barTime: near.at(-1)?.openTime, problems: [] };
  },
});

async function setup(o: { executor?: (clock: () => number) => Executor; dir?: string } = {}) {
  const set = await loadFixtureSet(join(root, "fixtures", "demo-entry"));
  const dir = o.dir ?? (await mkdtemp(join(tmpdir(), "run-")));
  const lines: string[] = [];
  const beats: Heartbeat[] = [];
  const clock = () => Date.now();
  const opts: RunnerOptions = {
    cfg, meta: { agentVersion: "test", configHash: configHash(cfg) }, mode: "paper", feed: fixtureFeed(set),
    executor: o.executor?.(clock) ?? new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, clock),
    llm: () => replayLlm(cfg), authenticated: true, keys: new MemoryKeys(), prices: async () => ({}),
    heartbeat: { write: async (h) => { beats.push(h); } }, recordsDir: join(dir, "records"), statePath: join(dir, "state.json"),
    clock, tickDelayMs: 15_000, write: (l) => lines.push(l),
  };
  return { set, dir, lines, beats, opts };
}

afterEach(() => vi.useRealTimers());

describe("Runner", () => {
  it("ticks the closed bar 15 s after each candle close, once per bar; the signal bar enters", async () => {
    const { set, lines, beats, opts } = await setup();
    vi.useFakeTimers({ now: set.signalBarTime - H + 15_000, toFake: ["setTimeout", "clearTimeout", "Date"] }); // just after bar signal−2 closed
    const runner = await Runner.open(opts);
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await runner.tick(); // drains the queue; same bar → nothing new
    expect(runner.state.lastBarTime).toBe(set.signalBarTime - 2 * H);

    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(H);
      await runner.tick();
      expect(runner.state.lastBarTime).toBe(set.signalBarTime - 2 * H + i * H);
    }
    await runner.stop();

    const bars = lines.filter((l) => / equity \$/.test(l));
    expect(bars).toHaveLength(4); // one summary per bar, no duplicate
    expect(lines.some((l) => / NEAR ENTRY \$/.test(l))).toBe(true);
    expect(runner.state.portfolio.positions.map((p) => p.asset)).toEqual(["NEAR"]);
    expect(beats.length).toBeGreaterThanOrEqual(3 * 60); // the watcher polled every minute in between
    expect(beats.every((b) => b.status === "ok")).toBe(true);

    // portfolio history for the dashboard: one line per bar, the entry among them, valued at the bar's closes
    const { dir } = await Promise.resolve({ dir: opts.statePath.replace(/\/state\.json$/, "") });
    const hist = (await readFile(join(dir, "history.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(hist.length).toBeGreaterThanOrEqual(4);
    expect(hist.every((h) => h.prices.NEAR > 0 && h.prices.BTC > 0 && h.equity > 0)).toBe(true);
    expect(hist.flatMap((h) => h.trades ?? []).map((x) => [x.asset, x.kind])).toContainEqual(["NEAR", "ENTRY"]);
  });

  it("a restart resumes the saved state and never re-ticks a bar", async () => {
    const first = await setup();
    vi.useFakeTimers({ now: first.set.signalBarTime + H + 15_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = await Runner.open(first.opts);
    await a.tick();
    const records = (await readdir(first.opts.recordsDir)).length;
    const saved = JSON.parse(await readFile(first.opts.statePath, "utf8"));
    expect(saved).toMatchObject({ source: "paper", lastBarTime: first.set.signalBarTime });

    const again = await setup({ dir: first.dir });
    const b = await Runner.open(again.opts);
    expect(b.state.lastBarTime).toBe(first.set.signalBarTime);
    await b.tick();
    expect((await readdir(first.opts.recordsDir)).length).toBe(records); // nothing re-decided
    expect(b.state.portfolio).toEqual(a.state.portfolio);
  });

  it("stop (SIGINT) waits for the trade in progress: record, fill and state all land", async () => {
    let release!: () => void;
    let executing = false;
    const { set, opts, dir } = await setup({
      executor: (clock) => {
        const inner = new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, clock);
        return {
          mode: "replay", quote: (p, b) => inner.quote(p, b), balances: () => inner.balances(),
          execute: (p, q) => { executing = true; return new Promise<ExecutionReport>((r) => { release = () => void inner.execute(p, q).then(r); }); },
        };
      },
    });
    vi.useFakeTimers({ now: set.signalBarTime + H + 15_000, toFake: ["Date"] });
    const runner = await Runner.open(opts);
    const tick = runner.tick();
    await vi.waitFor(() => expect(executing).toBe(true), { timeout: 5000 });
    // the entry record is already on disk before the fill (record-then-execute)
    expect((await readdir(join(dir, "records"))).length).toBeGreaterThan(0);
    let stopped = false;
    const stopping = runner.stop().then(() => (stopped = true));
    await new Promise((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await tick;
    const saved = JSON.parse(await readFile(opts.statePath, "utf8"));
    expect(saved.portfolio.positions.map((p: { asset: string }) => p.asset)).toEqual(["NEAR"]);
  });

  it("market data down: the tick is skipped and said, nothing is decided", async () => {
    const { opts, lines } = await setup();
    const runner = await Runner.open({ ...opts, feed: { snapshot: async () => { throw new Error("HTTP 503"); } } });
    await runner.tick();
    expect(lines.join()).toMatch(/market data unavailable \(HTTP 503\); retrying every minute/);
    expect(runner.state.lastBarTime).toBeUndefined();
  });

  it("data down at the close: retried every minute, the bar is ticked as soon as data is back", async () => {
    const { set, opts, lines } = await setup();
    vi.useFakeTimers({ now: set.signalBarTime - H + 15_000, toFake: ["setTimeout", "clearTimeout", "Date"] });
    let down = 3;
    const real = opts.feed;
    const runner = await Runner.open({ ...opts, feed: { snapshot: async (t) => { if (down-- > 0) throw new Error("no answer within 20000 ms"); return real.snapshot(t); } } });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.state.lastBarTime).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await runner.tick();
    expect(runner.state.lastBarTime).toBe(set.signalBarTime - 2 * H); // the same bar, 3 minutes late
    expect(lines.filter((l) => /market data unavailable/.test(l))).toHaveLength(1); // said once, not every minute
    expect(lines.join("\n")).toMatch(/market data back after 3 failed attempt/);
    await runner.stop();
  });

  it("nextTickAt: the next close plus the delay", async () => {
    const { opts } = await setup();
    const r = await Runner.open(opts);
    const t0 = Date.parse("2026-11-07T20:00:00Z");
    expect(r.nextTickAt(t0 + 10_000)).toBe(t0 + 15_000);
    expect(r.nextTickAt(t0 + 15_000)).toBe(t0 + H + 15_000);
    expect(r.nextTickAt(t0 + 30 * 60_000)).toBe(t0 + H + 15_000);
  });
});

describe("Runner: a step that stops half-way", () => {
  it("keeps the trades it executed before anchoring failed (no forgotten sale)", async () => {
    const { set, lines, opts } = await setup();
    const ex = opts.executor as ReplayExecutor;
    const anchor = new MemoryAnchor();
    let armed = false, sawTrade = false;
    const failing = {
      record: async (h: string, k: AnchorKind) => {
        if (armed && k === "EXIT") sawTrade = true;
        if (armed && sawTrade && k !== "EXIT") throw new Error("rpc timeout");
        return anchor.record(h, k);
      },
      lookup: (h: string) => anchor.lookup(h),
    };
    vi.useFakeTimers({ now: set.signalBarTime + H + 15_000, toFake: ["Date"] });
    const runner = await Runner.open({ ...opts, anchor: failing });
    await runner.tick();
    expect(runner.state.portfolio.positions.map((p) => p.asset)).toEqual(["NEAR"]);
    armed = true; // from now on, the first record after an exit fails to anchor
    for (let i = 0; i < 40 && !sawTrade; i++) {
      vi.setSystemTime(Date.now() + H);
      await runner.tick();
    }
    expect(sawTrade).toBe(true);
    const held = (await ex.balances()).NEAR;
    const pos = runner.state.portfolio.positions.find((p) => p.asset === "NEAR");
    expect(Number(held) / 10 ** cfg.assets.NEAR.decimals).toBeCloseTo(pos?.quantity ?? 0, 6); // the portfolio matches what is held
    expect(lines.some((l) => /ALERT tick stopped: .*trade\(s\) before it were executed and kept/.test(l))).toBe(true);
  });

  it("pauses the guardrail contract when the kill switch trips", async () => {
    const { set, lines, opts, dir } = await setup();
    const anchor = new MemoryAnchor();
    vi.useFakeTimers({ now: set.signalBarTime + H + 15_000, toFake: ["Date"] });
    const first = await Runner.open({ ...opts, anchor });
    await first.tick();
    // the peak was far higher: equity is now more than 10% below it
    const st = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    st.portfolio.peakEquityUsd = 5000;
    await writeFile(join(dir, "state.json"), JSON.stringify(st));
    const runner = await Runner.open({ ...opts, anchor });
    vi.setSystemTime(Date.now() + H);
    await runner.tick();
    expect(runner.state.portfolio.killSwitch).toBe(true);
    expect(anchor.paused).toBe(true);
    expect(lines.some((l) => /guardrail contract paused/.test(l))).toBe(true);
  });
});

describe("Runner: a swap whose outcome is unknown", () => {
  it("halts trading (ticks and watcher), saves it, and stays halted after a restart", async () => {
    const { set, lines, opts, dir } = await setup({
      executor: (clock) => {
        const inner = new ReplayExecutor(cfg, { USDC: 1000, BTC: 0, NEAR: 0 }, clock);
        return { mode: inner.mode, quote: (p, b) => inner.quote(p, b), balances: () => inner.balances(),
          execute: async (_p, q): Promise<ExecutionReport> => ({ mode: "replay", status: "UNKNOWN", quote: q, txRefs: ["IH1"], intentHash: "IH1", error: "no final status within 180 s" }) };
      },
    });
    vi.useFakeTimers({ now: set.signalBarTime + H + 15_000, toFake: ["Date"] });
    const runner = await Runner.open(opts);
    await runner.tick();
    expect(runner.state.halted).toMatch(/ENTRY NEAR: outcome unknown .*intent IH1/);
    expect(lines.some((l) => /ALERT trading halted/.test(l))).toBe(true);
    const before = (await readdir(join(dir, "records"))).length;
    vi.setSystemTime(Date.now() + H);
    await runner.tick();
    expect((await readdir(join(dir, "records"))).length).toBe(before); // no more decisions while halted
    const again = await Runner.open(opts);
    expect(again.state.halted).toBeDefined();
    await again.resume();
    expect((await Runner.open(opts)).state.halted).toBeUndefined();
  });
});

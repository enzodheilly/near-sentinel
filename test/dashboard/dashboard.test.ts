import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProof } from "../../src/dashboard/proof.ts";
import { startDashboard } from "../../src/dashboard/server.ts";
import { buildDashboardState, type ChainReader } from "../../src/dashboard/state.ts";

const NOW = Date.parse("2026-11-10T21:00:00Z");
const H = 3_600_000;
const hold = (barTime: number, now: number, asset = "NEAR") => ({ version: 1, barTime, asset, inputs: { now, candles: [], portfolio: {}, externals: { authenticated: true, calls: [] } }, outcome: { action: "HOLD", reason: "NO_SIGNAL" }, signals: [], checks: [] });
const reject = (barTime: number, now: number) => ({ ...hold(barTime, now), outcome: { action: "REJECT", reason: "VETO_BTC_REGIME" },
  signals: [{ kind: "BTC_REGIME", asset: "NEAR", barTime, direction: "veto", strength: 1, evidence: { btcClose4h: 74_420, ema4h: 76_437 } }],
  checks: [{ name: "kill_switch", ok: true }, { name: "confirmations", ok: false, value: 1, limit: 2, detail: "RSI_MOMENTUM" }],
  llm: { model: "m", verdict: "reduce", sizeMultiplier: 0.5, rationale: "thin volume", attestation: { status: "verified", problems: [] } } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dash-"));
  await mkdir(join(root, "state", "paper"), { recursive: true });
  await mkdir(join(root, "records"), { recursive: true });
  await writeFile(join(root, "state", "paper", "heartbeat.json"), JSON.stringify({ at: NOW - 30_000, pid: 1, mode: "paper", status: "ok", prices: { NEAR: 3.59, BTC: 73_900 } }));
  await writeFile(join(root, "state", "paper", "portfolio.json"), JSON.stringify({ savedAt: NOW - H, source: "paper", lastBarTime: NOW - 2 * H,
    portfolio: { at: NOW - H, balances: { USDC: 1000, BTC: 0, NEAR: 0 }, positions: [], equityUsd: 1000, peakEquityUsd: 1000, dayStartEquityUsd: 1000, entriesToday: 0, cooldownUntil: {}, killSwitch: false } }));
  const recs = [["a".repeat(64), hold(NOW - 2 * H, NOW - H + 20_000)], ["b".repeat(64), reject(NOW - 3 * H, NOW - 2 * H + 20_000)], ["c".repeat(64), hold(Date.parse("2026-09-21T15:00Z"), Date.parse("2026-09-21T16:00Z"))]] as const;
  for (const [h, r] of recs) await writeFile(join(root, "records", `${h}.json`), JSON.stringify(r));
  return root;
}

const env = { NEAR_NETWORK: "testnet", NEAR_GUARDRAIL_CONTRACT: "guardrail.x.testnet", NEAR_AGENT_ACCOUNT: "agent.x.testnet", AGENT_ACCOUNT: "x-agent.near", LIVE_NEAR_GUARDRAIL_CONTRACT: "x-guardrail.near", LIVE_NEAR_NETWORK: "mainnet" };
const chain = (calls: string[] = []): ChainReader => ({
  view: async <T,>(net: string, c: string, m: string, a: object) => {
    calls.push(`${net}:${c}:${m}`);
    if (m === "get_policy") return { paused: net === "mainnet", max_trades_per_day: 3, owner: "o", agent: "a" } as T;
    if (m === "get_day_usage") return { trades: 1 } as T;
    if (m === "get_decision_count") return 2 as T;
    if (m === "mt_batch_balance_of") return ["9989653", "0", "0"] as T;
    if (m === "get_decision") return (net === "testnet" && (a as { hash: string }).hash.startsWith("a") ? { seq: 5, recorded_at_ms: NOW - H } : undefined) as T;
    return undefined;
  },
});

describe("dashboard state", () => {
  it("modes, guardrails, live wallet, prices and the last 7 days of decisions with their anchors", async () => {
    const root = await fixture();
    const calls: string[] = [];
    const cache = new Map();
    const s = await buildDashboardState({ root, env, chain: chain(calls), now: NOW, anchorCache: cache });
    expect(s.modes.find((m) => m.mode === "paper")).toMatchObject({ running: true, alert: null, lastBarTime: NOW - 2 * H, portfolio: { equityUsd: 1000 } });
    expect(s.modes.find((m) => m.mode === "live")).toMatchObject({ running: false, configured: true });
    expect(s.guardrails.map((g) => [g.network, g.policy?.paused, g.dayUsage?.trades])).toEqual([["testnet", false, 1], ["mainnet", true, 1]]);
    expect(s.liveWallet).toMatchObject({ account: "x-agent.near", usdc: 9.989653 });
    expect(s.prices).toMatchObject({ NEAR: 3.59, BTC: 73_900 });
    expect(s.decisions.map((d) => d.hash[0])).toEqual(["a", "b"]); // newest first; the September replay is left out
    expect(s.decisions[0]!.anchor).toEqual({ network: "testnet", contract: "guardrail.x.testnet", seq: 5, at: NOW - H });
    expect(s.decisions[1]!.anchor).toBeNull();
    // what the detail panel shows: signals, checks and the LLM review, straight from the record
    expect(s.decisions[1]!.signals).toEqual([{ kind: "BTC_REGIME", direction: "veto", strength: 1, evidence: { btcClose4h: 74_420, ema4h: 76_437 } }]);
    expect(s.decisions[1]!.checks[1]).toEqual({ name: "confirmations", ok: false, value: 1, limit: 2, detail: "RSI_MOMENTUM" });
    expect(s.decisions[1]!.review).toEqual({ model: "m", verdict: "reduce", sizeMultiplier: 0.5, rationale: "thin volume", attestation: "verified" });
    expect(s.decisions[0]!.review).toBeUndefined();
    // the funnel counts where every decision of the week stopped
    expect(s.funnel.total).toBe(s.decisions.length);
    expect(s.funnel.stopped.breakout + s.funnel.stopped.confirm + s.funnel.stopped.risk + s.funnel.stopped.llm + s.funnel.stopped.policy + s.funnel.trades).toBe(s.funnel.total);
    expect(s.funnel.stopped.confirm).toBe(1); // the BTC-trend refusal
    expect(s.funnel.reasons).toEqual({ VETO_BTC_REGIME: 1 });
    expect(s.counts).toEqual({ total: 2, trades: 0, rejects: 1, holds: 1 });
    // anchors are cached: a second build does not ask the chain again for them
    const before = calls.filter((c) => c.endsWith("get_decision")).length;
    await buildDashboardState({ root, env, chain: chain(calls), now: NOW, anchorCache: cache });
    expect(calls.filter((c) => c.endsWith("get_decision")).length).toBe(before);
  });

  it("stopped agent: alert after 5 minutes without heartbeat", async () => {
    const root = await fixture();
    const s = await buildDashboardState({ root, env: {}, now: NOW + 10 * 60_000 });
    expect(s.modes[0]).toMatchObject({ running: false });
    expect(s.modes[0]!.alert).toMatch(/no heartbeat for 11 min/);
    expect(s.guardrails).toEqual([]);
  });
});

describe("dashboard server", () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it("serves the page and the state on 127.0.0.1, read-only", async () => {
    const root = await fixture();
    const { server, url } = await startDashboard({ root, env, chain: chain(), port: 0, clock: () => NOW });
    close = () => server.close();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(page.headers.get("content-security-policy")).toMatch(/connect-src 'self' wss:\/\/api\.hyperliquid\.xyz\/ws;/); // the only outside address: live prices
    expect(await page.text()).toMatch(/NEAR Sentinel/);
    const st = (await (await fetch(`${url}/api/state`)).json()) as { counts: { total: number } };
    expect(st.counts.total).toBe(2);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(`${url}/api/state`, { method })).status).toBe(405);
    expect((await fetch(`${url}/../state/paper/portfolio.json`)).status).toBe(404);
    // the fixed static map: 3D engine, fonts and the NEAR logo; nothing else from disk
    for (const path of ["/vendor/three.module.js", "/vendor/three.core.js", "/vendor/RoomEnvironment.js", "/fonts/chakra-600.woff2", "/assets/near-logo.png"]) expect((await fetch(`${url}${path}`)).status).toBe(200);
    for (const path of ["/vendor/../../package.json", "/fonts/x.woff2", "/constructor", "/__proto__"]) expect((await fetch(`${url}${path}`)).status).toBe(404);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'unsafe-inline'; .*font-src 'self'/);
    // DNS rebinding: only a 127.0.0.1 / localhost Host is served
    const withHost = (host: string) => new Promise<number>((resolve, reject) => {
      request(`${url}/api/state`, { headers: { host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject).end();
    });
    expect(await withHost("evil.example:4747")).toBe(421);
    expect(await withHost("localhost:4747")).toBe(200);
  });
});

describe("funnel stages", () => {
  it("maps each outcome to the step that stopped it", async () => {
    const { funnelStage } = await import("../../src/dashboard/state.ts");
    expect(funnelStage("HOLD", "NO_SIGNAL")).toBe("breakout");
    expect(funnelStage("REJECT", "VETO_BTC_REGIME")).toBe("confirm");
    expect(funnelStage("REJECT", "COST_TOO_HIGH")).toBe("risk");
    expect(funnelStage("REJECT", "LLM_VETO")).toBe("llm");
    expect(funnelStage("REJECT", "POLICY_DENIED")).toBe("policy");
    expect(funnelStage("TRADE")).toBe("trade");
  });
});

describe("live proof", () => {
  it("reads the recorded mainnet round trip from the evidence files", async () => {
    const { readSwaps } = await import("../../src/dashboard/state.ts");
    const sw = await readSwaps(new URL("../live/recorded/", import.meta.url).pathname);
    expect(sw.map((x) => x.side)).toEqual(["buy", "sell"]); // dry quotes and the LLM recording are not swaps
    expect(sw[0]).toMatchObject({ status: "SUCCESS", assetIn: "USDC", amountIn: 5, assetOut: "NEAR", tx: "BZw8CY6j9sZU2ymZzT1tzw3NUofuV1KiLm5j8k3xNNkj" });
    expect(sw[1]).toMatchObject({ status: "SUCCESS", assetIn: "NEAR", assetOut: "USDC", amountOut: 4.989653, tx: "DCws6QWLcUUmuwEqiaVrehkU1VEC7DLEjeZRhQXxbHtz" });
    expect(sw[0]!.settledMs).toBeGreaterThan(0);
    expect(await readSwaps("/nonexistent")).toEqual([]);
  });
});

describe("chart candles", () => {
  it("serves the picked interval, refuses unknown ones, and reports a data outage as 502", async () => {
    const root = await mkdtemp(join(tmpdir(), "dash-c-"));
    const asked: string[] = [];
    let fail = false;
    const { server, url } = await startDashboard({
      root, env: {}, port: 0, clock: () => NOW,
      candles: async (iv) => { asked.push(iv); if (fail) throw new Error("down"); return [[NOW - H, 3.5, 3.6, 3.4, 3.55]]; },
    });
    try {
      const r = await fetch(`${url}/api/candles?tf=15m`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ interval: "15m", candles: [[NOW - H, 3.5, 3.6, 3.4, 3.55]] });
      await fetch(`${url}/api/candles?tf=15m`); // cached 30 s
      expect(asked).toEqual(["15m"]);
      expect((await fetch(`${url}/api/candles?tf=2m`)).status).toBe(400);
      fail = true;
      expect((await fetch(`${url}/api/candles?tf=1w`)).status).toBe(502);
    } finally {
      server.close();
    }
  });
});

describe("a demo run does not hide the agent's decisions", () => {
  it("the log is the newest by decision time, even after hundreds of replayed records were written", async () => {
    const root = await fixture();
    // pnpm demo afterwards: 300 records decided in July, written now (newer files than the agent's)
    const jul = Date.parse("2026-07-20T10:00:00Z");
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 300; i++) await writeFile(join(root, "records", `${(0xd000 + i).toString(16).padStart(64, "d")}.json`), JSON.stringify(hold(jul + i * H, jul + i * H + H)));
    const s = await buildDashboardState({ root, env: {}, now: NOW, limit: 10 });
    expect(s.decisions.map((d) => d.hash[0])).toEqual(["a", "b"]);
    expect(s.funnel.total).toBe(2);
  });
});

describe("proof tab", () => {
  it("serves a record's exact bytes for the browser to hash, and nothing outside records/", async () => {
    const root = await fixture();
    const { server, url } = await startDashboard({ root, env, port: 0, clock: () => NOW });
    try {
      const name = (await readdir(join(root, "records"))).find((f) => f.endsWith(".json"))!;
      const r = await fetch(`${url}/api/record/${name.slice(0, 64)}`);
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).equals(await readFile(join(root, "records", name)))).toBe(true);
      expect((await fetch(`${url}/api/record/${"0".repeat(64)}`)).status).toBe(404);
      for (const bad of ["..%2F..%2Fpackage.json", "abc", `${"a".repeat(64)}.json`]) expect((await fetch(`${url}/api/record/${bad}`)).status).toBe(400);
      expect(await (await fetch(url)).text()).toContain('id="view-proof"');
    } finally {
      server.close();
    }
  });

  it("re-checks the recorded LLM exchange from its bytes", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    const p = await buildProof(root);
    expect(p.llm?.model).toBe("Qwen/Qwen3.6-35B-A3B-FP8");
    expect(p.llm?.checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    const empty = await mkdtemp(join(tmpdir(), "proof-"));
    expect(await buildProof(empty)).toEqual({});
  });
});

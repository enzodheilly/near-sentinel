import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboard } from "../../src/dashboard/server.ts";
import { buildDashboardState, type ChainReader } from "../../src/dashboard/state.ts";

const NOW = Date.parse("2026-11-10T21:00:00Z");
const H = 3_600_000;
const hold = (barTime: number, now: number, asset = "NEAR") => ({ version: 1, barTime, asset, inputs: { now, candles: [], portfolio: {}, externals: { authenticated: true, calls: [] } }, outcome: { action: "HOLD", reason: "NO_SIGNAL" }, signals: [], checks: [] });
const reject = (barTime: number, now: number) => ({ ...hold(barTime, now), outcome: { action: "REJECT", reason: "VETO_BTC_REGIME" } });

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
    expect(await page.text()).toMatch(/NEAR Sentinel/);
    const st = (await (await fetch(`${url}/api/state`)).json()) as { counts: { total: number } };
    expect(st.counts.total).toBe(2);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(`${url}/api/state`, { method })).status).toBe(405);
    expect((await fetch(`${url}/../state/paper/portfolio.json`)).status).toBe(404);
    // the fixed static map: 3D engine, fonts and the NEAR logo; nothing else from disk
    for (const path of ["/vendor/three.module.js", "/vendor/three.core.js", "/vendor/RoomEnvironment.js", "/fonts/chakra-600.woff2", "/assets/near-logo.png"]) expect((await fetch(`${url}${path}`)).status).toBe(200);
    for (const path of ["/vendor/../../package.json", "/fonts/x.woff2", "/constructor", "/__proto__"]) expect((await fetch(`${url}${path}`)).status).toBe(404);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' 'unsafe-inline'; .*font-src 'self'/);
  });
});

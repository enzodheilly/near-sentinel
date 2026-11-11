import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { buildPortfolio } from "../../src/dashboard/portfolio.ts";

const H = 3_600_000;
const snap = (usdc: number, near: number, equity: number) => ({ at: 0, balances: { USDC: usdc, NEAR: near, BTC: 0 }, positions: [], equityUsd: equity, peakEquityUsd: equity, dayStartEquityUsd: equity, entriesToday: 0, cooldownUntil: {}, killSwitch: false });
const rec = (barTime: number, portfolio: object, outcome: object, asset = "NEAR") => ({ version: 1, asset, barTime, inputs: { now: barTime + H + 15_000, portfolio, candles: [], externals: { authenticated: true, calls: [] } }, signals: [], checks: [], outcome });
const hold = { action: "HOLD", reason: "NO_SIGNAL" };

async function root() {
  const r = await mkdtemp(join(tmpdir(), "pf-"));
  await mkdir(join(r, "fixtures", "demo-entry"), { recursive: true });
  await writeFile(join(r, "fixtures", "demo-entry", "manifest.json"), JSON.stringify({ window: { from: "2026-07-12T01:00Z", to: "2026-07-24T13:00Z" } }));
  await mkdir(join(r, "records"));
  let n = 0;
  const put = (x: object) => writeFile(join(r, "records", `${(n++).toString(16).padStart(64, "0")}.json`), JSON.stringify(x));
  // a demo replay with a full cycle (July), and the paper agent's own records (November)
  const jul = Date.parse("2026-07-20T09:00Z");
  await put(rec(jul, snap(1000, 0, 1000), { action: "TRADE", proposal: { kind: "ENTRY", asset: "NEAR", notionalUsd: 250, referencePrice: 1.936 } }));
  await put(rec(jul + H, snap(750, 129.1, 1002), hold));
  await put(rec(jul + 2 * H, snap(1007.4, 0, 1007.4), hold));
  const nov = Date.parse("2026-11-10T10:00Z");
  for (let i = 0; i < 3; i++) await put(rec(nov + i * H, snap(1000, 0, 1000), hold));
  await put(rec(nov + 2 * H, snap(1000, 0, 1000), hold, "BTC")); // same bar, other asset: one point
  return { r, nov };
}

describe("portfolio tab", () => {
  it("demo shows the replay only, with its trades and holdings valued", async () => {
    const { r } = await root();
    const v = await buildPortfolio(r, "demo", cfg);
    expect(v.source).toMatch(/Replay of frozen market data, 2026-07-20 to 2026-07-20.*Not live results/);
    expect(v.points.map((p) => p.equity)).toEqual([1000, 1002, 1007.4]);
    expect(v.points[1]!.values).toEqual({ USDC: 750, NEAR: 252, BTC: 0 }); // no price at hand: NEAR is what is not USDC
    expect(v.trades).toEqual([expect.objectContaining({ asset: "NEAR", kind: "ENTRY", notionalUsd: 250 })]);
  });

  it("paper is rebuilt from its own records (one point per bar), then follows history.jsonl", async () => {
    const { r, nov } = await root();
    let v = await buildPortfolio(r, "paper", cfg);
    expect(v.points).toHaveLength(3);
    expect(v.trades).toEqual([]);
    expect(v.source).toMatch(/Rebuilt from the paper agent's decision records/);

    await mkdir(join(r, "state", "paper"), { recursive: true });
    const line = { t: nov + 5 * H, equity: 1001, balances: { USDC: 750, NEAR: 70, BTC: 0 }, prices: { NEAR: 3.586, BTC: 70_000 }, trades: [{ asset: "NEAR", kind: "ENTRY", notionalUsd: 250, price: 3.57 }] };
    await writeFile(join(r, "state", "paper", "history.jsonl"), `${JSON.stringify(line)}\n{"cut by a cra`);
    await writeFile(join(r, "state", "paper", "portfolio.json"), JSON.stringify({ portfolio: { ...snap(750, 70, 1001), entriesToday: 1 } }));
    v = await buildPortfolio(r, "paper", cfg);
    expect(v.points).toHaveLength(4);
    expect(v.points.at(-1)!.values.NEAR).toBeCloseTo(251.02, 2);
    expect(v.trades).toHaveLength(1);
    expect(v.today).toMatchObject({ entriesToday: 1, equity: 1001 });
    expect(v.limits).toEqual({ dailyLossPct: 3, maxDrawdownPct: 10, maxEntriesPerDay: 6 });
  });

  it("live has nothing until the live agent runs", async () => {
    const { r } = await root();
    const v = await buildPortfolio(r, "live", cfg);
    expect(v.points).toEqual([]);
    expect(v.today).toBeUndefined();
  });
});

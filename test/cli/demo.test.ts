import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDemo, SCENARIOS, tryDryQuote } from "../../src/cli/demo.ts";
import { defaultRiskConfig as cfg } from "../../src/config/default.ts";
import { configHash } from "../../src/config/schema.ts";
import { loadFixtureSet } from "../../src/data/fixtures.ts";
import { runReplay, scenarioBars } from "../../src/execution/replay.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

async function demo(fetchImpl: typeof fetch, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await runDemo({ root, out: mkdtempSync(join(tmpdir(), "demo-")), write: (l) => lines.push(l), agentVersion: "test", fetch: fetchImpl, env });
  return { code, out: lines.join("\n") };
}

describe("pnpm demo", () => {
  it("exits 0 and prints the hash of every non-trivial decision, identical to an independent replay", async () => {
    const { code, out } = await demo(offline);
    expect(code).toBe(0);
    for (const name of SCENARIOS) {
      const set = await loadFixtureSet(join(root, "fixtures", name));
      const bars = scenarioBars(set);
      const run = await runReplay({ set, cfg, meta: { agentVersion: "test", configHash: configHash(cfg) }, dir: mkdtempSync(join(tmpdir(), "x-")), ...(bars ? { bars } : {}) });
      run.decisions.forEach((d, i) => {
        if (!(d.outcome.action === "HOLD" && d.outcome.reason === "NO_SIGNAL")) expect(out).toContain(run.hashes[i]);
      });
    }
    expect(out).toMatch(/demo-entry: 101 closed 1h bars replayed/);
    expect(out).toMatch(/TRADE  buy \$250\.00 of NEAR at 1\.936/);
    expect(out).toMatch(/TAKE_PROFIT_1/);
    expect(out).toMatch(/TAKE_PROFIT_2/);
    expect(out).toMatch(/demo-refusal: 25 closed 1h bars replayed.*\n.*\n.*REJECT VETO_RSI_EXHAUSTION/);
    expect(out).toMatch(/equity \$1000\.00 → \$1007\.44 \(\+\$7\.44\)/);
  }, 60_000);

  it("with the network blocked, still succeeds and says it fell back", async () => {
    const { code, out } = await demo(offline);
    expect(code).toBe(0);
    expect(out).toMatch(/live dry quote: unavailable \(fetch failed\); the demo is fully offline and continues with fixture quotes only/);
  }, 60_000);

  it("prints one real dry quote when 1Click answers, sending the JWT only if present", async () => {
    const seen: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ quote: { amountOutFormatted: "12.8956" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await tryDryQuote(cfg, { fetch: ok, env: { ONECLICK_JWT: "eyJtest" }, now: () => 0 });
    expect(r).toEqual({ ok: true, lines: [expect.stringMatching(/^live dry quote: 25 USDC → 12\.8956 NEAR .*dry: nothing signed or spent, partner JWT/)] });
    expect(seen[0]!.headers["x-api-key"]).toBe("eyJtest");
    expect(seen[0]!.headers["user-agent"]).toMatch(/^near-sentinel\//); // Cloudflare refuses default user agents (1010)
    expect(seen[0]!.body).toMatchObject({ dry: true, depositType: "INTENTS", amount: "25000000" });
    const noJwt = await tryDryQuote(cfg, { fetch: ok, env: {} });
    expect(noJwt.lines[0]).toMatch(/no partner JWT/);
    expect(seen[1]!.headers).not.toHaveProperty("x-api-key");
  });

  it("an HTTP error from 1Click is reported, not fatal", async () => {
    const denied = (async () => new Response('{"message":"Invalid token"}', { status: 401 })) as unknown as typeof fetch;
    const r = await tryDryQuote(cfg, { fetch: denied, env: { ONECLICK_JWT: "bad" } });
    expect(r).toEqual({ ok: false, lines: [expect.stringMatching(/HTTP 401 .*Invalid token.*continuing with fixture quotes only/)] });
  });
});

/**
 * `pnpm demo`: replay the two frozen scenarios offline, print what the agent decided and the hash of every
 * record, then try ONE real 1Click dry quote. Without network the demo still succeeds and says so.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { defaultRiskConfig } from "../config/default.ts";
import { configHash, type RiskConfig } from "../config/schema.ts";
import { loadFixtureSet } from "../data/fixtures.ts";
import type { Decision } from "../decision/engine.ts";
import { runReplay, scenarioBars, type ReplayRun } from "../execution/replay.ts";

export const SCENARIOS = ["demo-entry", "demo-refusal"] as const;
const ONECLICK_QUOTE = "https://1click.chaindefuser.com/v0/quote";
const USER_AGENT = "near-sentinel/0.1 (+https://github.com/enzodheilly/near-sentinel)";

export interface DemoOptions {
  readonly root: string; // repository root (fixtures/ lives there)
  readonly out: string; // records directory
  readonly write: (line: string) => void;
  readonly cfg?: RiskConfig;
  readonly agentVersion?: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

export function gitVersion(root: string): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const usd = (x: number) => `$${x.toFixed(2)}`;

function describe(d: Decision): string {
  const o = d.outcome;
  if (o.action === "TRADE") {
    const p = o.proposal;
    return p.kind === "ENTRY"
      ? `TRADE  buy ${usd(p.notionalUsd)} of ${p.asset} at ${p.referencePrice}, stop ${p.stopPrice.toPrecision(6)}, targets ${p.takeProfit.map((x) => x.toPrecision(6)).join(" / ")}`
      : `TRADE  sell ${(p.fraction * 100).toFixed(0)}% of ${p.asset} (${p.reason}) at ${p.referencePrice.toPrecision(6)}`;
  }
  return `${o.action.padEnd(6)} ${o.reason}`;
}

export function printRun(run: ReplayRun, write: (l: string) => void): void {
  const holds = run.decisions.filter((d) => d.outcome.action === "HOLD" && d.outcome.reason === "NO_SIGNAL").length;
  write(`\n${run.name}: ${run.bars} closed 1h bars replayed, ${run.decisions.length} decisions recorded (${holds} × HOLD NO_SIGNAL not shown)`);
  write(`  ${"bar (UTC)".padEnd(16)}  ${"asset".padEnd(5)}  ${"decision".padEnd(70)}  record`);
  run.decisions.forEach((d, i) => {
    if (d.outcome.action === "HOLD" && d.outcome.reason === "NO_SIGNAL") return;
    write(`  ${iso(d.barTime).padEnd(16)}  ${d.asset.padEnd(5)}  ${describe(d).padEnd(70)}  ${run.hashes[i]}`);
  });
  const pnl = run.end.equityUsd - run.start.equityUsd;
  write(`  result: ${run.executions.length} execution(s), equity ${usd(run.start.equityUsd)} → ${usd(run.end.equityUsd)} (${pnl >= 0 ? "+" : ""}${usd(pnl)})`);
}

/** One real dry quote (no funds, nothing signed). Never throws: returns what to print. */
export async function tryDryQuote(cfg: RiskConfig, opts: Pick<DemoOptions, "fetch" | "env" | "now">): Promise<{ ok: boolean; lines: string[] }> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const jwt = opts.env?.["ONECLICK_JWT"];
  const body = {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: cfg.execution.slippageBps.entry,
    originAsset: cfg.assets.USDC.assetId, destinationAsset: cfg.assets.NEAR.assetId, amount: "25000000",
    depositType: "INTENTS", recipient: "near-sentinel-demo.near", recipientType: "INTENTS",
    refundTo: "near-sentinel-demo.near", refundType: "INTENTS",
    deadline: new Date(now() + cfg.execution.deadlineSec * 1000).toISOString(),
  };
  try {
    const res = await f(ONECLICK_QUOTE, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, ...(jwt ? { "x-api-key": jwt } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, lines: [`live dry quote: 1Click answered HTTP ${res.status} (${text.slice(0, 120)}); continuing with fixture quotes only`] };
    const j = JSON.parse(text) as { quote?: { amountOutFormatted?: string; amountOut?: string } };
    const out = j.quote?.amountOutFormatted ?? (j.quote?.amountOut ? String(Number(j.quote.amountOut) / 1e24) : "?");
    return { ok: true, lines: [`live dry quote: 25 USDC → ${out} NEAR on NEAR Intents (1Click, dry: nothing signed or spent${jwt ? ", partner JWT" : ", no partner JWT: +0.25% fee"})`] };
  } catch (e) {
    const why = e instanceof Error ? (e.name === "TimeoutError" ? "timed out after 8 s" : e.message) : String(e);
    return { ok: false, lines: [`live dry quote: unavailable (${why}); the demo is fully offline and continues with fixture quotes only`] };
  }
}

export async function runDemo(o: DemoOptions): Promise<number> {
  const cfg = o.cfg ?? defaultRiskConfig;
  const meta = { agentVersion: o.agentVersion ?? gitVersion(o.root), configHash: configHash(cfg) };
  o.write("NEAR Sentinel — replay of the frozen demo scenarios (offline, deterministic)");
  o.write(`agent ${meta.agentVersion} · config ${meta.configHash} · records → ${o.out}`);
  o.write("replay mode: fixture candles and quotes, simulated fills, no model called for the LLM veto");
  for (const name of SCENARIOS) {
    const set = await loadFixtureSet(join(o.root, "fixtures", name));
    const bars = scenarioBars(set);
    printRun(await runReplay({ set, cfg, meta, dir: o.out, ...(bars ? { bars } : {}) }), o.write);
  }
  o.write("");
  for (const l of (await tryDryQuote(cfg, o)).lines) o.write(l);
  o.write(`\nverify any record: pnpm verify <hash>     (recomputes it from its inputs)`);
  return 0;
}

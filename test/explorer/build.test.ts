import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runVerify } from "../../src/cli/verify.ts";
import { buildExplorerData, renderExplorer, runExplorer, type ExplorerData } from "../../src/explorer/build.ts";

const root = resolve(new URL("../..", import.meta.url).pathname);
const records = join(mkdtempSync(join(tmpdir(), "exp-")), "records");
let data: ExplorerData;
let html: string;

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "exp-out-")), "index.html");
  const lines: string[] = [];
  const code = await runExplorer({ root, records, out, write: (l) => lines.push(l), agentVersion: "test", now: () => Date.parse("2026-11-06T22:00:00Z") });
  expect(code).toBe(0);
  expect(lines[0]).toMatch(/^explorer: 254 decision records embedded \(all verified\)/);
  html = readFileSync(out, "utf8");
  data = await buildExplorerData({ root, records, agentVersion: "test", now: () => 0 });
}, 120_000);

describe("decision explorer", () => {
  it("is built only from real decision records: every embedded record is the file on disk", () => {
    for (const s of data.scenarios) {
      for (const d of s.decisions) expect(JSON.parse(readFileSync(join(records, `${d.hash}.json`), "utf8"))).toEqual(d.record);
    }
    expect(data.scenarios.map((s) => [s.name, s.decisions.length])).toEqual([["demo-entry", 204], ["demo-refusal", 50]]);
  });

  it("shows the entry → TP1 → TP2 sequence and the refusal with its reason", () => {
    const [entry, refusal] = data.scenarios;
    const trades = entry!.decisions.filter((d) => d.record.outcome.action === "TRADE").map((d) => (d.record.outcome as { proposal: { kind: string; reason?: string } }).proposal);
    expect(trades.map((p) => p.reason ?? p.kind)).toEqual(["ENTRY", "TAKE_PROFIT_1", "TAKE_PROFIT_2"]);
    const refused = refusal!.decisions.filter((d) => d.record.outcome.action === "REJECT");
    expect(refused.map((d) => (d.record.outcome as { reason: string }).reason)).toEqual(["VETO_RSI_EXHAUSTION"]);
    expect(refused[0]!.record.barTime).toBe(refusal!.signalBarTime);
  });

  it("the verification status of every decision matches pnpm verify", async () => {
    const lines: string[] = [];
    const code = await runVerify({ root, records, args: ["--all"], write: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(data.scenarios.flatMap((s) => s.decisions).every((d) => d.verified && d.problems.length === 0)).toBe(true);
    // a failing record would show as failed too
    const bad = data.scenarios[1]!.decisions[0]!;
    writeFileSync(join(records, `${bad.hash}.json`), readFileSync(join(records, `${bad.hash}.json`), "utf8").replace('"HOLD"', '"TRADE"'));
    expect(await runVerify({ root, records, args: [bad.hash], write: () => {} })).toBe(1);
  });

  it("opens offline: one file, no CDN, no URL to fetch, no backend", () => {
    const page = html.replaceAll("http://www.w3.org/2000/svg", "SVG_NS"); // an XML namespace, never fetched
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/|@import|fetch\(|XMLHttpRequest|WebSocket/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/prefers-color-scheme: light/);
  });

  it("embeds the data safely: nothing in a record can close the script tag", () => {
    const evil = { ...data, agentVersion: "</script><script>alert(1)</script>" };
    const out = renderExplorer("<script>const DATA = /*__DATA__*/null;</script>", evil);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(out.slice(out.indexOf("= ") + 2, out.lastIndexOf(";</script>"))).agentVersion).toBe(evil.agentVersion);
    expect(() => renderExplorer("<html></html>", data)).toThrow(/placeholder/);
  });

  it("keeps `$&`, `$$` and `$'` in the data literally (no replacement patterns)", () => {
    const tricky = { ...data, agentVersion: "fee $$ then $& and $' end" };
    const out = renderExplorer("<script>const DATA = /*__DATA__*/null;</script><p>tail</p>", tricky);
    expect(JSON.parse(out.slice(out.indexOf("= ") + 2, out.indexOf(";</script>"))).agentVersion).toBe(tricky.agentVersion);
    expect(out.match(/<p>tail<\/p>/g)).toHaveLength(1);
  });
});

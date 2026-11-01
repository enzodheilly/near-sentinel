import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { defaultRiskConfig } from "../../src/config/default.ts";
import { configHash, parseRiskConfig, type RiskConfig } from "../../src/config/schema.ts";

/** Deep copy of the default config with one change applied. */
function variant(mutate: (c: RiskConfig) => void): unknown {
  const c = structuredClone(defaultRiskConfig) as RiskConfig;
  mutate(c);
  return c;
}

function failingPaths(input: unknown): string[] {
  try {
    parseRiskConfig(input);
    return [];
  } catch (e) {
    if (!(e instanceof ZodError)) throw e;
    return e.issues.map((i) => i.path.join("."));
  }
}

describe("default config", () => {
  it("is valid", () => {
    expect(() => parseRiskConfig(defaultRiskConfig)).not.toThrow();
  });

  it("is frozen", () => {
    expect(Object.isFrozen(defaultRiskConfig.sizing)).toBe(true);
    expect(() => {
      (defaultRiskConfig.sizing as { riskPerTradePct: number }).riskPerTradePct = 50;
    }).toThrow(TypeError);
  });

  it("matches the defaults block of RISK_ENGINE.md §11", () => {
    const spec = readFileSync(new URL("../../RISK_ENGINE.md", import.meta.url), "utf8");
    const block = spec.match(/export const defaultRiskConfig = (\{[\s\S]*?\}) as const;/)?.[1];
    expect(block, "defaults block not found in RISK_ENGINE.md").toBeTruthy();
    // The spec block is a TS object literal with numeric separators; evaluate it as data.
    const specConfig = new Function(`return (${block});`)() as Record<string, unknown>;
    const { assets: _assets, llm, ...rules } = defaultRiskConfig;
    const { model: _model, ...llmRules } = llm;
    expect({ ...rules, llm: llmRules }).toEqual(specConfig);
  });
});

describe("invalid configs are rejected", () => {
  it.each<[string, (c: RiskConfig) => void, string]>([
    ["risk per trade <= 0", (c) => ((c.sizing as { riskPerTradePct: number }).riskPerTradePct = 0), "sizing.riskPerTradePct"],
    ["risk per trade above 5%", (c) => ((c.sizing as { riskPerTradePct: number }).riskPerTradePct = 6), "sizing.riskPerTradePct"],
    ["tp1R <= 0", (c) => ((c.exits as { tp1R: number }).tp1R = 0), "exits.tp1R"],
    ["TP1 after TP2", (c) => ((c.exits as { tp1R: number }).tp1R = 4), "exits.tp1R"],
    ["inverted RSI band", (c) => ((c.signals as { rsiMomentum: [number, number] }).rsiMomentum = [75, 55]), "signals.rsiMomentum"],
    ["exhaustion inside the band", (c) => ((c.signals as { rsiExhaustion: number }).rsiExhaustion = 70), "signals.rsiExhaustion"],
    ["empty asset id", (c) => ((c.assets.NEAR as { assetId: string }).assetId = ""), "assets.NEAR.assetId"],
    ["position cap above exposure cap", (c) => ((c.sizing as { maxPositionPct: number }).maxPositionPct = 60), "sizing.maxPositionPct"],
    ["LLM fallback that keeps full size", (c) => ((c.llm as { fallbackMultiplier: number }).fallbackMultiplier = 1), "llm.fallbackMultiplier"],
    ["exit slippage tighter than entry", (c) => ((c.execution.slippageBps as { exit: number }).exit = 10), "execution.slippageBps"],
    ["stop multiple outside its bounds", (c) => ((c.sizing as { stopAtrMult: number }).stopAtrMult = 4), "sizing.stopAtrMult"],
  ])("%s", (_name, mutate, path) => {
    expect(failingPaths(variant(mutate))).toContain(path);
  });

  it("rejects unknown keys (typos cannot silently disable a rule)", () => {
    expect(failingPaths(variant((c) => Object.assign(c.limits, { dailyLosPct: 1 })))).toContain("limits");
  });
});

describe("configHash", () => {
  it("is stable for the same config", () => {
    expect(configHash(defaultRiskConfig)).toBe(configHash(structuredClone(defaultRiskConfig) as RiskConfig));
  });

  it("changes when any rule changes", () => {
    const changed = parseRiskConfig(variant((c) => ((c.limits as { cooldownBars: number }).cooldownBars = 4)));
    expect(configHash(changed)).not.toBe(configHash(defaultRiskConfig));
  });

  it("is a 64-character lowercase hex SHA-256", () => {
    expect(configHash(defaultRiskConfig)).toMatch(/^[0-9a-f]{64}$/);
  });
});

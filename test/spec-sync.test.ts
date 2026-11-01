import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REJECT_REASONS, idempotencyKey, type EntryProposal, type ExitProposal } from "../src/types.ts";

/** Extracts the string literals of the `RejectReason` union from RISK_ENGINE.md §9. */
function rejectReasonsFromSpec(): string[] {
  const spec = readFileSync(new URL("../RISK_ENGINE.md", import.meta.url), "utf8");
  const block = spec.match(/type RejectReason =([\s\S]*?);/);
  if (!block?.[1]) throw new Error("RejectReason union not found in RISK_ENGINE.md");
  return [...block[1].matchAll(/"([A-Z_0-9]+)"/g)].map((m) => m[1] as string);
}

describe("code stays in sync with RISK_ENGINE.md", () => {
  it("REJECT_REASONS equals the union in §9", () => {
    expect([...REJECT_REASONS].sort()).toEqual(rejectReasonsFromSpec().sort());
  });

  it("REJECT_REASONS has no duplicates", () => {
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
  });
});

describe("idempotencyKey", () => {
  const entry: EntryProposal = {
    kind: "ENTRY", asset: "NEAR", barTime: 1_784_538_000_000, referencePrice: 3, notionalUsd: 300, quantity: 100,
    stopPrice: 2.9, takeProfit: [3.15, 3.3], riskUsd: 10, signals: [],
  };
  const exit: ExitProposal = {
    kind: "EXIT", asset: "NEAR", barTime: 1_784_538_000_000, reason: "TAKE_PROFIT_1", referencePrice: 3.15, quantity: 50, fraction: 0.5,
  };

  it("distinguishes an entry from an exit on the same bar", () => {
    expect(idempotencyKey(entry)).toBe("NEAR:1784538000000:ENTRY");
    expect(idempotencyKey(exit)).toBe("NEAR:1784538000000:TAKE_PROFIT_1");
  });
});

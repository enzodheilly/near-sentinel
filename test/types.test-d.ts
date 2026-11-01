import { describe, expectTypeOf, it } from "vitest";
import type {
  DecisionOutcome,
  EntryProposal,
  ExitProposal,
  LlmReview,
  RejectReason,
  RiskVerdict,
  TradeProposal,
  TradableAsset,
} from "../src/types.ts";

describe("domain types", () => {
  it("a rejected verdict must carry a reason, an accepted one a proposal", () => {
    expectTypeOf<Extract<RiskVerdict, { ok: false }>>().toHaveProperty("reason").toEqualTypeOf<RejectReason>();
    expectTypeOf<Extract<RiskVerdict, { ok: true }>>().toHaveProperty("proposal").toEqualTypeOf<TradeProposal>();
    // @ts-expect-error a rejection without a reason is not a RiskVerdict
    const bad: RiskVerdict = { ok: false, checks: [] };
    void bad;
  });

  it("entries always carry a stop and two targets; exits never do", () => {
    expectTypeOf<EntryProposal["stopPrice"]>().toEqualTypeOf<number>();
    expectTypeOf<EntryProposal["takeProfit"]>().toEqualTypeOf<readonly [tp1: number, tp2: number]>();
    expectTypeOf<ExitProposal>().not.toHaveProperty("stopPrice");
  });

  it("USDC is not a tradable asset", () => {
    expectTypeOf<"USDC">().not.toMatchTypeOf<TradableAsset>();
    expectTypeOf<"NEAR" | "BTC">().toEqualTypeOf<TradableAsset>();
  });

  it("the LLM size multiplier can only be 1, 0.5 or 0", () => {
    expectTypeOf<LlmReview["sizeMultiplier"]>().toEqualTypeOf<1 | 0.5 | 0>();
  });

  it("a TRADE outcome carries the proposal it executed", () => {
    expectTypeOf<Extract<DecisionOutcome, { action: "TRADE" }>>().toHaveProperty("proposal").toEqualTypeOf<TradeProposal>();
  });
});

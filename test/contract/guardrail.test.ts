import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxEnabled, startGuardrail, type Guardrail } from "./setup.ts";

describe.skipIf(!sandboxEnabled)("guardrail contract (sandbox)", () => {
  let g: Guardrail;
  beforeAll(async () => {
    g = await startGuardrail();
  }, 180_000);
  afterAll(async () => {
    await g?.stop();
  });

  it("deploys and initialises with the policy", async () => {
    expect(await g.view("get_policy")).toMatchObject({ owner: g.owner, agent: g.agent, max_trades_per_day: 3, paused: false });
  });
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxEnabled, startGuardrail, type Guardrail } from "./setup.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!sandboxEnabled)("guardrail contract (sandbox)", { timeout: 60_000 }, () => {
  let g: Guardrail;
  beforeAll(async () => {
    g = await startGuardrail({ max_trades_per_day: 2 });
  }, 180_000);
  afterAll(async () => {
    await g?.stop();
  });

  it("deploys and initialises with the policy", async () => {
    expect(await g.view("get_policy")).toMatchObject({ owner: g.owner, agent: g.agent, max_trades_per_day: 2, paused: false });
  });

  it("only the agent records; a hash is kept with its kind, time and sequence", async () => {
    expect(await g.call(g.agent, "record_decision", { hash: h("hold-1"), kind: "HOLD" })).toBe(1);
    expect(await g.view("get_decision", { hash: h("hold-1") })).toMatchObject({ hash: h("hold-1"), kind: "HOLD", seq: 1 });
    await expect(g.call(g.owner, "record_decision", { hash: h("x"), kind: "HOLD" })).rejects.toThrow(/only the agent/);
    await expect(g.call(g.stranger, "record_decision", { hash: h("y"), kind: "TRADE" })).rejects.toThrow(/only the agent/);
    await expect(g.call(g.agent, "record_decision", { hash: h("hold-1"), kind: "HOLD" })).rejects.toThrow(/already recorded/);
    await expect(g.call(g.agent, "record_decision", { hash: "not-a-hash", kind: "HOLD" })).rejects.toThrow(/64 lowercase hex/);
    expect(await g.view("get_decision", { hash: h("never") })).toBeNull();
  });

  it("the daily trade cap is enforced on chain; refusals stay recordable", async () => {
    await g.call(g.agent, "record_decision", { hash: h("trade-1"), kind: "TRADE" });
    await g.call(g.agent, "record_decision", { hash: h("trade-2"), kind: "TRADE" });
    await expect(g.call(g.agent, "record_decision", { hash: h("trade-3"), kind: "TRADE" })).rejects.toThrow(/max_trades_per_day/);
    await g.call(g.agent, "record_decision", { hash: h("reject-1"), kind: "REJECT" });
    expect(await g.view("get_day_usage")).toMatchObject({ trades: 2 });
  });

  it("the agent can pause, only the owner unpauses; a stranger can do neither", async () => {
    await expect(g.call(g.stranger, "pause")).rejects.toThrow(/only the owner or the agent/);
    await g.call(g.agent, "pause");
    expect(await g.view("get_policy")).toMatchObject({ paused: true });
    await expect(g.call(g.agent, "unpause")).rejects.toThrow(/only the owner/);
    await g.call(g.owner, "unpause");
    expect(await g.view("get_policy")).toMatchObject({ paused: false });
  });

  it("only the owner changes the policy", async () => {
    await expect(g.call(g.agent, "set_policy", { update: { max_trades_per_day: 99 } })).rejects.toThrow(/only the owner/);
    await g.call(g.owner, "set_policy", { update: { max_trades_per_day: 4 } });
    expect(await g.view("get_policy")).toMatchObject({ max_trades_per_day: 4, agent: g.agent });
  });
});

describe.skipIf(!sandboxEnabled)("anchoring against the deployed contract (sandbox)", { timeout: 60_000 }, () => {
  let g: Guardrail;
  beforeAll(async () => {
    g = await startGuardrail({ max_trades_per_day: 5 });
  }, 180_000);
  afterAll(async () => {
    await g?.stop();
  });

  it("a hash anchored by the agent is then found; a paused contract refuses a TRADE anchor", async () => {
    const { ContractAnchor, AnchorError } = await import("../../src/execution/anchor.ts");
    const a = new ContractAnchor({ near: g.near as never, contractId: g.contract, agentId: g.agent });
    const hash = h("anchored-decision");
    expect(await a.record(hash, "TRADE")).toBe(1);
    expect(await a.lookup(hash)).toMatchObject({ hash, kind: "TRADE", seq: 1 });
    expect(await a.lookup(h("unknown"))).toBeNull();
    await g.call(g.owner, "pause");
    await expect(a.record(h("while-paused"), "TRADE")).rejects.toBeInstanceOf(AnchorError);
    expect(await a.record(h("refusal-while-paused"), "REJECT")).toBe(2);
  });
});

describe.skipIf(!sandboxEnabled)("restricted agent key (sandbox)", { timeout: 60_000 }, () => {
  let g: Guardrail;
  beforeAll(async () => {
    g = await startGuardrail({ max_trades_per_day: 5 });
  }, 180_000);
  afterAll(async () => {
    await g?.stop();
  });

  it("the key can only call record_decision and pause on the guardrail", async () => {
    const { Near, generateKey } = await import("near-kit");
    const { addAgentKey, AGENT_METHODS } = await import("../../scripts/setup-agent-key.ts");
    const key = await addAgentKey(g.near, g.agent, g.contract);
    expect(key.permission).toMatchObject({ type: "functionCall", receiverId: g.contract, methodNames: [...AGENT_METHODS] });

    // the agent process holds only this key
    const agent = new Near({ network: g.sandbox, keyStore: { [g.agent]: key.secretKey }, defaultWaitUntil: "FINAL" });
    const call = (method: string, args: object = {}, contract = g.contract) => agent.call(contract, method, args, { signerId: g.agent, gas: "30 Tgas" });

    await call("record_decision", { hash: h("with-restricted-key"), kind: "HOLD" });
    expect(await g.view("get_decision", { hash: h("with-restricted-key") })).toMatchObject({ kind: "HOLD" });
    await call("pause");
    expect(await g.view("get_policy")).toMatchObject({ paused: true });

    // everything else is refused by the key itself
    await expect(call("unpause")).rejects.toThrow();
    await expect(call("set_policy", { update: { max_trades_per_day: 99 } })).rejects.toThrow();
    await expect(call("record_decision", { hash: h("elsewhere"), kind: "HOLD" }, g.stranger)).rejects.toThrow();
    await expect(agent.transaction(g.agent).transfer(g.stranger, "1 NEAR").send()).rejects.toThrow();
    await expect(agent.transaction(g.agent).addKey(generateKey().publicKey.toString(), { type: "fullAccess" }).send()).rejects.toThrow();
    expect(await g.view("get_policy")).toMatchObject({ paused: true, max_trades_per_day: 5 });
  });
});

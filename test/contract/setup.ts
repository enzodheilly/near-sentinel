/**
 * Guardrail contract in a local NEAR sandbox (near-kit). Starts a node, creates owner / agent / stranger
 * accounts, deploys the wasm built by `pnpm contract:build`, and initialises it.
 *
 * The sandbox binary is downloaded on first use, so these tests run in CI (job `contract`) or on a machine
 * with network access; elsewhere they are skipped (SANDBOX=1 enables them).
 */
import { existsSync, readFileSync } from "node:fs";
import { Near, parseKey } from "near-kit";
import { Sandbox } from "near-kit/sandbox";

export const WASM = new URL("../../contracts/guardrail/target/near/near_sentinel_guardrail.wasm", import.meta.url).pathname;
export const sandboxEnabled = process.env["SANDBOX"] === "1" && existsSync(WASM);

export interface Guardrail {
  readonly sandbox: Sandbox;
  readonly near: Near;
  readonly contract: string;
  readonly owner: string;
  readonly agent: string;
  readonly stranger: string;
  /** Change call as `signer`; resolves the call's return value. */
  call<T = unknown>(signer: string, method: string, args?: object): Promise<T>;
  view<T = unknown>(method: string, args?: object): Promise<T>;
  stop(): Promise<void>;
}

/** The JSON a call returned: near-kit hands back the execution outcome (`status.SuccessValue`, base64). */
export function returnValue<T>(outcome: unknown): T {
  const v = (outcome as { status?: { SuccessValue?: string } }).status?.SuccessValue ?? "";
  const text = Buffer.from(v, "base64").toString("utf8");
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export async function startGuardrail(init: Record<string, unknown> = {}): Promise<Guardrail> {
  const sandbox = await Sandbox.start({ detached: false });
  const root = sandbox.rootAccount;
  const pub = parseKey(root.secretKey).publicKey.toString();
  const ids = { contract: `guardrail.${root.id}`, owner: `owner.${root.id}`, agent: `agent.${root.id}`, stranger: `stranger.${root.id}` };
  // views read final state: wait for finality so a view right after a call sees it
  const boot = new Near({ network: sandbox, keyStore: { [root.id]: root.secretKey }, defaultWaitUntil: "FINAL" });
  for (const id of Object.values(ids)) {
    await boot.transaction(root.id).createAccount(id).transfer(id, "20 NEAR").addKey(pub, { type: "fullAccess" }).send({ waitUntil: "FINAL" });
  }
  const near = new Near({ network: sandbox, keyStore: Object.fromEntries([root.id, ...Object.values(ids)].map((id) => [id, root.secretKey])), defaultWaitUntil: "FINAL" });
  await near
    .transaction(ids.contract)
    .deployContract(ids.contract, readFileSync(WASM))
    .functionCall(ids.contract, "new", { owner: ids.owner, agent: ids.agent, max_trades_per_day: 3, ...init }, { gas: "100 Tgas" })
    .send({ waitUntil: "FINAL" });
  return {
    sandbox, near, ...ids,
    call: async <T>(signer: string, method: string, args: object = {}) => returnValue<T>(await near.call<unknown>(ids.contract, method, args, { signerId: signer, gas: "100 Tgas" })),
    view: async <T>(method: string, args: object = {}) => (await near.view<T>(ids.contract, method, args)) as T,
    stop: () => sandbox.stop(),
  };
}

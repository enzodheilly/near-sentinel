/**
 * Deploys the guardrail on testnet (or mainnet) under the owner's account, run ONCE by the human.
 *
 *   node scripts/deploy-guardrail.ts --network testnet --owner <you>.testnet
 *   node scripts/deploy-guardrail.ts --network mainnet --owner <owner> --prefix <name> --yes-mainnet
 *
 * On testnet the accounts are `agent.<owner>` and `guardrail.<owner>`. On mainnet the owner may be an implicit
 * (64-hex) account, which cannot have sub-accounts (64-character limit), so `--prefix <name>` creates
 * `<name>-agent.near` and `<name>-guardrail.near` through the `near` registrar.
 *
 * With the owner's full-access key from ~/.near-credentials (e.g. created by
 *   npx near-cli-rs account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair
 *     save-to-legacy-keychain network-config testnet create):
 *   1. creates `agent.<owner>` and `guardrail.<owner>` (keys saved next to the owner's, never in the repo);
 *   2. deploys contracts/guardrail/res/near_sentinel_guardrail.wasm to `guardrail.<owner>` and calls
 *      new(owner, agent, max_trades_per_day);
 *   3. gives the agent its restricted key (record_decision, pause only) and writes it to .env.
 * Idempotent enough to re-run: existing accounts are kept, an initialised contract is not re-initialised.
 */

import { readFile } from "node:fs/promises";
import { generateKey, Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { addAgentKey, setEnv } from "./setup-agent-key.ts";

export const WASM_PATH = new URL("../contracts/guardrail/res/near_sentinel_guardrail.wasm", import.meta.url).pathname;

async function main(argv: string[]): Promise<number> {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network = (arg("network") ?? "testnet") as "testnet" | "mainnet";
  const owner = arg("owner");
  const maxTrades = Number(arg("max-trades") ?? 3);
  if (!owner) {
    console.error("usage: node scripts/deploy-guardrail.ts --network testnet|mainnet --owner <account> [--max-trades 3]");
    return 2;
  }
  if (network === "mainnet" && !argv.includes("--yes-mainnet")) {
    console.error("mainnet deploy spends real NEAR: re-run with --yes-mainnet once the owner has agreed");
    return 2;
  }
  const keys = new FileKeyStore(undefined, network);
  if (!(await keys.get(owner))) {
    console.error(`no key for ${owner} in ~/.near-credentials/${network}: create the account with near-cli-rs (save-to-legacy-keychain) first`);
    return 2;
  }
  const near = new Near({ network, keyStore: keys, defaultWaitUntil: "FINAL" });
  const prefix = arg("prefix");
  if (network === "mainnet" && !prefix) {
    console.error("mainnet needs --prefix <name>: the accounts will be <name>-agent.near and <name>-guardrail.near");
    return 2;
  }
  const agent = prefix ? `${prefix}-agent.near` : `agent.${owner}`;
  const guardrail = prefix ? `${prefix}-guardrail.near` : `guardrail.${owner}`;

  // guardrail: storage for the 160 KB wasm (~1.6 NEAR) + state; agent: gas for anchoring and key setup
  const amounts = network === "mainnet" ? (["0.3 NEAR", "2 NEAR"] as const) : (["1 NEAR", "3 NEAR"] as const);
  for (const [id, amount] of [[agent, amounts[0]], [guardrail, amounts[1]]] as const) {
    if (await near.accountExists(id)) {
      console.log(`${id}: exists, kept`);
      continue;
    }
    const kp = generateKey();
    if (prefix) {
      // top-level *.near account, created by the `near` registrar with the deposit as its starting balance
      await near.call("near", "create_account", { new_account_id: id, new_public_key: kp.publicKey.toString() }, { signerId: owner, attachedDeposit: amount, gas: "100 Tgas" });
    } else {
      await near.transaction(owner).createAccount(id).transfer(id, amount).addKey(kp.publicKey.toString(), { type: "fullAccess" }).send();
    }
    await keys.add(id, kp);
    console.log(`${id}: created with ${amount} (full-access key saved in ~/.near-credentials/${network}, not in the repo)`);
  }

  let initialised = false;
  try {
    const p = await near.view<{ owner: string; agent: string }>(guardrail, "get_policy", {});
    initialised = p !== undefined;
    if (initialised) console.log(`${guardrail}: already initialised (owner ${p!.owner}, agent ${p!.agent})`);
  } catch {
    // no contract yet
  }
  if (!initialised) {
    const wasm = await readFile(WASM_PATH);
    await near
      .transaction(guardrail)
      .deployContract(guardrail, wasm)
      .functionCall(guardrail, "new", { owner, agent, max_trades_per_day: maxTrades }, { gas: "100 Tgas" })
      .send();
    console.log(`${guardrail}: guardrail deployed and initialised (owner ${owner}, agent ${agent}, max ${maxTrades} trades/day)`);
  }

  const key = await addAgentKey(near, agent, guardrail);
  const env = new URL("../.env", import.meta.url).pathname;
  // mainnet values go under LIVE_ so the paper run keeps anchoring on testnet
  const p = network === "mainnet" ? "LIVE_" : "";
  await setEnv(env, `${p}NEAR_NETWORK`, network);
  await setEnv(env, `${p}NEAR_AGENT_ACCOUNT`, agent);
  await setEnv(env, `${p}NEAR_GUARDRAIL_CONTRACT`, guardrail);
  await setEnv(env, `${p}NEAR_AGENT_KEY`, key.secretKey);
  console.log(`${agent}: restricted key ${key.publicKey} (record_decision, pause on ${guardrail}) written to .env as ${p}NEAR_*`);
  const explorer = network === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";
  console.log(`see it: ${explorer}/address/${guardrail}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

/**
 * Registers the agent's intent-signing key on intents.near (Tier 1, ARCHITECTURE.md §8.2), run ONCE by the human.
 *
 *   node scripts/setup-live-key.ts --agent <agent>.near --yes-mainnet
 *
 * Generates a NEW ed25519 key used only to sign NEP-413 intents, and calls intents.near add_public_key as the
 * agent account (its full-access key, from ~/.near-credentials/mainnet, signs; 1 yoctoNEAR deposit). The key is
 * NOT an access key of the NEAR account: it cannot move NEAR, deploy or call contracts. It can trade and withdraw
 * the agent's balance inside NEAR Intents, so that balance is kept small (Tier 1). Written to .env, never printed.
 */

import { generateKey, Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";
import { setEnv } from "./setup-agent-key.ts";

async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--agent");
  const agent = i >= 0 ? argv[i + 1] : undefined;
  if (!agent || !argv.includes("--yes-mainnet")) {
    console.error("usage: node scripts/setup-live-key.ts --agent <agent account> --yes-mainnet   (registers a key on intents.near, mainnet)");
    return 2;
  }
  const keys = new FileKeyStore(undefined, "mainnet");
  if (!(await keys.get(agent))) {
    console.error(`no full-access key for ${agent} in ~/.near-credentials/mainnet`);
    return 2;
  }
  const near = new Near({ network: "mainnet", keyStore: keys, defaultWaitUntil: "FINAL" });
  const kp = generateKey();
  await near.call("intents.near", "add_public_key", { public_key: kp.publicKey.toString() }, { signerId: agent, attachedDeposit: "1 yocto", gas: "30 Tgas" });
  const env = new URL("../.env", import.meta.url).pathname;
  await setEnv(env, "AGENT_ACCOUNT", agent);
  await setEnv(env, "AGENT_PRIVATE_KEY", kp.secretKey);
  console.log(`intent-signing key ${kp.publicKey} registered on intents.near for ${agent}; secret written to .env (not printed)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

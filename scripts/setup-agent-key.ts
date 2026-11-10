/**
 * Gives the agent a restricted key (ARCHITECTURE.md §9, ticket #45).
 *
 * The agent process never holds a full-access key. This script, run ONCE by the human on their own machine,
 * signs with the agent account's full-access key (from ~/.near-credentials) and adds a NEW function-call key
 * that can only call the guardrail contract's `record_decision` and `pause`, with a small gas allowance.
 * That key cannot transfer tokens, deploy, add keys, unpause, change the policy or call any other contract.
 * Its secret is written to .env (git-ignored) as NEAR_AGENT_KEY; it is never printed.
 *
 *   node scripts/setup-agent-key.ts --network testnet --agent <agent account> --contract <guardrail account>
 */

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { generateKey, Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

/** What the agent may call on the guardrail. Owner-only methods are deliberately absent. */
export const AGENT_METHODS = ["record_decision", "pause"] as const;
/** Gas the key may burn before the owner must top it up (record_decision costs ~0.0005 NEAR). */
export const AGENT_ALLOWANCE = "0.5 NEAR" as const;

export interface AgentKey {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly permission: { type: "functionCall"; receiverId: string; methodNames: string[]; allowance: typeof AGENT_ALLOWANCE };
}

export function agentKeyPlan(contractId: string): AgentKey {
  const kp = generateKey();
  return {
    publicKey: kp.publicKey.toString(),
    secretKey: kp.secretKey,
    permission: { type: "functionCall", receiverId: contractId, methodNames: [...AGENT_METHODS], allowance: AGENT_ALLOWANCE },
  };
}

/** Adds the restricted key to `agentId`, signed by a key `near` already holds for it (full access). */
export async function addAgentKey(near: Near, agentId: string, contractId: string): Promise<AgentKey> {
  const key = agentKeyPlan(contractId);
  await near.transaction(agentId).addKey(key.publicKey, key.permission).send({ waitUntil: "FINAL" });
  return key;
}

/** Sets NAME=value in a dotenv file, replacing an existing line. */
export async function setEnv(path: string, name: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    // new file
  }
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  if (re.test(text)) await writeFile(path, text.replace(re, line));
  else await appendFile(path, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

async function main(argv: string[]) {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network = (arg("network") ?? "testnet") as "testnet" | "mainnet";
  const agent = arg("agent");
  const contract = arg("contract");
  if (!agent || !contract) {
    console.error("usage: node scripts/setup-agent-key.ts --network testnet|mainnet --agent <account> --contract <guardrail account>");
    return 2;
  }
  const near = new Near({ network, keyStore: new FileKeyStore(undefined, network) });
  const key = await addAgentKey(near, agent, contract);
  const env = new URL("../.env", import.meta.url).pathname;
  await setEnv(env, "NEAR_NETWORK", network);
  await setEnv(env, "NEAR_AGENT_ACCOUNT", agent);
  await setEnv(env, "NEAR_GUARDRAIL_CONTRACT", contract);
  await setEnv(env, "NEAR_AGENT_KEY", key.secretKey);
  console.log(`restricted key ${key.publicKey} added to ${agent} on ${network}`);
  console.log(`  may call only ${contract}: ${AGENT_METHODS.join(", ")} (gas allowance ${AGENT_ALLOWANCE})`);
  console.log(`  secret written to .env as NEAR_AGENT_KEY (not printed). Keep the full-access key off the agent machine.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

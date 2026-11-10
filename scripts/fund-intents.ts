/**
 * Puts NEAR into the agent's NEAR Intents balance (as wNEAR), run by the human from the owner account.
 *
 *   node scripts/fund-intents.ts --from <owner> --to <agent>.near --near 6 --yes-mainnet
 *
 * 1. registers the owner on wrap.near if needed (storage, 0.00125 NEAR);
 * 2. wraps `--near` NEAR into wNEAR (wrap.near near_deposit);
 * 3. ft_transfer_call to intents.near with msg = the agent account: the wNEAR lands in the agent's Intents balance.
 * The agent can then swap inside NEAR Intents; nothing is sent to an exchange or another chain.
 */

import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

const YOCTO = 10n ** 24n;

async function main(argv: string[]): Promise<number> {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = arg("from");
  const to = arg("to");
  const amount = Number(arg("near"));
  if (!from || !to || !(amount > 0 && amount <= 20) || !argv.includes("--yes-mainnet")) {
    console.error("usage: node scripts/fund-intents.ts --from <owner> --to <agent account> --near <0..20> --yes-mainnet");
    return 2;
  }
  const near = new Near({ network: "mainnet", keyStore: new FileKeyStore(undefined, "mainnet"), defaultWaitUntil: "FINAL" });
  const yocto = BigInt(Math.round(amount * 1e6)) * 10n ** 18n;
  const reg = await near.view<{ total: string } | null>("wrap.near", "storage_balance_of", { account_id: from });
  if (!reg) {
    await near.call("wrap.near", "storage_deposit", { account_id: from, registration_only: true }, { signerId: from, attachedDeposit: "0.00125 NEAR", gas: "30 Tgas" });
    console.log(`${from}: registered on wrap.near`);
  }
  await near.call("wrap.near", "near_deposit", {}, { signerId: from, attachedDeposit: `${yocto} yocto`, gas: "30 Tgas" });
  console.log(`${from}: wrapped ${amount} NEAR into wNEAR`);
  await near.call("wrap.near", "ft_transfer_call", { receiver_id: "intents.near", amount: yocto.toString(), msg: to }, { signerId: from, attachedDeposit: "1 yocto", gas: "100 Tgas" });
  const bal = await near.view<string>("intents.near", "mt_balance_of", { account_id: to, token_id: "nep141:wrap.near" });
  console.log(`${to}: ${Number(BigInt(bal ?? "0") * 1_000_000n / YOCTO) / 1e6} wNEAR in NEAR Intents`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

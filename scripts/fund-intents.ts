/**
 * Puts the owner's USDC (or NEAR, as wNEAR) into the agent's NEAR Intents balance. Run by the human, from the
 * owner account (its key in ~/.near-credentials/mainnet).
 *
 *   node scripts/fund-intents.ts --from <owner> --to <agent>.near --usdc 20 --yes-mainnet
 *   node scripts/fund-intents.ts --from <owner> --to <agent>.near --near 3 --yes-mainnet
 *
 * USDC: ft_transfer_call on the native USDC contract to intents.near with msg = the agent account.
 * NEAR: register on wrap.near if needed, near_deposit (wrap), then the same ft_transfer_call on wrap.near.
 * The funds land in the agent's Intents balance; nothing goes to an exchange or another chain.
 */

import { Near } from "near-kit";
import { FileKeyStore } from "near-kit/keys/file";

export const USDC_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

async function main(argv: string[]): Promise<number> {
  const arg = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = arg("from");
  const to = arg("to");
  const usdc = arg("usdc") !== undefined ? Number(arg("usdc")) : undefined;
  const nearAmt = arg("near") !== undefined ? Number(arg("near")) : undefined;
  const ok = (usdc !== undefined && usdc > 0 && usdc <= 50) || (nearAmt !== undefined && nearAmt > 0 && nearAmt <= 20);
  if (!from || !to || !ok || !argv.includes("--yes-mainnet")) {
    console.error("usage: node scripts/fund-intents.ts --from <owner> --to <agent account> (--usdc <0..50> | --near <0..20>) --yes-mainnet");
    return 2;
  }
  const near = new Near({ network: "mainnet", keyStore: new FileKeyStore(undefined, "mainnet"), defaultWaitUntil: "FINAL" });
  let token: string;
  let amount: bigint;
  let decimals: number;
  if (usdc !== undefined) {
    token = USDC_CONTRACT;
    decimals = 6;
    amount = BigInt(Math.round(usdc * 1e6));
    const have = BigInt((await near.view<string>(token, "ft_balance_of", { account_id: from })) ?? "0");
    if (have < amount) {
      console.error(`${from} holds ${Number(have) / 1e6} USDC on NEAR, less than ${usdc}`);
      return 1;
    }
  } else {
    token = "wrap.near";
    decimals = 24;
    amount = BigInt(Math.round(nearAmt! * 1e6)) * 10n ** 18n;
    const reg = await near.view<{ total: string } | null>(token, "storage_balance_of", { account_id: from });
    if (!reg) {
      await near.call(token, "storage_deposit", { account_id: from, registration_only: true }, { signerId: from, attachedDeposit: "0.00125 NEAR", gas: "30 Tgas" });
      console.log(`${from}: registered on wrap.near`);
    }
    await near.call(token, "near_deposit", {}, { signerId: from, attachedDeposit: `${amount} yocto`, gas: "30 Tgas" });
    console.log(`${from}: wrapped ${nearAmt} NEAR into wNEAR`);
  }
  await near.call(token, "ft_transfer_call", { receiver_id: "intents.near", amount: amount.toString(), msg: to }, { signerId: from, attachedDeposit: "1 yocto", gas: "100 Tgas" });
  const bal = await near.view<string>("intents.near", "mt_balance_of", { account_id: to, token_id: `nep141:${token}` });
  console.log(`${to}: ${Number(BigInt(bal ?? "0")) / 10 ** decimals} ${usdc !== undefined ? "USDC" : "wNEAR"} in NEAR Intents`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));

# Sample records

`anchored/` holds 40 decision records written by the paper agent on 11 and 12 November 2026, byte for byte as it wrote them. Their hashes were anchored on the testnet guardrail [`guardrail.near-sentinel-enzo.testnet`](https://testnet.nearblocks.io/address/guardrail.near-sentinel-enzo.testnet) before the agent acted.

They are here so that the dashboard's Proof tab works on a fresh clone, with no key and no agent running:

```bash
corepack pnpm dashboard --sample
```

The page lists the records the chain confirms. For each one, your browser downloads the file, hashes it, and compares the result with the contract. The money is simulated: this is the paper agent.

`pnpm verify` cannot replay these records from a fresh clone, because a replay needs the market candles of that week and live candles are never committed (see `fixtures/README.md`). The offline demo records are the ones to replay.

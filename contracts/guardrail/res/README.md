# Built guardrail contract

`near_sentinel_guardrail.wasm` is the contract `scripts/deploy-guardrail.ts` deploys. It was built by CI
(`pnpm contract:build`, cargo-near 0.23, non-reproducible build) from the commit that added it.

SHA-256: `6156bdfb2a0322bb9d352517f52cbf978301391cebe48e21a26e6ba85737350a`

Rebuild it with `pnpm contract:build` (Rust stable, wasm32-unknown-unknown, cargo-near) and copy
`target/near/near_sentinel_guardrail.wasm` here when the contract changes. The deployed code hash can be compared
on NearBlocks (contract tab).

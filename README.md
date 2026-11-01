# NEAR Sentinel

An autonomous spot-trading agent whose risk limits are enforced on-chain and whose every decision can be replayed and verified by anyone. Built at NEAR HACKATHON (1–14 Nov 2026).

**Status: under construction.** The "do X, see Y" instructions will land here as soon as `pnpm demo` works.

- Design: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Risk rules: [RISK_ENGINE.md](./RISK_ENGINE.md)

```bash
pnpm install
pnpm check      # typecheck + unit tests + type tests
```

Requires Node ≥ 22.18 (TypeScript runs directly, no build step).

# Risk Engine Specification

> Design drafted during the preparation phase (October 2026). Implementation began on 1 Nov 2026, the first day of NEAR HACKATHON.

Version 0.1. Every number below is a default in `src/config/default.ts`, validated by a Zod schema and hashed into each decision record (`configHash`). Changing a parameter changes the hash, so a decision can always be traced to the exact rules that produced it.

Conventions: `R` is the dollar amount risked on a trade (entry-to-stop distance × size). Indicators are computed on **closed** candles only. All times are UTC.

---

## 1. Scope

| Item | Value |
|---|---|
| Tradable assets | `NEAR`, `BTC` |
| Quote asset | `USDC` (held in the NEAR Intents balance) |
| Direction | Long-only spot. Exit means selling back to USDC. |
| Execution timeframe | 1h candles |
| Regime timeframe | 4h candles |
| Positions | At most one open position per asset |

## 2. Indicators

All are pure functions of a candle array. Warm-up: a bar `t` (0-based index in the candle array) is evaluated only if `t ≥ 200`, i.e. at least 200 closed 1h bars strictly precede it, and at least 60 closed 4h bars precede the 1h bar's close. The frozen demo fixtures put the signal bar at exactly `t = 200`, so this rule must be implemented exactly as written.

| Name | Definition | Default |
|---|---|---|
| `RSI(n)` | Wilder's RSI on closes. Seeded with the simple average of the first `n` gains and losses (changes 1…n), so the first value is at index `n`; then Wilder smoothing `avg = (avg × (n − 1) + x) / n`. No movement at all gives 50; no loss gives 100. | `n = 14` |
| `ATR(n)` | Wilder's average true range. True range needs the previous close, so it exists from index 1. Seeded with the simple average of true ranges 1…n (first value at index `n`), then Wilder smoothing. | `n = 14` |
| `BB(n, k)` | SMA(n) of close ± k × population std-dev of close | `n = 20, k = 2` |
| `BBW` | (upper − lower) / middle | — |
| `EMA(n)` | Exponential moving average of close, seeded with SMA(n) | `n = 50` (4h) |
| `corr(n)` | Pearson correlation of 1h log returns, BTC vs NEAR | `n = 48` |

## 3. Signals

Each signal is evaluated on the last closed 1h bar `t`. Only `BB_BREAKOUT` has a graded strength; confirmations and vetoes carry strength `1`, and every signal records the raw numbers behind it as `evidence`.

### 3.1 `BB_BREAKOUT` (trigger, required for entry)

1. **Squeeze**: in at least one of the bars `j ∈ t-5 … t-1`, `BBW[j]` was at or below the 20th percentile of `BBW[j-120 … j-1]`. Percentile is **nearest-rank**: `sorted[floor(0.2 × (len − 1))]`, so the result is always an observed value and is reproducible.
2. **Breakout**: `close[t] > upper[t]`.
3. **Body filter**: `(close[t] − open[t]) ≥ 0.5 × (high[t] − low[t])`, to reject wick-only spikes.

Strength = `min(1, (close[t] − upper[t]) / ATR[t])`.

### 3.2 `RSI_MOMENTUM` (confirmation)

`55 ≤ RSI[t] ≤ 75`. Momentum present but not exhausted.

### 3.3 `RSI_EXHAUSTION` (veto)

`RSI[t] > 80`. Blocks any new entry on this bar, whatever the other signals say.

### 3.4 `FVG_SUPPORT` (confirmation)

A bullish fair value gap is a three-bar pattern `(i-2, i-1, i)` where `low[i] > high[i-2]`. The gap is the price zone `[high[i-2], low[i]]`.

The signal fires if there is a gap that is:

- **recent**: formed within the last 24 bars, i.e. its last bar `i` satisfies `t − 23 ≤ i ≤ t` (age `t − i` from 0 to 23);
- **meaningful**: `low[i] − high[i-2] ≥ 0.25 × ATR[i]`;
- **unfilled**: no close of bars `i+1 … t` has fallen below `high[i-2]`;
- **near**: its top `low[i]` lies between `close[t] − 1.5 × ATR[t]` and `close[t]`.

The most recent qualifying gap is used. Its bottom `high[i-2]` is reported as `evidence.fvgBottom` and is used for the stop (§5.2).

### 3.5 `BTC_REGIME` (confirmation or veto)

- `bullish` if BTC 4h close > EMA(50) on 4h.
- `bearish` otherwise.

The 4h candle used is the last one **closed by the end of bar `t`** (`openTime + 4h ≤ openTime[t] + 1h`); a 4h candle still open is never read. `corr(48)` pairs the 1h log returns of bars `t − 47 … t` with the BTC bars of the same `openTime`; a missing BTC bar makes it undefined.

For **NEAR** entries, the regime matters only when the assets move together:

| `corr(48)` | BTC regime bullish | BTC regime bearish |
|---|---|---|
| `≥ 0.6` | counts as a confirmation | **veto** |
| `< 0.6` | ignored | ignored |

An undefined correlation (a series with zero variance over the window) counts as `< 0.6`.

For **BTC** entries, the correlation is 1 by definition, so the first row applies: a bullish regime is a confirmation and a bearish regime is always a veto.

## 4. Entry convergence

An entry proposal is created for an asset only if **all** of the following hold:

1. `BB_BREAKOUT` fired on bar `t`.
2. At least **2** confirmations among `RSI_MOMENTUM`, `FVG_SUPPORT`, `BTC_REGIME` (bullish, when it counts).
3. No veto (`RSI_EXHAUSTION`, bearish `BTC_REGIME` when it applies).
4. No open position in that asset, and no cooldown active (§6.4).

If the breakout fires without enough confirmations, the record outcome is `REJECT` with reason `INSUFFICIENT_CONFLUENCE`. That rejection is logged like any other decision.

Without a breakout there is nothing to decide: the outcome is `HOLD` (`NO_SIGNAL`). Otherwise every condition is evaluated and recorded as a check, and when several fail the reason is the first one in this order: `POSITION_OPEN`, `COOLDOWN`, `VETO_RSI_EXHAUSTION`, `VETO_BTC_REGIME`, `INSUFFICIENT_CONFLUENCE`. A cooldown blocks bars opened before `cooldownUntil`, not the bar at `cooldownUntil` itself.

## 5. Position sizing and exits

### 5.1 Entry price reference

`P_ref` = close of bar `t`. The executed price is the quote-implied price `P_q` (§7.2). After execution, all levels are recomputed from the actual fill price `P_fill`.

### 5.2 Stop-loss

```
stop_atr  = P_ref − 1.5 × ATR[t]
stop_fvg  = fvgBottom − 0.1 × ATR[t]       (only if FVG_SUPPORT fired)
stop      = max(stop_atr, stop_fvg)  if FVG_SUPPORT fired, else stop_atr
```

So the stop sits just under the gap when a gap supports the trade, otherwise at 1.5 ATR. It is then bounded:

- distance `P_ref − stop` must be **≥ 0.5 × ATR** (not so tight that noise stops it out). If it is tighter, the stop is **moved down** to `P_ref − 0.5 × ATR` (no rejection);
- distance must be **≤ 3 × ATR** (otherwise reject with `STOP_TOO_WIDE`).

### 5.3 Size

```
equity      = USDC + Σ(asset balance × last close)
R_usd       = 1.0% × equity                       risk per trade
size_units  = R_usd / (P_ref − stop)
notional    = size_units × P_ref
```

Then capped, in this order (each cap can only reduce):

| Cap | Default |
|---|---|
| Notional per position | 25% of equity |
| Total exposure (all open positions) | 50% of equity |
| Available USDC | 100% of free USDC minus fee buffer |
| On-chain per-trade cap (Tier 2) | contract `max_amount_per_trade` |
| LLM multiplier | × 1, × 0.5 or × 0 (§8) |

If the final notional is below **$10**, reject with `BELOW_MIN_NOTIONAL`. Once caps apply, the real risk can be lower than 1% of equity. It is never higher.

### 5.4 Take-profit and trailing

| Level | Rule |
|---|---|
| TP1 | At `P_fill + 1.5 R_dist` (where `R_dist = P_fill − stop`): sell 50% of the position, move the stop to `P_fill` (breakeven). |
| TP2 / trailing | On the remaining 50%: chandelier stop `highest_close_since_entry − 2 × ATR`, ratcheted upward only. Hard target at `P_fill + 3 R_dist`. |
| Time stop | If neither TP1 nor the stop is hit within 48 bars, close everything at market. |

### 5.5 Reward-to-cost filter

Before entry, the engine estimates the round-trip cost:

```
cost_frac = 2 × fee_frac + entry_slippage_frac + exit_slippage_frac     (fractions, e.g. 0.002 = 0.20%)
cost_px   = cost_frac × P_ref                                           (cost in price units)
```

- `fee_frac` = 0.0020 with a partner JWT, 0.0045 without (0.20% + 0.25% unauthenticated surcharge).
- `entry_slippage_frac` = measured on the live quote (§7.2).
- `exit_slippage_frac` = assumed equal to entry.

Reject with `COST_TOO_HIGH` if `cost_px > 0.25 × R_dist`. In plain terms, costs may eat at most a quarter of the risk unit, otherwise the trade cannot be worth taking. The config stores percentages (`0.20`, `0.45`); the engine divides by 100.

### 5.6 How stops are executed

NEAR Intents has no resting stop orders. Stops and targets are evaluated by the agent at every tick and, between ticks, by a **price watcher** that polls the reference price every 60 seconds. A breach triggers a market exit immediately, without waiting for the candle close.

Known limitation: if the agent is offline, open positions are unprotected. The per-position cap (25% of equity) bounds the damage. A liveness alert fires if no heartbeat is written for 5 minutes.

## 6. Portfolio limits and circuit breakers

| Rule | Default | Effect | Reset |
|---|---|---|---|
| Daily loss limit | Realised + unrealised PnL since 00:00 UTC ≤ −3% of start-of-day equity | No new entries; exits still run | Next UTC day, automatic |
| Max drawdown (kill switch) | Equity ≤ 90% of peak equity | Close all positions, call `pause()` on the contract | **Owner only** |
| Max trades per day | 6 entries | No new entries | Next UTC day |
| Cooldown after stop-out | 3 bars on the same asset | No new entry on that asset | Automatic |
| Stale data | Last candle older than 1.5 bars | No new entries; exits use freshest price | Automatic |

Exits are never blocked by any of these rules.

## 7. Pre-trade execution checks

Run on every proposal, entries and exits alike, right after the quote.

### 7.1 Quote request

| Field | Value |
|---|---|
| `swapType` | `EXACT_INPUT` |
| `depositType` / `recipientType` / `refundType` | `INTENTS` |
| `slippageTolerance` | 50 bps for entries; 150 bps for exits |
| `deadline` | now + 2 minutes |
| `dry` | `true` in paper mode, `false` in live mode |

Exits accept a wider tolerance, because failing to exit is worse than exiting slightly worse.

### 7.2 Checks

| Check | Rule | Reject reason |
|---|---|---|
| Price sanity | `|P_q − P_ref| / P_ref ≤ 1%`, where `P_q` is the price implied by `amountIn / amountOut` | `QUOTE_PRICE_DEVIATION` |
| Slippage | `(P_q − P_ref) / P_ref` for buys (inverse for sells) ≤ tolerance | `SLIPPAGE_TOO_HIGH` |
| Quote freshness | Quote younger than 30 s at execution time | `QUOTE_EXPIRED` (re-quote once) |
| Balance | Origin balance in Intents ≥ `amountIn` | `INSUFFICIENT_BALANCE` |
| Idempotency | `(asset, barTime, reason)` not already executed | `DUPLICATE` |
| Contract policy (Tier 2) | Amount within on-chain caps; contract not paused | `POLICY_DENIED` |

For exits, a failed check triggers one re-quote with a wider tolerance (250 bps). If that fails too, the agent pauses entries and raises an alert, but keeps retrying the exit every 60 s.

## 8. LLM veto

Called once per entry proposal, after every check in §7 has passed. Never called for exits.

**Input** (numbers and fixed fields only, no external free text): asset, proposed notional, stop and targets, all signal evidence, last 24 closes, regime, correlation, today's PnL, open exposure.

**Output** (Zod-validated):

```json
{ "verdict": "approve" | "reduce" | "reject",
  "sizeMultiplier": 1 | 0.5 | 0,
  "rationale": "string, max 400 characters" }
```

| Situation | Effect on size |
|---|---|
| `approve` | × 1 |
| `reduce` | × 0.5 |
| `reject` | × 0 (no trade, outcome `REJECT`, reason `LLM_VETO`) |
| Timeout (10 s), API error, invalid JSON, inconsistent verdict/multiplier | × 0.5, `llm.verdict = "reduce"`, reason recorded |

The multiplier is applied last, after every cap in §5.3, so the LLM can only reduce a trade.

## 9. Reject reasons

```ts
type RejectReason =
  | "INSUFFICIENT_CONFLUENCE" | "VETO_RSI_EXHAUSTION" | "VETO_BTC_REGIME"
  | "POSITION_OPEN" | "COOLDOWN" | "STALE_DATA"
  | "STOP_TOO_WIDE" | "BELOW_MIN_NOTIONAL" | "COST_TOO_HIGH"
  | "DAILY_LOSS_LIMIT" | "MAX_TRADES_PER_DAY" | "KILL_SWITCH"
  | "QUOTE_PRICE_DEVIATION" | "SLIPPAGE_TOO_HIGH" | "QUOTE_EXPIRED"
  | "INSUFFICIENT_BALANCE" | "DUPLICATE" | "POLICY_DENIED" | "LLM_VETO";
```

## 10. Order of evaluation

For each tick:

1. Refresh data. If stale, flag it (no entries).
2. Update equity, peak equity, day PnL. Apply the kill switch first.
3. **Manage open positions**: stop, TP1, chandelier trailing, TP2, time stop. Exits go to §7 checks, then execution.
4. Check portfolio limits (§6). If any blocks entries, record `HOLD` with the reason and stop.
5. For each asset in a fixed order (`BTC`, then `NEAR`): compute signals (§3), convergence (§4), sizing (§5), quote, checks (§7), LLM veto (§8).
6. Build, hash and anchor the `DecisionRecord`; then execute.

The fixed asset order and the closed-candle rule make step 5 fully deterministic, which is what lets `verify` reproduce a decision.

## 11. Default configuration

```ts
export const defaultRiskConfig = {
  timeframes: { exec: "1h", regime: "4h" },
  warmupBars: { exec: 200, regime: 60 },
  indicators: { rsi: 14, atr: 14, bb: { n: 20, k: 2 }, regimeEma: 50, corrWindow: 48 },
  signals: {
    squeeze: { lookback: 120, percentile: 0.2, recentBars: 5 },
    breakoutBodyRatio: 0.5,
    rsiMomentum: [55, 75], rsiExhaustion: 80,
    fvg: { maxAgeBars: 24, minSizeAtr: 0.25, maxDistanceAtr: 1.5 },
    corrThreshold: 0.6,
  },
  convergence: { minConfirmations: 2 },
  sizing: {
    riskPerTradePct: 1.0, maxPositionPct: 25, maxExposurePct: 50, minNotionalUsd: 10,
    stopAtrMult: 1.5, stopFvgBufferAtr: 0.1, minStopAtr: 0.5, maxStopAtr: 3,
  },
  exits: { tp1R: 1.5, tp1Fraction: 0.5, trailAtr: 2, tp2R: 3, timeStopBars: 48 },
  costs: { feePctAuthenticated: 0.20, feePctUnauthenticated: 0.45, maxCostFractionOfR: 0.25 },
  limits: {
    dailyLossPct: 3, maxDrawdownPct: 10, maxEntriesPerDay: 6, cooldownBars: 3, staleBars: 1.5,
  },
  execution: {
    slippageBps: { entry: 50, exit: 150, exitRetry: 250 },
    priceDeviationPct: 1, quoteTtlSec: 30, deadlineSec: 120, watcherPollSec: 60,
  },
  llm: { timeoutMs: 10_000, fallbackMultiplier: 0.5, maxRationaleChars: 400 },
} as const;
```

## 12. Test plan

| Test | Kind |
|---|---|
| Each indicator matches a hand-checked reference series | Unit |
| Every signal fires and does not fire on crafted candle sequences | Unit |
| Size never exceeds any cap; risk never exceeds `riskPerTradePct` | Property-based (fast-check) |
| LLM multiplier never increases size | Property-based |
| Exits are produced even when daily loss, max trades or kill switch are active | Unit |
| Same inputs + same config ⇒ same `DecisionRecord` hash, byte for byte | Property-based |
| `verify` succeeds on every record produced by a replay run, and fails on a tampered record | End-to-end |
| Full replay of the demo fixture produces the expected sequence of decisions | Golden file |
| Quote with 2% price deviation is rejected; exit re-quotes with wider tolerance | Unit, mocked executor |

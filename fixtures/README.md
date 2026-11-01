# Demo fixtures

Real NEARUSDT and BTCUSDT candles, frozen on 19 Oct 2026 during the preparation phase. They make `pnpm demo` and the golden tests deterministic and runnable offline.

| Set | Signal bar (1h, UTC) | What the agent must do | Why |
|---|---|---|---|
| `demo-entry` | 2026-07-20 09:00 | **Enter** NEAR | Bollinger squeeze breakout, confirmed by RSI momentum (58.1), an unfilled fair value gap and a bullish BTC regime (corr 0.67) |
| `demo-refusal` | 2026-09-20 16:00 | **Refuse** (`VETO_RSI_EXHAUSTION`) | Breakout with RSI at 82.5; NEAR fell 4.7% over the next 24 h |

Each set holds 301 one-hour candles per symbol (200 warm-up bars, the signal bar at index 200, then 100 bars) and the four-hour candles needed for the BTC regime.

## Provenance and integrity

- Source: Binance public market data, `data-api.binance.vision/api/v3/klines`, closed candles only.
- `manifest.json` lists every file with its candle count, first and last `openTime`, and the **SHA-256 of the file's exact bytes**. `src/data/fixtures.ts` refuses a set if any of these does not match, if a candle is missing, or if an unlisted file is present.
- `.gitattributes` marks these files `-text` so git never rewrites their line endings.
- The `event` block of each manifest is the selection tool's own reading of the signal bar. It is provenance, not ground truth: the engine's golden test compares against `kind`, `reason`, `confirmations` and `vetoes` only.

Do not edit these files. To change a fixture, freeze a new one and update its manifest.

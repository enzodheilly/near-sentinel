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

## Data license (not the code's)

These candles are Binance market data. Binance Vision's terms license its datasets under **CC BY-NC-SA 4.0**
(clause 3.1), allow non-commercial open-source use (clause 4.1) and require redistributed derivative works to
credit Binance Vision and keep the same license (clause 4.5); commercial use needs a separate licence (clause 3.4)
([Binance Vision Terms of Use](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf)). So:

- **Attribution:** market data © Binance, from Binance Vision / `data-api.binance.vision`.
- **License of the files in `fixtures/`** (and of candles embedded in the decision explorer): CC BY-NC-SA 4.0,
  https://creativecommons.org/licenses/by-nc-sa/4.0/. Non-commercial use only.
- The NEAR Sentinel **code** keeps its own license; this note covers only the market data.
- We keep the minimum: two windows of 301 hourly candles per symbol, needed to make every demo decision
  re-verifiable offline. Live candles (`data/candles/`) are never committed.

If the data cannot stay public, the fallback is to delete these files and fetch the same windows from
`data-api.binance.vision`: `manifest.json` already pins each file's SHA-256, so a re-fetched file is checked byte
for byte before use.

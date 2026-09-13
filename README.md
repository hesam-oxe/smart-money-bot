# Smart Money Bot — 15m UT-Bot + SMC paper trader

A working, paper-only 15-minute trading bot that blends a **UT-Bot ATR-trailing core**
(classic + adaptive) with **Smart Money Concepts** (swings, BOS/CHoCH, double-validated
order blocks, fair value gaps, S/R zones), a 10-filter anti-noise stack, a 7-engine
confidence score with z-score ranking, structural anti-stop-hunt risk plans, trade-duration
forecasts, Telegram alerts, and an HTML cockpit dashboard.

> **Paper trading only.** This bot never places orders. It watches public market data,
> simulates fills, and prints/logs alerts. Tinker, backtest, and forward-test on paper
> before you risk a cent. Not financial advice — crypto is risky, past performance
> proves nothing.

## How it works (per 15m candle, bar-close only — no repaint)

1. **UT-Bot core** — ATR × sensitivity ratcheting trailing stop, classic or adaptive
   (Kaufman efficiency ratio + volume + volatility regime tighten/loosen the trail).
2. **Regime & trend guard** — EMA 200 alignment, rolling + flip-anchored VWAP side,
   ADX strength with DI agreement, optional 1h EMA-bias confirmation.
3. **Smart Money reading** — zigzag swings, BOS/CHoCH bias, order blocks that must
   prove themselves two ways (FVG overlap **or** volume spike), fair value gaps,
   swing-cluster S/R zones (causal — no future data leaks into signals).
4. **Fake-signal filter stack** — ADX regime, EMA200, VWAP, MTF, volume, full-candle,
   volatility band, cooldown, zone-proximity, and structure agreement. Most flips die
   here — that is the point. A 2-bar confirmation kills 1-bar whipsaws.
5. **Confidence + ranking** — seven engines (UT distance, SuperTrend, structure,
   ADX, MTF, volume, RSI) score 0–100; a z-score vs. recent history ranks signals
   so the strongest prints first.
6. **Plan & forecast** — structural anti-stop-hunt SL (below/above the swing with a
   buffer, ATR fallback), four R-multiple targets, risk-% sizing, and an EWMA +
   survival-table duration forecast that doubles as a time stop.
7. **Paper broker** — next-open fills, SL-checked-first intrabar exits, fees, equity
   curve, full stats (win rate, profit factor, expectancy, log returns).

## Quick start

```bash
npm install
npm run backtest                  # 15m backtest, XBTUSD + ETHUSD, ~7.5 days
npm run backtest -- --fresh       # skip the 6h disk cache
npm run backtest -- --pair SOLUSD # single pair
PAIRS=SOLUSD,DOGEUSD npm run backtest
npm run paper                     # paper-live loop (polls Kraken, Telegram alerts)
npm run paper -- --once           # single poll, then exit
npm run dashboard                 # cockpit UI -> http://localhost:8080
npm test                          # vitest suite (35 tests)
```

Zero API keys needed — the default Kraken provider uses public OHLC endpoints.
Note: Kraken caps public OHLC at the latest 720 bars (~7.5 days on 15m), so each
backtest covers about a week; live paper trading is unaffected (history accumulates).

## Configuration (`.env`)

Copy `.env.example` to `.env` — every knob is there with defaults:

| Key | Default | Meaning |
|---|---|---|
| `PROVIDER` | `kraken` | `kraken` (public, default) or `binance` |
| `PAIRS` | `XBTUSD,ETHUSD` | comma-separated Kraken pairs |
| `TIMEFRAME` | `15` | minutes per bar |
| `CLASSIC_UT` | `false` | `true` = classic UT trail (no adaptive layer) |
| `USE_ADX` / `ADX_MIN` | `true` / `12` | ADX regime filter + DI agreement |
| `USE_EMA_TREND` | `true` | close must agree with EMA200 side |
| `USE_VWAP` | `true` | close must agree with rolling + anchored VWAP |
| `USE_MTF` | `true` | 1h EMA50/200 bias agreement (`--no-mtf` to skip once) |
| `USE_VOLUME` / `VOL_MIN` | `true` / `1.0` | flip-bar volume vs 20-bar average |
| `USE_ZONE_FILTER` | `true` | veto entries into multi-touch S/R |
| `TWO_BAR_CONFIRM` | `true` | confirm the flip on the next close |
| `MIN_CONFIDENCE` | `40` | minimum 0–100 score to emit |
| `SL_METHOD` | `structural` | `structural` / `atr` / `scaled` / `smart` / `safer` / `percent` |
| `HUNT_MULT` / `ATR_MULT` | `0.5` / `1.3` | stop-hunt buffer / ATR stop distance |
| `EQUITY` / `RISK_PCT` | `10000` / `1` | paper equity / risk per trade % |
| `TP_CHOICE` | `2` | which R-target (0–3) the paper broker aims for |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | alerts (console fallback when empty) |
| `POLL_SEC` / `DASH_PORT` | `60` / `8080` | live poll interval / dashboard port |

## Telegram alerts

Set the two `TELEGRAM_*` vars (env or `.env`) and every fresh signal + every paper
close is pushed to your chat automatically. Without them, alerts print to the console.

## Project layout

| Path | What lives there |
|---|---|
| `src/data.ts` | Kraken + Binance public providers, 6h disk cache, HTF fetch |
| `src/indicators.ts` | EMA/RMA/ATR/RSI/ADX/SuperTrend/Kaufman-ER/UT-Bot/VWAP, zero deps |
| `src/smc.ts` | swings, BOS/CHoCH, order blocks, FVG, S/R zones |
| `src/risk.ts` | stop methods, R targets, sizing, trade stats |
| `src/strategy.ts` | signal engine: flips → filters → confidence → plan → forecast → z-rank |
| `src/paper.ts` | paper broker + equity curve |
| `src/telegram.ts` | Bot API alerts with console fallback |
| `src/backtest.ts` | backtest CLI |
| `src/live.ts` | paper-live polling loop |
| `src/dashboard.ts` | zero-dep HTTP server + JSON APIs |
| `public/index.html` | cockpit dashboard UI |
| `tests/` | vitest suites + seeded synthetic markets |

## Paper-live vs backtest

- `npm run backtest` — historical simulation over the cached 720 closed candles,
  one run, full stats, results in `results/`.
- `npm run paper` — live loop: every `POLL_SEC` seconds it fetches fresh bars, runs
  the engine with compounding sizes, keeps one paper position per pair in
  `results/live-state.json`, prints signals and Telegram-alerts them.

## What to expect

The filter stack is deliberately strict: in choppy markets most UT flips are
rejected (often 90%+) and the bot stays quiet — silence is a feature, not a bug.
Signals cluster in trending legs with pullback-continuation structure. Always
forward-test on paper; a week of backtest is not evidence of an edge.

## Disclaimer

Educational software. Markets eat clever bots for breakfast. The authors take no
responsibility for any trading losses. Start on paper, stay on paper until you have
months of evidence, and never trade money you cannot afford to lose.

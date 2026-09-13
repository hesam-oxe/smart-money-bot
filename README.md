# Smart Money Bot — 15m UT-Bot + SMC paper trader

[![quality](https://github.com/hesam-oxe/smart-money-bot/actions/workflows/quality.yml/badge.svg)](https://github.com/hesam-oxe/smart-money-bot/actions/workflows/quality.yml)

A working, paper-only 15-minute trading bot that blends a **UT-Bot ATR-trailing core**
(classic + adaptive) with **Smart Money Concepts** (swings, BOS/CHoCH, double-validated
order blocks, fair value gaps, S/R zones), a 14-filter anti-noise stack, a 7-engine
confidence score with z-score ranking, structural anti-stop-hunt risk plans, trade-duration
forecasts, Telegram alerts, and an HTML cockpit dashboard.

> **Paper trading only.** This bot never places orders. It watches public market data,
> simulates fills, and prints/logs alerts. Tinker, backtest, and forward-test on paper
> before you risk a cent. Not financial advice — crypto is risky, past performance
> proves nothing.

## How it works (per 15m candle, bar-close only — no repaint)

1. **UT-Bot core** — ATR × sensitivity ratcheting trailing stop, classic or adaptive
   (Kaufman efficiency ratio + volume + volatility regime tighten/loosen the trail).
   1-click style presets (Scalping → Position) match sensitivity/ATR/stop to horizon.
2. **Regime & trend guard** — market-regime shutdown (BTC 15m ADX floor), EMA 200
   alignment, rolling + flip-anchored VWAP side, ADX strength with DI agreement,
   multi-timeframe EMA 9/21 confluence across up to 5 higher timeframes.
3. **Smart Money reading** — zigzag swings, BOS/CHoCH bias, order blocks that must
   prove themselves two ways (FVG overlap **or** volume spike), fair value gaps,
   swing-cluster S/R zones (causal, broken levels drop off — no future data leaks).
4. **Fake-signal filter stack** — regime, ADX, EMA200, VWAP, MTF, volume, full-candle,
   volatility band, cooldown, zone-proximity, structure, plus opt-in RSI, SuperTrend
   and Hull confirmations. Most flips die here — that is the point. N-bar
   confirmation kills whipsaws before they print.
5. **Confidence + ranking** — seven engines (UT distance, SuperTrend, structure,
   ADX, MTF, volume, RSI) score 0–100 (💪 strong 80+ · 👍 good 60+ · ⚠️ weak 40+);
   a z-score vs. recent history ranks signals so the strongest prints first.
6. **Plan & forecast** — 7 stop methods incl. structural anti-stop-hunt SL (below/
   above the swing with a buffer, ATR fallback), four R-multiple targets, risk-%
   sizing, and a trend-duration forecast (median / EWMA / EWMA + 5 adaptive
   multipliers) with empirical survival milestones that doubles as a time stop.
7. **Paper broker** — next-open fills, SL-checked-first intrabar exits, fees, equity
   curve, full stats (win rate, profit factor, expectancy, log returns). Live
   positions bank half at TP1, move the stop to breakeven, and ride the rest to TP.

## Quick start

```bash
npm install
npm run backtest                  # 15m backtest, XBTUSD + ETHUSD, ~7.5 days
npm run backtest -- --fresh       # skip the 6h disk cache
npm run backtest -- --pair SOLUSD # single pair
PAIRS=SOLUSD,DOGEUSD npm run backtest
STYLE=swing npm run backtest      # swing preset (sens 2.0 / ATR 14)
FILTER_PRESET=lux npm run backtest # Ali's out-of-box: a signal on every flip
npm run tune -- --pair XBTUSD     # walk-forward-lite grid search (IS pick + OOS verify)
npm run paper                     # paper-live loop (polls Kraken, Telegram alerts)
npm run paper -- --once           # single poll, then exit
npm run dashboard                 # cockpit UI -> http://localhost:8080
npm test                          # vitest suite
```

Or everything at once with Docker:

```bash
cp .env.example .env
docker compose up --build   # paper-live loop + dashboard on :8080, shared ./results
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
| `TIMEFRAME` | `15` | minutes per bar (auto-picks the style preset) |
| `STYLE` | `auto` | `auto` / `scalping` / `day` / `swing` / `position` / `custom` |
| `UT_KEY` / `UT_ATR` / `CHOP` | `1.5` / `10` / `1.0` | custom-style overrides (only when `STYLE=custom`) |
| `FILTER_PRESET` | `strict` | `strict` (most filters ON) or `lux` (signals on every flip) |
| `CLASSIC_UT` | `false` | `true` = classic UT trail (no adaptive layer) |
| `USE_REGIME` / `REGIME_ADX_MIN` | `true` / `10` | block new signals while BTC 15m ADX < floor |
| `USE_ADX` / `ADX_MIN` | `true` / `12` | ADX regime filter + DI agreement |
| `USE_EMA_TREND` | `true` | close must agree with EMA200 side |
| `USE_VWAP` | `true` | close must agree with rolling + anchored VWAP |
| `USE_MTF` / `MTF_MIN_AGREE` | `true` / `0.5` | majority of HTF EMA 9/21 trends must agree |
| `USE_VOLUME` / `VOL_MIN` | `true` / `1.0` | flip-bar volume vs 20-bar average |
| `USE_ZONE_FILTER` | `true` | veto entries into standing multi-touch S/R |
| `USE_STRUCTURE` | `true` | swing-structure / BOS alignment |
| `USE_RSI_FILTER` / `USE_SUPERTREND_FILTER` / `USE_HULL_FILTER` | `false` | opt-in confirmations (fewer, stricter) |
| `CONFIRM_BARS` | `0` | N-bar confirmation (0 = auto from `TWO_BAR_CONFIRM`) |
| `MIN_CONFIDENCE` | `40` | minimum 0–100 score to emit |
| `FORECAST_MODE` | `standard` | `simple` (median) / `standard` (EWMA) / `advanced` (+5 multipliers) |
| `SL_METHOD` | `structural` | `structural` / `atr` / `scaled` / `smart` / `safer` / `percent` / `tick` |
| `HUNT_MULT` / `ATR_MULT` / `SL_TICKS` | `0.5` / `1.3` / `200` | hunt buffer / ATR stop / tick steps |
| `EQUITY` / `RISK_PCT` | `10000` / `1` | paper equity / risk per trade % |
| `TP_CHOICE` | `2` | which R-target (0–3) the paper broker aims for |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | alerts (console fallback when empty) |
| `POLL_SEC` / `DASH_PORT` | `60` / `8080` | live poll interval / dashboard port |

Style presets (auto-picked from `TIMEFRAME`, or forced via `STYLE`):

| Style | Sensitivity | ATR | Stop | Chop strength |
|---|---|---|---|---|
| Scalping (1–5m) | 1.0 | 7 | ATR ×1.0 | strong |
| Day (15m–1h) | 1.5 | 10 | ATR ×1.3 | normal |
| Swing (4h–D) | 2.0 | 14 | ATR ×1.8 | soft |
| Position (D–W) | 2.5 | 20 | ATR ×2.3 | softest |

## Tuning without fooling yourself

`npm run tune` grid-searches sensitivity × ADX × min-confidence on the **first** half
of history, then reports the winners on the **second** half they never saw:

```bash
npm run tune -- --pair XBTUSD
```

In-sample darlings usually wilt out-of-sample — that gap is the most honest number
in the repo. Trust OOS expectancy, not IS. Full grid lands in `results/tune-*.json`.

## Outputs (`results/`, git-ignored)

| File | What it is |
|---|---|
| `backtest-<PAIR>.json` | signals, trades, stats, zones, order blocks, MTF row, candle tail |
| `trades-<PAIR>.csv` | trade log — opens in Excel / Google Sheets |
| `equity-<PAIR>.json` | per-bar equity curve for the dashboard |
| `portfolio.json` | multi-pair aggregate (independent sims, PnL summed) |
| `tune-<PAIR>.json` | full tuning grid with IS/OOS scores |
| `signals.jsonl` | merged signal tape (dashboard + live append here) |
| `live-state.json` | paper-live equity, open positions, seen signals |

## Telegram alerts

Set the two `TELEGRAM_*` vars (env or `.env`) and every fresh signal (with its
confidence band: 💪/👍/⚠️/🚫), partial TP, breakeven move, and paper close is pushed
to your chat automatically. Without them, alerts print to the console.

## Project layout

| Path | What lives there |
|---|---|
| `src/data.ts` | Kraken + Binance public providers, 6h disk cache, HTF fetch |
| `src/indicators.ts` | EMA/RMA/WMA/Hull/ATR/RSI/ADX/SuperTrend/Kaufman-ER/UT-Bot/VWAP, zero deps |
| `src/mtf.ts` | multi-TF EMA 9/21 confluence tapes + dashboard snapshot |
| `src/smc.ts` | swings, BOS/CHoCH, order blocks, FVG, S/R zones |
| `src/risk.ts` | 7 stop methods, R targets, sizing, trade stats |
| `src/strategy.ts` | signal engine: flips → filters → confidence → plan → forecast → z-rank |
| `src/paper.ts` | paper broker + equity curve |
| `src/positions.ts` | live position ladder: SL-first, TP1 banks half + breakeven (pure, tested) |
| `src/telegram.ts` | Bot API alerts with console fallback |
| `src/backtest.ts` | backtest CLI (+ CSV export, portfolio aggregate, regime tape) |
| `src/tune.ts` | walk-forward-lite parameter tuner |
| `src/live.ts` | paper-live polling loop |
| `src/dashboard.ts` | zero-dep HTTP server + JSON APIs |
| `public/index.html` | cockpit dashboard UI (candles + zones + order blocks + MTF + signals) |
| `tests/` | vitest suites + seeded synthetic markets |

## Paper-live vs backtest

- `npm run backtest` — historical simulation over the cached 720 closed candles,
  one run, full stats, results in `results/`.
- `npm run paper` — live loop: every `POLL_SEC` seconds it fetches fresh bars, runs
  the engine with compounding sizes, keeps one paper position per pair in
  `results/live-state.json`, prints signals and Telegram-alerts them.

Note: the backtest broker aims at a single R-target per trade, while live positions
work a ladder (half off at TP1 + breakeven stop). Live and backtest PnL will differ
slightly by design — the backtest is the conservative case.

## What to expect

The filter stack is deliberately strict: in choppy markets most UT flips are
rejected (often 90%+) and the bot stays quiet — silence is a feature, not a bug.
When BTC itself stops trending, the regime guard shuts down new signals on every
pair. Signals cluster in trending legs with pullback-continuation structure. Always
forward-test on paper; a week of backtest is not evidence of an edge.

## Disclaimer

Educational software. Markets eat clever bots for breakfast. The authors take no
responsibility for any trading losses. Start on paper, stay on paper until you have
months of evidence, and never trade money you cannot afford to lose.

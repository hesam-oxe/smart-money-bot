#!/usr/bin/env tsx
/**
 * Backtest CLI: fetch 15m (+HTF) bars, run the engine, paper-trade, report.
 * Usage: npm run backtest -- --pair XBTUSD --fresh
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCandles } from './data.js';
import { adx } from './indicators.js';
import {
  PRESET_15M,
  STYLE_PRESETS,
  rankSignals,
  runEngine,
  styleForTimeframe,
  type ForecastMode,
  type StrategyConfig,
  type TradingStyle,
} from './strategy.js';
import { loadMtfTapes, mtfSnapshot, type MtfTape } from './mtf.js';
import { runPaper } from './paper.js';
import { loadConfig, loadDotEnv, type AppConfig } from './config.js';
import type { SLMethod } from './risk.js';
import type { BacktestStats, Candle, Trade } from './types.js';

export interface BacktestCLIOpts {
  pairs?: string[];
  fresh?: boolean;
  log?: boolean;
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      out[k] = v;
    }
  }
  return out;
}

export function strategyFromApp(c: AppConfig): StrategyConfig {
  const methods = ['structural', 'atr', 'scaled', 'smart', 'safer', 'percent', 'tick'];
  const modes = ['simple', 'standard', 'advanced'];
  const lux = c.filterPreset.toLowerCase() === 'lux';
  const want = c.style.toLowerCase();
  type ResolvedStyle = Exclude<TradingStyle, 'auto'>;
  const style: ResolvedStyle = want === 'auto'
    ? styleForTimeframe(c.timeframeMin)
    : (['scalping', 'day', 'swing', 'position', 'custom'].includes(want) ? (want as ResolvedStyle) : 'day');
  const preset = style === 'custom'
    ? { utKey: c.utKey, utAtrLen: Math.round(c.utAtrLen), atrMult: c.atrMult, chopStrength: c.chopStrength }
    : STYLE_PRESETS[style];
  const confirmBars = c.confirmBars > 0 ? Math.round(c.confirmBars) : c.twoBarConfirm ? 2 : 1;
  return {
    ...PRESET_15M,
    style,
    utKey: preset.utKey,
    utAtrLen: preset.utAtrLen,
    atrMult: preset.atrMult,
    chopStrength: preset.chopStrength,
    classicUt: c.classicUt,
    useAdx: lux ? false : c.useAdx,
    adxMin: c.adxMin,
    useEmaTrend: lux ? false : c.useEmaTrend,
    useVwap: lux ? false : c.useVwap,
    useMtf: lux ? false : c.useMtf,
    mtfMinAgree: c.mtfMinAgree,
    useRegime: lux ? false : c.useRegime,
    regimeAdxMin: c.regimeAdxMin,
    useVolume: lux ? false : c.useVolume,
    volMin: c.volMin,
    useFullCandle: lux ? false : c.useFullCandle,
    useZoneFilter: lux ? false : c.useZoneFilter,
    useVolatility: lux ? false : c.useVolatility,
    useStructure: lux ? false : c.useStructure,
    useRsiFilter: lux ? false : c.useRsiFilter,
    useSupertrendFilter: lux ? false : c.useSupertrendFilter,
    useHullFilter: lux ? false : c.useHullFilter,
    cooldownBars: c.cooldownBars,
    confirmBars,
    minConfidence: lux ? 0 : c.minConfidence,
    forecastMode: (modes.includes(c.forecastMode) ? c.forecastMode : 'standard') as ForecastMode,
    slMethod: (methods.includes(c.slMethod) ? c.slMethod : 'structural') as SLMethod,
    huntMult: c.huntMult,
    slTicks: c.slTicks,
    equity: c.equity,
    riskPct: c.riskPct,
  };
}

/** BTC pair spellings across the supported venues. */
const BTC_PAIRS = new Set(['XBTUSD', 'XXBTZUSD', 'BTCUSD', 'BTCUSDT', 'XBTUSDT']);

/**
 * Market-regime tape: 15m ADX(14) of BTC, time-aligned to `bars`.
 * BTC-chop shuts down new signals on every pair (the regime guard).
 * Returns null when the tape is unavailable (guard runs neutral).
 */
export async function loadRegimeADX(
  app: AppConfig,
  pair: string,
  bars: Candle[],
  fresh: boolean,
): Promise<(number | null)[] | null> {
  try {
    if (BTC_PAIRS.has(pair.toUpperCase())) return adx(bars, 14).adx;
    const btc = (await loadCandles(app.provider, 'XBTUSD', app.timeframeMin, { fresh })).closed;
    const ax = adx(btc, 14).adx;
    const byTime = new Map(btc.map((c, i) => [c.time, ax[i] ?? null] as [number, number | null]));
    return bars.map((c) => byTime.get(c.time) ?? null);
  } catch {
    return null;
  }
}

export interface PairResult {
  pair: string;
  bars: number;
  flips: number;
  signals: number;
  stats: BacktestStats;
}

export async function runBacktest(cli: BacktestCLIOpts = {}): Promise<Record<string, unknown>[]> {
  await loadDotEnv();
  const app = loadConfig();
  const a = args();
  const pairs = cli.pairs ?? (a['pair'] ? [a['pair']] : app.pairs);
  const fresh = cli.fresh ?? (a['fresh'] !== undefined ? a['fresh'] === 'true' : app.fresh);
  const verbose = cli.log ?? true;
  const strat = strategyFromApp(app);
  if (a['min-conf']) strat.minConfidence = Number(a['min-conf']);
  if (a['classic']) strat.classicUt = true;
  if (a['no-mtf']) strat.useMtf = false;
  await mkdir('results', { recursive: true });

  const summaries: Record<string, unknown>[] = [];
  const perPair: PairResult[] = [];
  const allSignals: string[] = [];

  for (const pair of pairs) {
    if (verbose) console.log(`\n═══ ${pair} ${app.timeframeMin}m (${app.provider}) [${strat.style}] ═══`);
    const m15 = await loadCandles(app.provider, pair, app.timeframeMin, { fresh });
    let tapes: MtfTape[] = [];
    try {
      tapes = await loadMtfTapes(app.provider, pair, app.timeframeMin, fresh);
    } catch {
      /* none */
    }
    if (!tapes.length && verbose) console.log('  (no HTF tapes — MTF runs neutral)');
    const regime = strat.useRegime ? await loadRegimeADX(app, pair, m15.closed, fresh) : null;
    if (verbose) console.log(`  bars: ${m15.closed.length} closed`);

    const eng = runEngine(m15.closed, tapes, pair, strat, regime);
    const paper = runPaper(m15.closed, eng.signals, {
      equity0: app.equity,
      feeBps: app.feeBps,
      tpIndex: app.tpChoice,
      useTimeStop: true,
    });
    const s = paper.stats;
    const ranked = rankSignals(eng.signals);

    // blocked reasons summary
    const reasons = new Map<string, number>();
    for (const b of eng.blocked) for (const r of b.blockedBy) reasons.set(r.split('(')[0]!, (reasons.get(r.split('(')[0]!) ?? 0) + 1);
    const topReasons = [...reasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);

    if (verbose) {
      console.log(`  flips: ${eng.flips} | signals: ${eng.signals.length} | blocked: ${eng.blocked.length}`);
      console.log(`  trades: ${s.trades} | win ${s.winRate.toFixed(1)}% | PF ${fmtN(s.profitFactor)} | expR ${s.expectancyR.toFixed(2)}`);
      console.log(`  PnL $${s.totalPnl.toFixed(2)} (${s.totalReturnPct.toFixed(2)}%) | logRet ${s.totalLogReturn.toFixed(4)} | maxDD ${s.maxDrawdownPct.toFixed(1)}%`);
      console.log('  ── top signals by z-score ──');
      for (const sg of ranked.slice(0, 5)) {
        console.log(
          `  ${sg.side.toUpperCase().padEnd(5)} ${new Date(sg.time).toISOString().slice(5, 16)} ` +
            `entry ${sg.entry} sl ${sg.sl.toFixed(2)} conf ${sg.confidence} z ${sg.z >= 0 ? '+' : ''}${sg.z}`,
        );
      }
      if (topReasons.length) console.log('  blocked by:', topReasons.map(([r, n]) => `${r}×${n}`).join(', '));
    }

    const safe = pair.replace(/[^A-Za-z0-9]/g, '');
    const tail = m15.closed.slice(-240);
    const payload = {
      pair,
      timeframeMin: app.timeframeMin,
      provider: app.provider,
      generatedAt: new Date().toISOString(),
      bars: m15.closed.length,
      flips: eng.flips,
      stats: s,
      signals: eng.signals,
      trades: paper.trades,
      blockedSummary: { count: eng.blocked.length, topReasons },
      zones: eng.zones.slice(0, 12),
      orderBlocks: eng.orderBlocks.slice(0, 12),
      mtf: mtfSnapshot(tapes),
      tailFrom: m15.closed.length - tail.length,
      candlesTail: tail,
    };
    await writeFile(`results/backtest-${safe}.json`, JSON.stringify(payload));
    await writeFile(`results/equity-${safe}.json`, JSON.stringify(paper.equityCurve));
    await writeFile(`results/trades-${safe}.csv`, tradesCsv(paper.trades));
    for (const sg of eng.signals) allSignals.push(JSON.stringify(sg));
    summaries.push({ pair, bars: m15.closed.length, flips: eng.flips, signals: eng.signals.length, stats: s });
    perPair.push({ pair, bars: m15.closed.length, flips: eng.flips, signals: eng.signals.length, stats: s });
  }

  // merged ranked signal tape for the dashboard
  const prev = await readLines('results/signals.jsonl');
  const merged = new Map<string, string>();
  for (const line of prev) {
    try {
      merged.set((JSON.parse(line) as { id: string }).id, line);
    } catch { /* skip */ }
  }
  for (const line of allSignals) merged.set((JSON.parse(line) as { id: string }).id, line);
  const sorted = [...merged.values()]
    .map((l) => JSON.parse(l) as { time: number })
    .sort((x, y) => x.time - y.time)
    .map((o) => JSON.stringify(o));
  await writeFile('results/signals.jsonl', sorted.join('\n') + (sorted.length ? '\n' : ''));

  // portfolio aggregate (pairs are simulated independently, each with full equity)
  const portfolio = buildPortfolio(perPair, app.equity);
  await writeFile('results/portfolio.json', JSON.stringify(portfolio, null, 1));
  if (verbose) {
    console.log('\n═══ PORTFOLIO (independent per-pair sims, PnL summed) ═══');
    console.log(
      `  pairs ${portfolio.pairs} | trades ${portfolio.trades} | win ${portfolio.winRate.toFixed(1)}% ` +
        `| PnL $${portfolio.totalPnl.toFixed(2)} | avgExpR ${portfolio.avgExpectancyR.toFixed(2)}`,
    );
    console.log(`  best ${portfolio.bestPair} ($${portfolio.bestPnl.toFixed(0)}) · worst ${portfolio.worstPair} ($${portfolio.worstPnl.toFixed(0)})`);
    console.log(`\n✔ wrote results/ (${sorted.length} signals on tape)`);
  }
  return summaries;
}

/** Aggregate per-pair stats. Pairs run as independent sims; PnL is summed, not compounded. */
export interface PortfolioSummary {
  pairs: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  totalReturnPct: number;
  avgExpectancyR: number;
  bestPair: string;
  bestPnl: number;
  worstPair: string;
  worstPnl: number;
}

export function buildPortfolio(perPair: PairResult[], equity0: number): PortfolioSummary {
  const trades = perPair.reduce((a, p) => a + p.stats.trades, 0);
  const wins = perPair.reduce((a, p) => a + p.stats.wins, 0);
  const totalPnl = perPair.reduce((a, p) => a + p.stats.totalPnl, 0);
  const avgExpectancyR = perPair.length
    ? perPair.reduce((a, p) => a + p.stats.expectancyR, 0) / perPair.length
    : 0;
  const byPnl = [...perPair].sort((x, y) => y.stats.totalPnl - x.stats.totalPnl);
  return {
    pairs: perPair.length,
    trades,
    wins,
    winRate: trades ? (wins / trades) * 100 : 0,
    totalPnl,
    totalReturnPct: ((totalPnl / equity0) / Math.max(1, perPair.length)) * 100,
    avgExpectancyR,
    bestPair: byPnl[0]?.pair ?? '-',
    bestPnl: byPnl[0]?.stats.totalPnl ?? 0,
    worstPair: byPnl[byPnl.length - 1]?.pair ?? '-',
    worstPnl: byPnl[byPnl.length - 1]?.stats.totalPnl ?? 0,
  };
}

/** Spreadsheet-friendly trade log (opens in Excel / Google Sheets). */
export function tradesCsv(trades: Trade[]): string {
  const head = 'pair,side,entryTime,entry,exitTime,exit,exitReason,size,pnl,pnlPct,rMultiple,fees';
  const rows = trades.map((t) =>
    [
      t.pair, t.side, new Date(t.entryTime).toISOString(), t.entry,
      new Date(t.exitTime).toISOString(), t.exit, t.exitReason, t.size,
      t.pnl.toFixed(2), t.pnlPct.toFixed(3), t.rMultiple.toFixed(3), t.fees.toFixed(4),
    ].join(','),
  );
  return [head, ...rows].join('\n') + '\n';
}

async function readLines(path: string): Promise<string[]> {
  try {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fmtN(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(2);
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMain()) {
  runBacktest().catch((e) => {
    console.error('backtest failed:', (e as Error).message);
    process.exit(1);
  });
}

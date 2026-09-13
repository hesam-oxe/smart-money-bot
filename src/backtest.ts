#!/usr/bin/env tsx
/**
 * Backtest CLI: fetch 15m (+1h) bars, run the engine, paper-trade, report.
 * Usage: npm run backtest -- --pair XBTUSD --fresh
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCandles } from './data.js';
import { PRESET_15M, rankSignals, runEngine, type StrategyConfig } from './strategy.js';
import { runPaper } from './paper.js';
import { loadConfig, loadDotEnv, type AppConfig } from './config.js';
import type { SLMethod } from './risk.js';

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
  const methods = ['structural', 'atr', 'scaled', 'smart', 'safer', 'percent'];
  return {
    ...PRESET_15M,
    classicUt: c.classicUt,
    useAdx: c.useAdx,
    adxMin: c.adxMin,
    useEmaTrend: c.useEmaTrend,
    useVwap: c.useVwap,
    useMtf: c.useMtf,
    useVolume: c.useVolume,
    volMin: c.volMin,
    useFullCandle: c.useFullCandle,
    useZoneFilter: c.useZoneFilter,
    useVolatility: c.useVolatility,
    cooldownBars: c.cooldownBars,
    twoBarConfirm: c.twoBarConfirm,
    minConfidence: c.minConfidence,
    slMethod: (methods.includes(c.slMethod) ? c.slMethod : 'structural') as SLMethod,
    huntMult: c.huntMult,
    atrMult: c.atrMult,
    equity: c.equity,
    riskPct: c.riskPct,
  };
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
  const allSignals: string[] = [];

  for (const pair of pairs) {
    if (verbose) console.log(`\n═══ ${pair} ${app.timeframeMin}m (${app.provider}) ═══`);
    const m15 = await loadCandles(app.provider, pair, app.timeframeMin, { fresh });
    let h1 = null;
    try {
      h1 = (await loadCandles(app.provider, pair, 60, { fresh })).closed;
    } catch {
      if (verbose) console.log('  (no 1H tape — MTF runs neutral)');
    }
    if (verbose) console.log(`  bars: ${m15.closed.length} closed`);

    const eng = runEngine(m15.closed, h1, pair, strat);
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
      candlesTail: m15.closed.slice(-240),
    };
    await writeFile(`results/backtest-${safe}.json`, JSON.stringify(payload));
    await writeFile(`results/equity-${safe}.json`, JSON.stringify(paper.equityCurve));
    for (const sg of eng.signals) allSignals.push(JSON.stringify(sg));
    summaries.push({ pair, bars: m15.closed.length, flips: eng.flips, signals: eng.signals.length, stats: s });
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
  if (verbose) console.log(`\n✔ wrote results/ (${sorted.length} signals on tape)`);
  return summaries;
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

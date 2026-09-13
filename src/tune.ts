#!/usr/bin/env tsx
/**
 * Walk-forward-lite tuner: grid-search on the FIRST half of history (in-sample),
 * then verify the winners on the SECOND half (out-of-sample). Honest by
 * construction — picks never see the verification bars.
 * Usage: npm run tune -- --pair XBTUSD [--fresh]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCandles } from './data.js';
import { loadConfig, loadDotEnv } from './config.js';
import { strategyFromApp } from './backtest.js';
import { runEngine } from './strategy.js';
import { runPaper } from './paper.js';
import type { Candle } from './types.js';

interface Combo {
  utKey: number;
  adxMin: number;
  minConfidence: number;
}

interface Scored extends Combo {
  isTrades: number;
  isExpR: number;
  oosTrades: number;
  oosExpR: number;
  oosPnl: number;
}

const GRID: Combo[] = [];
for (const utKey of [1.0, 1.5, 2.0]) {
  for (const adxMin of [10, 14]) {
    for (const minConfidence of [35, 50]) {
      GRID.push({ utKey, adxMin, minConfidence });
    }
  }
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

const fmtR = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(2);

export async function runTune(): Promise<Scored[]> {
  await loadDotEnv();
  const app = loadConfig();
  const a = args();
  const pair = a['pair'] ?? app.pairs[0] ?? 'XBTUSD';
  const fresh = a['fresh'] === 'true';

  const m15 = (await loadCandles(app.provider, pair, app.timeframeMin, { fresh })).closed;
  let h1: Candle[] | null = null;
  try {
    h1 = (await loadCandles(app.provider, pair, 60, { fresh })).closed;
  } catch {
    console.log('(no 1H tape — MTF runs neutral)');
  }
  const n = m15.length;
  if (n < 500) {
    console.log(`not enough bars (${n}) — need 500+ for a 50/50 split`);
    return [];
  }
  const mid = Math.floor(n / 2);
  const splitTime = m15[mid]!.time;
  const isBars = m15.slice(0, mid);
  const oosBars = m15.slice(Math.max(0, mid - 220)); // 220-bar warm prefix; only post-split signals count
  const paperOpts = { equity0: app.equity, feeBps: app.feeBps, tpIndex: app.tpChoice, useTimeStop: true };

  console.log(`tuning ${pair}: ${n} bars, IS=first ${mid}, OOS=last ${n - mid} (split ${new Date(splitTime).toISOString().slice(0, 16)})`);
  const scored: Scored[] = [];
  for (const combo of GRID) {
    const strat = { ...strategyFromApp(app), ...combo };
    const isEng = runEngine(isBars, h1, pair, strat);
    const isStats = runPaper(isBars, isEng.signals, paperOpts).stats;
    const oosEng = runEngine(oosBars, h1, pair, strat);
    const oosSigs = oosEng.signals.filter((s) => s.time >= splitTime);
    const oosStats = runPaper(oosBars, oosSigs, paperOpts).stats;
    scored.push({
      ...combo,
      isTrades: isStats.trades,
      isExpR: isStats.expectancyR,
      oosTrades: oosStats.trades,
      oosExpR: oosStats.expectancyR,
      oosPnl: oosStats.totalPnl,
    });
  }

  const ranked = scored.filter((s) => s.isTrades >= 3).sort((x, y) => y.isExpR - x.isExpR);
  console.log('\n── top combos by in-sample expectancyR (min 3 trades) ──');
  if (!ranked.length) {
    console.log('no combo reached 3 in-sample trades — the week was too quiet to tune.');
    console.log('showing raw grid (IS trades / IS expR):');
    for (const s of scored) {
      console.log(`  ut=${s.utKey} adx=${s.adxMin} minconf=${s.minConfidence} → IS n=${s.isTrades} expR=${fmtR(s.isExpR)}`);
    }
  } else {
    for (const s of ranked.slice(0, 5)) {
      console.log(
        `  ut=${s.utKey} adx=${s.adxMin} minconf=${s.minConfidence} ` +
          `│ IS n=${s.isTrades} expR=${fmtR(s.isExpR)} │ OOS n=${s.oosTrades} expR=${fmtR(s.oosExpR)} PnL=$${s.oosPnl.toFixed(0)}`,
      );
    }
    const best = ranked[0]!;
    console.log(`\n→ best IS: ut=${best.utKey} adx=${best.adxMin} minconf=${best.minConfidence} (verify OOS before trusting it)`);
  }

  await mkdir('results', { recursive: true });
  const safe = pair.replace(/[^A-Za-z0-9]/g, '');
  await writeFile(`results/tune-${safe}.json`, JSON.stringify({ pair, bars: n, splitTime, grid: scored }, null, 1));
  console.log(`✔ wrote results/tune-${safe}.json`);
  return scored;
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMain()) {
  runTune().catch((e) => {
    console.error('tune failed:', (e as Error).message);
    process.exit(1);
  });
}

#!/usr/bin/env tsx
/**
 * Paper-live loop: poll fresh 15m bars, emit new ranked signals to Telegram /
 * console, and paper-trade them. Never places real orders.
 * Usage: npm run paper [-- --once]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCandles } from './data.js';
import { runEngine } from './strategy.js';
import { formatSignal, sendTelegram } from './telegram.js';
import { loadConfig, loadDotEnv } from './config.js';
import { strategyFromApp } from './backtest.js';
import type { Side } from './types.js';

interface Position {
  id: string;
  pair: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  size: number;
  entryTime: number;
  barsHeld: number;
  forecastBars: number;
  signalId: string;
}

interface LiveState {
  seen: string[];
  positions: Position[];
  equity: number;
  lastBar: Record<string, number>;
}

const STATE = 'results/live-state.json';

async function loadState(equity0: number): Promise<LiveState> {
  try {
    return JSON.parse(await readFile(STATE, 'utf8')) as LiveState;
  } catch {
    return { seen: [], positions: [], equity: equity0, lastBar: {} };
  }
}

async function saveState(s: LiveState): Promise<void> {
  await mkdir('results', { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 1));
}

async function appendSignals(lines: string[]): Promise<void> {
  if (!lines.length) return;
  await mkdir('results', { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile('results/signals.jsonl', lines.join('\n') + '\n');
}

export async function pollOnce(): Promise<{ newSignals: number; closedTrades: number }> {
  await loadDotEnv();
  const app = loadConfig();
  const strat = strategyFromApp(app);
  const state = await loadState(app.equity);
  const seen = new Set(state.seen);
  let newSignals = 0;
  let closedTrades = 0;
  const freshLines: string[] = [];

  for (const pair of app.pairs) {
    const m15 = await loadCandles(app.provider, pair, app.timeframeMin, { live: true });
    let h1 = null;
    try {
      h1 = (await loadCandles(app.provider, pair, 60, {})).closed;
    } catch { /* MTF neutral */ }
    const bars = m15.closed;
    if (!bars.length) continue;
    const lastT = bars[bars.length - 1]!.time;
    const isNewBar = state.lastBar[pair] !== lastT;

    const eng = runEngine(bars, strat.useMtf ? h1 : null, pair, strat);
    // rescale sizes to live equity (compound)
    const scale = state.equity / strat.equity;
    for (const s of eng.signals) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      newSignals++;
      s.size = s.size * scale;
      s.riskUsd = s.riskUsd * scale;
      freshLines.push(JSON.stringify(s));
      await sendTelegram(app.telegramToken, app.telegramChatId, `📡 NEW SIGNAL\n${formatSignal(s)}`);
      // open paper position (max 1 per pair)
      if (!state.positions.some((p) => p.pair === pair)) {
        const tp = s.tps[Math.min(app.tpChoice, s.tps.length - 1)]!;
        state.positions.push({
          id: `${s.id}-pos`,
          pair,
          side: s.side,
          entry: s.entry,
          sl: s.sl,
          tp,
          size: s.size,
          entryTime: s.time,
          barsHeld: 0,
          forecastBars: s.forecastBars,
          signalId: s.id,
        });
      }
    }

    // update open positions on the latest closed bar
    const b = bars[bars.length - 1]!;
    for (const p of [...state.positions]) {
      if (p.pair !== pair) continue;
      if (isNewBar) p.barsHeld++;
      let exit: number | null = null;
      let reason = '';
      if (p.side === 'long') {
        if (b.low <= p.sl) {
          exit = p.sl;
          reason = 'SL ❌';
        } else if (b.high >= p.tp) {
          exit = p.tp;
          reason = 'TP ✅';
        }
      } else {
        if (b.high >= p.sl) {
          exit = p.sl;
          reason = 'SL ❌';
        } else if (b.low <= p.tp) {
          exit = p.tp;
          reason = 'TP ✅';
        }
      }
      if (exit === null && p.barsHeld >= p.forecastBars && p.forecastBars > 0) {
        exit = b.close;
        reason = 'TIME ⏱';
      }
      if (exit !== null) {
        const fee = (p.entry * p.size + exit * p.size) * (app.feeBps / 1e4);
        const pnl = (p.side === 'long' ? exit - p.entry : p.entry - exit) * p.size - fee;
        state.equity += pnl;
        state.positions = state.positions.filter((x) => x.id !== p.id);
        closedTrades++;
        await sendTelegram(
          app.telegramToken,
          app.telegramChatId,
          `📕 CLOSED ${reason} ${p.pair} ${p.side}\nentry ${p.entry} → exit ${exit}\nPnL $${pnl.toFixed(2)} | equity $${state.equity.toFixed(2)}`,
        );
      }
    }
    state.lastBar[pair] = lastT;
  }

  state.seen = [...seen].slice(-5000);
  await saveState(state);
  await appendSignals(freshLines);
  console.log(
    `[${new Date().toISOString()}] poll done: +${newSignals} signals, ${closedTrades} closed, ` +
      `${state.positions.length} open, equity $${state.equity.toFixed(2)}`,
  );
  return { newSignals, closedTrades };
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const once = process.argv.includes('--once');
  const app = await loadConfigSafe();
  if (once) {
    await pollOnce();
    process.exit(0);
  }
  console.log(`paper-live started (poll every ${app.pollSec}s) — Ctrl+C to stop`);
  for (;;) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('poll error:', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, app.pollSec * 1000));
  }
}

async function loadConfigSafe() {
  await loadDotEnv();
  return loadConfig();
}

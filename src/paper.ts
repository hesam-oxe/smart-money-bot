/**
 * Paper broker — simulates fills on historical bars. No orders ever leave
 * the machine: entries at next open, conservative intrabar SL-first handling,
 * fees, R-multiple TP choice and forecast-based time stops.
 */
import type { BacktestStats, Candle, Signal, Trade } from './types.js';
import { summarizeTrades } from './risk.js';

export interface PaperOpts {
  equity0: number;
  feeBps: number;
  /** index into signal.tps to take as the single exit target */
  tpIndex: number;
  /** exit at close when bars held >= signal.forecastBars */
  useTimeStop: boolean;
}

export interface PaperOut {
  trades: Trade[];
  equityCurve: { time: number; equity: number }[];
  stats: BacktestStats;
}

export function runPaper(candles: Candle[], signals: Signal[], opts: PaperOpts): PaperOut {
  const timeToIdx = new Map<number, number>();
  candles.forEach((c, i) => timeToIdx.set(c.time, i));
  // chronological, one position at a time
  const ordered = [...signals].sort((a, b) => a.time - b.time);
  const trades: Trade[] = [];
  const curve: { time: number; equity: number }[] = [];
  let equity = opts.equity0;
  let busyUntil = -1;

  const feeRate = opts.feeBps / 1e4;

  for (const s of ordered) {
    const si = timeToIdx.get(s.time);
    if (si === undefined) continue;
    const entryIdx = si + 1;
    if (entryIdx >= candles.length || entryIdx <= busyUntil) continue;
    const entry = candles[entryIdx]!.open;
    const tp = s.tps[Math.min(opts.tpIndex, s.tps.length - 1)]!;
    const riskDist = Math.abs(s.entry - s.sl);
    if (!(riskDist > 0) || !(s.size > 0)) continue;
    const entryFee = entry * s.size * feeRate;

    let exitIdx = -1;
    let exit = entry;
    let reason: Trade['exitReason'] = 'eod';
    for (let k = entryIdx; k < candles.length; k++) {
      const b = candles[k]!;
      if (s.side === 'long') {
        if (b.low <= s.sl) {
          exit = s.sl;
          reason = 'sl';
          exitIdx = k;
          break;
        }
        if (b.high >= tp) {
          exit = tp;
          reason = 'tp';
          exitIdx = k;
          break;
        }
      } else {
        if (b.high >= s.sl) {
          exit = s.sl;
          reason = 'sl';
          exitIdx = k;
          break;
        }
        if (b.low <= tp) {
          exit = tp;
          reason = 'tp';
          exitIdx = k;
          break;
        }
      }
      if (opts.useTimeStop && k - entryIdx + 1 >= s.forecastBars && s.forecastBars > 0) {
        exit = b.close;
        reason = 'time';
        exitIdx = k;
        break;
      }
    }
    if (exitIdx === -1) {
      exitIdx = candles.length - 1;
      exit = candles[exitIdx]!.close;
      reason = 'eod';
    }
    busyUntil = exitIdx;
    const exitFee = exit * s.size * feeRate;
    const gross = (s.side === 'long' ? exit - entry : entry - exit) * s.size;
    const pnl = gross - entryFee - exitFee;
    equity += pnl;
    trades.push({
      pair: s.pair,
      side: s.side,
      entryTime: candles[entryIdx]!.time,
      entry,
      exitTime: candles[exitIdx]!.time,
      exit,
      exitReason: reason,
      size: s.size,
      pnl,
      pnlPct: (pnl / opts.equity0) * 100,
      rMultiple: s.riskUsd > 0 ? pnl / s.riskUsd : 0,
      fees: entryFee + exitFee,
    });
    curve.push({ time: candles[exitIdx]!.time, equity });
  }

  // forward-fill a per-bar equity curve for charting
  const full: { time: number; equity: number }[] = [];
  let ti = 0;
  let eq = opts.equity0;
  const byTime = new Map(curve.map((c) => [c.time, c.equity]));
  for (const c of candles) {
    if (byTime.has(c.time)) {
      eq = byTime.get(c.time)!;
      ti++;
    }
    void ti;
    full.push({ time: c.time, equity: eq });
  }

  return { trades, equityCurve: full, stats: summarizeTrades(trades, opts.equity0) };
}

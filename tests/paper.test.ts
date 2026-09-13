import { describe, expect, it } from 'vitest';
import { runPaper } from '../src/paper.js';
import type { Signal } from '../src/types.js';
import { candlesFromCloses } from './helpers.js';

function mkSignal(time: number, side: 'long' | 'short', sl: number, tps: number[]): Signal {
  return {
    id: `t-${time}`, pair: 'T', time, side, entry: 100, sl, slMethod: 'atr',
    tps, tpRs: [1, 1.5, 2, 3], size: 1, riskUsd: 2, confidence: 70, z: 1,
    engines: {}, forecastBars: 50, forecastLowHistory: false, survival: [],
    forecastMode: 'standard', forecastMults: null, filtersPassed: [],
  };
}

describe('paper broker', () => {
  it('takes profit when TP prints', () => {
    const closes = new Array(11).fill(100).concat([100.5, 101.5, 103, 104]);
    const cs = candlesFromCloses(closes);
    const s = mkSignal(cs[10]!.time, 'long', 98, [101, 102, 102.5, 104]);
    const out = runPaper(cs, [s], { equity0: 10000, feeBps: 0, tpIndex: 2, useTimeStop: false });
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0]!.exitReason).toBe('tp');
    expect(out.trades[0]!.pnl).toBeGreaterThan(0);
  });
  it('stops out below the stop (SL checked first)', () => {
    const closes = new Array(11).fill(100).concat([99, 97, 96]);
    const cs = candlesFromCloses(closes);
    const s = mkSignal(cs[10]!.time, 'long', 98, [101, 102, 103, 104]);
    const out = runPaper(cs, [s], { equity0: 10000, feeBps: 0, tpIndex: 2, useTimeStop: false });
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0]!.exitReason).toBe('sl');
    expect(out.trades[0]!.pnl).toBeLessThan(0);
  });
  it('time-stops at the forecast horizon', () => {
    const closes = new Array(20).fill(100);
    const cs = candlesFromCloses(closes);
    const s = mkSignal(cs[10]!.time, 'long', 90, [110, 120, 130, 140]);
    s.forecastBars = 2;
    const out = runPaper(cs, [s], { equity0: 10000, feeBps: 0, tpIndex: 2, useTimeStop: true });
    expect(out.trades[0]!.exitReason).toBe('time');
  });
  it('charges fees and summarizes', () => {
    const closes = new Array(11).fill(100).concat([100.5, 101.5, 103, 104]);
    const cs = candlesFromCloses(closes);
    const s = mkSignal(cs[10]!.time, 'long', 98, [101, 102, 102.5, 104]);
    const out = runPaper(cs, [s], { equity0: 10000, feeBps: 5, tpIndex: 2, useTimeStop: false });
    expect(out.trades[0]!.fees).toBeGreaterThan(0);
    expect(out.stats.trades).toBe(1);
    expect(out.stats.winRate).toBe(100);
    expect(out.equityCurve.length).toBe(cs.length);
  });
});

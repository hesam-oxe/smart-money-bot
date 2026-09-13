import { describe, expect, it } from 'vitest';
import { computeSL, sizeForRisk, summarizeTrades, swingRef, takeProfits } from '../src/risk.js';
import type { Trade } from '../src/types.js';

describe('swing reference', () => {
  it('picks the most recent protective swing', () => {
    const lows = [{ idx: 5, price: 90 }, { idx: 20, price: 95 }];
    expect(swingRef('long', 30, [], lows)).toBe(95);
    expect(swingRef('long', 10, [], lows)).toBe(90);
    expect(swingRef('long', 30, [], lows, 5)).toBeNull();
  });
});

describe('stops', () => {
  const ctx = { swing: 95, atr: 2, atrPct: 0.02, huntMult: 0.5, atrMult: 1.3, pct: 1, ticks: 200 };
  it('structural long sits below the swing (anti-hunt buffer)', () => {
    const sl = computeSL('structural', 'long', 100, ctx);
    expect(sl.price).toBe(95 - 2 * 0.5);
    expect(sl.price).toBeLessThan(100);
  });
  it('falls back to ATR without structure', () => {
    const sl = computeSL('structural', 'long', 100, { ...ctx, swing: null });
    expect(sl.method).toBe('atr');
    expect(sl.price).toBe(100 - 2 * 1.3);
  });
  it('safer takes the widest candidate', () => {
    const sl = computeSL('safer', 'long', 100, ctx);
    expect(sl.price).toBeLessThanOrEqual(100 - 2 * 1.3);
    expect(sl.price).toBeLessThanOrEqual(95 - 1);
  });
  it('short stops mirror above entry', () => {
    const sl = computeSL('atr', 'short', 100, { ...ctx, swing: 105 });
    expect(sl.price).toBeGreaterThan(100);
  });
});

describe('targets + sizing', () => {
  it('R multiples scale from stop distance', () => {
    expect(takeProfits(100, 98, 'long')).toEqual([102, 103, 104, 106]);
    expect(takeProfits(100, 102, 'short')[2]).toBe(96);
  });
  it('risks exactly riskPct of equity', () => {
    const { qty, riskUsd } = sizeForRisk(10000, 1, 100, 98);
    expect(riskUsd).toBe(100);
    expect(qty).toBe(50);
  });
});

describe('trade summary', () => {
  it('computes PF, expectancy and log stats', () => {
    const mk = (pnl: number, r: number): Trade => ({
      pair: 'T', side: 'long', entryTime: 0, entry: 100, exitTime: 1, exit: 100,
      exitReason: 'tp', size: 1, pnl, pnlPct: 0, rMultiple: r, fees: 0,
    });
    const s = summarizeTrades([mk(50, 1), mk(-25, -0.5)], 10000);
    expect(s.trades).toBe(2);
    expect(s.winRate).toBe(50);
    expect(s.profitFactor).toBe(2);
    expect(s.expectancyR).toBeCloseTo(0.25, 10);
    expect(s.totalPnl).toBe(25);
    expect(s.totalLogReturn).toBeCloseTo(Math.log(10025 / 10000), 10);
  });
});

describe('tick stops', () => {
  it('steps back N venue-like ticks from entry', () => {
    const base = { swing: null, atr: 2, atrPct: 0.02, huntMult: 0.5, atrMult: 1.3, pct: 1, ticks: 200 };
    expect(computeSL('tick', 'long', 100, base).price).toBe(98);
    expect(computeSL('tick', 'short', 100, base).price).toBe(102);
  });
});

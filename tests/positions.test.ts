import { describe, expect, it } from 'vitest';
import { closeEconomics, updatePosition, type LivePosition } from '../src/positions.js';
import type { Candle } from '../src/types.js';

const bar = (high: number, low: number): Candle => ({
  time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100,
});

const pos = (over: Partial<LivePosition> = {}): LivePosition => ({
  id: 'p', pair: 'T', side: 'long', entry: 100, sl: 98, tp: 104, tp1: 102,
  size: 1, entryTime: 0, barsHeld: 0, forecastBars: 50, signalId: 's', breakeven: false,
  ...over,
});

describe('updatePosition (long)', () => {
  it('exits at the stop when SL prints', () => {
    const ev = updatePosition(pos(), bar(101, 97));
    expect(ev.exit).toEqual({ price: 98, reason: 'sl' });
  });
  it('checks SL first when both SL and TP print', () => {
    const ev = updatePosition(pos(), bar(105, 97));
    expect(ev.exit!.reason).toBe('sl');
  });
  it('exits at TP without touching the stop', () => {
    const p = pos();
    const ev = updatePosition(p, bar(105, 99));
    expect(ev.exit).toEqual({ price: 104, reason: 'tp' });
    expect(p.breakeven).toBe(false);
  });
  it('arms breakeven at TP1 and keeps the trade alive', () => {
    const p = pos();
    const ev = updatePosition(p, bar(103, 99));
    expect(ev.exit).toBeNull();
    expect(ev.movedStopToBreakeven).toBe(true);
    expect(p.sl).toBe(100);
    expect(p.breakeven).toBe(true);
  });
  it('then stops out at breakeven (≈ scratch minus fees)', () => {
    const p = pos();
    updatePosition(p, bar(103, 99)); // arm
    const ev = updatePosition(p, bar(101, 99)); // fall back
    expect(ev.exit).toEqual({ price: 100, reason: 'sl' });
    const { pnl, fees } = closeEconomics(p.side, p.entry, 100, p.size, 5);
    expect(pnl).toBeCloseTo(-fees, 10);
    expect(fees).toBeGreaterThan(0);
  });
  it('ignores TP1 twice (no double-move)', () => {
    const p = pos();
    updatePosition(p, bar(103, 99));
    const ev = updatePosition(p, bar(103, 100.5));
    expect(ev.movedStopToBreakeven).toBe(false);
    expect(ev.exit).toBeNull();
  });
});

describe('updatePosition (short mirrors)', () => {
  const sp = (over: Partial<LivePosition> = {}): LivePosition =>
    pos({ side: 'short', sl: 102, tp: 96, tp1: 98, ...over });
  it('exits SL above / TP below', () => {
    expect(updatePosition(sp(), bar(103, 99)).exit).toEqual({ price: 102, reason: 'sl' });
    expect(updatePosition(sp(), bar(99, 95)).exit).toEqual({ price: 96, reason: 'tp' });
  });
  it('arms breakeven when TP1 prints', () => {
    const p = sp();
    const ev = updatePosition(p, bar(101, 97.5));
    expect(ev.exit).toBeNull();
    expect(p.sl).toBe(100);
  });
});

describe('closeEconomics', () => {
  it('computes PnL net of round-trip fees', () => {
    const free = closeEconomics('long', 100, 104, 2, 0);
    expect(free.pnl).toBe(8);
    expect(free.fees).toBe(0);
    const paid = closeEconomics('long', 100, 104, 2, 100);
    expect(paid.fees).toBeCloseTo((200 + 208) * 0.01, 10);
    expect(paid.pnl).toBeCloseTo(8 - paid.fees, 10);
    const short = closeEconomics('short', 100, 96, 1, 0);
    expect(short.pnl).toBe(4);
  });
});

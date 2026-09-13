import { describe, expect, it } from 'vitest';
import { closeEconomics, updatePosition, type LivePosition } from '../src/positions.js';
import type { Candle } from '../src/types.js';

const bar = (high: number, low: number): Candle => ({
  time: 0, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100,
});

const pos = (over: Partial<LivePosition> = {}): LivePosition => ({
  id: 'p', pair: 'T', side: 'long', entry: 100, sl: 98, tp: 104, tp1: 102,
  size: 1, entryTime: 0, barsHeld: 0, forecastBars: 50, signalId: 's', breakeven: false,
  closedFrac: 0, realizedPnl: 0,
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
    const p = pos({ tp1: 106 }); // TP1 never touched on this bar
    const ev = updatePosition(p, bar(105, 99));
    expect(ev.exit).toEqual({ price: 104, reason: 'tp' });
    expect(ev.partial).toBeNull();
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

describe('partial profit-taking', () => {
  it('banks half at TP1 and moves the stop (long)', () => {
    const p = pos(); // entry 100, tp1 102, tp 104, size 1
    const ev = updatePosition(p, bar(103, 99), 0);
    expect(ev.exit).toBeNull();
    expect(ev.partial).not.toBeNull();
    expect(ev.partial!.frac).toBe(0.5);
    expect(ev.partial!.pnl).toBeCloseTo((102 - 100) * 0.5, 10);
    expect(p.closedFrac).toBe(0.5);
    expect(p.realizedPnl).toBeCloseTo(1, 10);
    expect(p.sl).toBe(100);
  });
  it('exits the rest at TP after banking', () => {
    const p = pos();
    updatePosition(p, bar(103, 99), 0);
    const ev = updatePosition(p, bar(105, 100.5), 0);
    expect(ev.exit).toEqual({ price: 104, reason: 'tp' });
    const { pnl } = closeEconomics('long', 100, 104, 0.5, 0);
    expect(p.realizedPnl + pnl).toBeCloseTo(1 + 2, 10);
  });
  it('banks and exits on the same bar when price sweeps through TP', () => {
    const p = pos();
    const ev = updatePosition(p, bar(105, 99), 0); // through tp1 AND tp, no SL touch
    expect(ev.partial!.frac).toBe(0.5);
    expect(ev.exit).toEqual({ price: 104, reason: 'tp' });
  });
  it('skips the partial when the final TP equals TP1', () => {
    const p = pos({ tp: 102 });
    const ev = updatePosition(p, bar(103, 99), 0);
    expect(ev.partial).toBeNull();
    expect(ev.exit).toEqual({ price: 102, reason: 'tp' });
  });
  it('short banks symmetrically', () => {
    const p = pos({ side: 'short', sl: 102, tp: 96, tp1: 98 });
    const ev = updatePosition(p, bar(101, 97.5), 0);
    expect(ev.partial!.pnl).toBeCloseTo((100 - 98) * 0.5, 10);
    expect(p.sl).toBe(100);
  });
  it('charges fees on the partial fill', () => {
    const p = pos();
    const ev = updatePosition(p, bar(103, 99), 100); // 1% round-trip fee rate
    const qty = 0.5;
    expect(ev.partial!.pnl).toBeCloseTo((102 - 100) * qty - (100 * qty + 102 * qty) * 0.01, 10);
  });
});

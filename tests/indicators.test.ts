import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  ema,
  kaufmanER,
  rollingVwap,
  rsi,
  rsiDivergence,
  sma,
  supertrend,
  utbot,
  zscoreOf,
} from '../src/indicators.js';
import { candlesFromCloses, trendingMarket } from './helpers.js';

describe('moving averages', () => {
  it('ema of a constant series equals the constant', () => {
    const out = ema(new Array(50).fill(100), 10);
    expect(out[49]).toBeCloseTo(100, 10);
    expect(out[8]).toBeNull();
  });
  it('sma computes the window mean', () => {
    const out = sma([1, 2, 3, 4, 5], 5);
    expect(out[4]).toBeCloseTo(3, 10);
    expect(out[3]).toBeNull();
  });
});

describe('atr', () => {
  it('is positive and tracks range', () => {
    const cs = candlesFromCloses([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
    const a = atr(cs, 5);
    expect(a[10]).toBeGreaterThan(0);
    expect(a[3]).toBeNull();
  });
});

describe('rsi / adx bounds', () => {
  const cs = trendingMarket(120, 100, 0.05, 0.3, 3);
  const closes = cs.map((c) => c.close);
  it('rsi stays in [0,100]', () => {
    for (const v of rsi(closes)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
  it('adx stays in [0,100]', () => {
    for (const v of adx(cs).adx) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('utbot', () => {
  it('rides an uptrend then flips bearish on reversal', () => {
    const up = trendingMarket(60, 100, 0.3, 0.1, 11).map((c) => c.close);
    const dn = trendingMarket(60, up[up.length - 1]!, -0.3, 0.1, 12).map((c) => c.close);
    const cs = candlesFromCloses([...up, ...dn]);
    const u = utbot(cs, 1.5, 10, { classic: true });
    expect(u.buy.length + u.sell.length).toBeGreaterThan(0);
    expect(u.dir[u.dir.length - 1]).toBe(-1);
    expect(u.dir[45]).toBe(1);
    expect(u.trail[45]).toBeLessThan(cs[45]!.close);
  });
  it('adaptive multiplier stays bounded', () => {
    const cs = trendingMarket(120, 100, 0.05, 0.4, 5);
    for (const a of utbot(cs, 1.5, 10).adapt) {
      if (a === null) continue;
      expect(a).toBeGreaterThanOrEqual(0.6);
      expect(a).toBeLessThanOrEqual(1.9);
    }
  });
});

describe('supertrend', () => {
  it('follows the trend direction', () => {
    const cs = trendingMarket(80, 100, 0.2, 0.1, 21);
    const st = supertrend(cs);
    expect(st.dir[st.dir.length - 1]).toBe(1);
  });
});

describe('vwap', () => {
  it('stays within the recent range', () => {
    const cs = trendingMarket(120, 100, 0.02, 0.2, 31);
    const v = rollingVwap(cs, 20);
    const i = 119;
    const win = cs.slice(i - 19, i + 1);
    const lo = Math.min(...win.map((c) => c.low));
    const hi = Math.max(...win.map((c) => c.high));
    expect(v[i]).toBeGreaterThanOrEqual(lo);
    expect(v[i]).toBeLessThanOrEqual(hi);
  });
});

describe('zscore + efficiency ratio', () => {
  it('zscoreOf math', () => {
    expect(zscoreOf(10, 8, 2)).toBe(1);
    expect(zscoreOf(8, 8, 0)).toBe(0);
  });
  it('ER is bounded in [0,1]', () => {
    const cs = trendingMarket(60, 100, 0.05, 0.3, 41).map((c) => c.close);
    for (const e of kaufmanER(cs)) {
      if (e === null) continue;
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
  });
});

describe('rsi divergence', () => {
  it('flags a regular bearish divergence off pivots', () => {
    const cs = candlesFromCloses([100, 101, 102, 103, 104, 105]);
    cs[2]!.high = 110;
    cs[4]!.high = 112; // rising price highs
    const r: (number | null)[] = [70, 69, 68, 66, 64, 63]; // falling RSI
    const { bear } = rsiDivergence(cs, r, [{ idx: 2 }, { idx: 4 }], []);
    expect(bear.has(4)).toBe(true);
  });
  it('flags a regular bullish divergence off pivots', () => {
    const cs = candlesFromCloses([105, 104, 103, 102, 101, 100]);
    cs[1]!.low = 99;
    cs[3]!.low = 98; // falling price lows
    const r: (number | null)[] = [30, 32, 33, 36, 38, 40]; // rising RSI
    const { bull } = rsiDivergence(cs, r, [], [{ idx: 1 }, { idx: 3 }]);
    expect(bull.has(3)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { atr } from '../src/indicators.js';
import {
  activeOBs,
  buildZones,
  fairValueGaps,
  marketStructure,
  nearestZones,
  orderBlocks,
  swings,
} from '../src/smc.js';
import type { Candle } from '../src/types.js';

/** [open, high, low, close, volume?] tuples -> candles */
function explicit(bars: [number, number, number, number, number?][]): Candle[] {
  return bars.map(([o, h, l, c, v], i) => ({ time: 1700000000000 + i * 900_000, open: o, high: h, low: l, close: c, volume: v ?? 100 }));
}

describe('swings', () => {
  it('finds strict fractal pivots', () => {
    const cs = explicit([
      [100, 101, 99, 100], [100, 102, 100, 101], [101, 103, 101, 102],
      [102, 103, 101, 101], [101, 101, 99, 99.5], [99.5, 102, 99.5, 101],
      [101, 103, 101, 102], [102, 104, 102, 103], [103, 105, 103, 104],
      [104, 106, 104, 105], [105, 105, 103, 104], [104, 104, 102, 103],
    ]);
    const { highs, lows } = swings(cs, 2, 2);
    expect(highs.map((s) => s.idx)).toContain(9);
    expect(lows.map((s) => s.idx)).toContain(4);
  });
});

describe('market structure', () => {
  it('fires BOS on breakout and holds bias', () => {
    const cs = explicit([
      [100, 101, 99, 100], [100, 102, 100, 101], [101, 103, 101, 102],
      [102, 103, 101, 101], [101, 101, 99, 99.5], [99.5, 102, 99.5, 101],
      [101, 103, 101, 102], [102, 104, 102, 103], [103, 105, 103, 104],
      [104, 106, 104, 105], [105, 105, 103, 104], [104, 104, 102, 103],
      [103, 105, 103, 104], [104, 106, 104, 105], [105, 107, 105, 106],
      [106, 108, 106, 107], [107, 109, 107, 108], [108, 110, 108, 109],
    ]);
    const sw = swings(cs, 2, 2);
    const st = marketStructure(cs, sw.highs, sw.lows, 2);
    expect(st.events.some((e) => e.type === 'BOS' && e.dir === 1)).toBe(true);
    expect(st.bias[st.bias.length - 1]).toBe(1);
  });
});

describe('order blocks', () => {
  it('validates a real block: displacement + volume spike, tracks life', () => {
    const bars: [number, number, number, number, number?][] = [];
    for (let i = 0; i < 20; i++) bars.push([100, 100.6, 99.6, 100 + (i % 2 ? 0.2 : -0.2)]);
    bars.push([101, 101.2, 99.4, 99.5, 1000]); // idx20: bearish block candle, volume spike
    bars.push([99.5, 101, 99.5, 100.8]);
    bars.push([100.8, 102.5, 100.8, 102.2]);
    bars.push([102.2, 103.5, 102, 103.2]);
    bars.push([103.2, 104.2, 103, 104]);
    bars.push([104, 104.5, 103.8, 104.2]);
    bars.push([104.2, 104.6, 104, 104.3]);
    bars.push([104.3, 104.7, 104.1, 104.4]);
    const cs = explicit(bars);
    const obs = orderBlocks(cs, atr(cs, 10));
    const ob = obs.find((o) => o.dir === 1 && o.obIdx === 20);
    expect(ob).toBeDefined();
    expect(ob!.valid).toBe(true);
    expect(ob!.brokenIdx).toBeNull();
    expect(activeOBs(obs, cs.length - 1)).toContain(ob!);
  });
});

describe('fair value gaps', () => {
  it('detects a bullish gap', () => {
    const cs = explicit([
      [100, 100, 99, 99.5],
      [99.5, 100, 99, 99.5],
      [99.5, 102, 101, 101.5],
    ]);
    const gaps = fairValueGaps(cs);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ idx: 2, dir: 1, top: 101, bottom: 100 });
    expect(gaps[0]!.filled).toBe(false);
  });
});

describe('zones', () => {
  it('clusters pivots and finds nearest S/R', () => {
    const res = buildZones(
      [{ idx: 0, price: 100 }, { idx: 1, price: 100.1 }, { idx: 2, price: 105 }],
      -1,
      0.5,
    );
    expect(res).toHaveLength(2);
    expect(res.find((z) => z.touches === 2)).toBeDefined();
    const { above, below } = nearestZones(res, 102);
    expect(above!.price).toBeCloseTo(105, 5);
    expect(below!.price).toBeCloseTo(100.05, 5);
  });
});

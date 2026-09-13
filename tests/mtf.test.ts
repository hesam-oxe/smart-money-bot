import { describe, expect, it } from 'vitest';
import { htfsFor, mtfBullFraction, mtfLabel, mtfSnapshot } from '../src/mtf.js';
import { trendingMarket } from './helpers.js';

describe('htfsFor', () => {
  it('picks higher timeframes above the base', () => {
    expect(htfsFor(15)).toEqual([30, 60, 240, 1440, 10080]);
    expect(htfsFor(60)).toEqual([240, 1440, 10080]);
    expect(htfsFor(1440)).toEqual([10080]);
  });
  it('labels timeframes', () => {
    expect([30, 60, 240, 1440, 10080].map(mtfLabel)).toEqual(['30m', '1H', '4H', '1D', '1W']);
  });
});

describe('mtfBullFraction', () => {
  const base = trendingMarket(440, 100, 0.05, 0.1, 1);
  const up = trendingMarket(440, 100, 0.3, 0.05, 2);
  const dn = trendingMarket(440, 100, -0.3, 0.05, 3);
  it('reads bull from a rising tape', () => {
    expect(mtfBullFraction([{ minutes: 60, candles: up }], base)[300]).toBe(1);
  });
  it('reads bear from a falling tape', () => {
    expect(mtfBullFraction([{ minutes: 60, candles: dn }], base)[300]).toBe(0);
  });
  it('averages across tapes', () => {
    const f = mtfBullFraction(
      [
        { minutes: 60, candles: up },
        { minutes: 240, candles: dn },
      ],
      base,
    );
    expect(f[300]).toBe(0.5);
  });
  it('returns null before tape warmup', () => {
    expect(mtfBullFraction([{ minutes: 60, candles: up }], base)[0]).toBeNull();
  });
});

describe('mtfSnapshot', () => {
  it('snapshots last-bar trend per tape', () => {
    const up = trendingMarket(100, 100, 0.3, 0.05, 4);
    expect(mtfSnapshot([{ minutes: 240, candles: up }])).toEqual([{ tf: '4H', bull: true }]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  forecastDuration,
  PRESET_15M,
  rankSignals,
  runEngine,
  STYLE_PRESETS,
  styleForTimeframe,
} from '../src/strategy.js';
import { utbot } from '../src/indicators.js';
import type { Candle } from '../src/types.js';
import { candlesFromCloses, chopMarket, mulberry32, trendingMarket } from './helpers.js';

const cfg = { ...PRESET_15M };

/** Uptrend with sine pullbacks — UT flips bull on recoveries (6 flips, 3 long signals). */
function pullbackTrend(): Candle[] {
  const rnd = mulberry32(61);
  const closes: number[] = [];
  for (let i = 0; i < 440; i++) {
    closes.push(100 * (1 + 0.0008 * i) + Math.sin(i / 12) * 1.4 + (rnd() - 0.5) * 0.3);
  }
  return candlesFromCloses(closes);
}

describe('engine on trend with pullbacks', () => {
  const out = runEngine(pullbackTrend(), null, 'T', cfg);
  it('emits long signals on with-trend recoveries', () => {
    expect(out.flips).toBeGreaterThan(0);
    expect(out.signals.length).toBeGreaterThanOrEqual(2);
    expect(out.signals.every((s) => s.side === 'long')).toBe(true);
  });
  it('keeps every signal well-formed', () => {
    for (const s of out.signals) {
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(100);
      expect(Number.isFinite(s.z)).toBe(true);
      const sum = Object.values(s.engines).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - s.confidence)).toBeLessThan(0.2);
      if (s.side === 'long') {
        expect(s.sl).toBeLessThan(s.entry);
        expect(s.tps[0]).toBeGreaterThan(s.entry);
      } else {
        expect(s.sl).toBeGreaterThan(s.entry);
        expect(s.tps[0]).toBeLessThan(s.entry);
      }
      expect(s.forecastBars).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('engine on chop', () => {
  it('rejects nearly all chop flips (fake-signal killer)', () => {
    const trend = runEngine(pullbackTrend(), null, 'T', cfg);
    const chop = runEngine(chopMarket(440, 100, 0.2, 9), null, 'T', cfg);
    expect(chop.flips).toBeGreaterThan(0);
    expect(chop.signals.length).toBeLessThan(trend.signals.length);
    expect(chop.signals.length / chop.flips).toBeLessThan(trend.signals.length / trend.flips);
  });
});

describe('gates', () => {
  it('minConfidence 100 blocks everything (nothing scores 100)', () => {
    const out = runEngine(pullbackTrend(), null, 'T', { ...cfg, minConfidence: 100 });
    expect(out.signals).toHaveLength(0);
    expect(out.blocked.length).toBeGreaterThan(0);
  });
  it('rankSignals sorts z desc', () => {
    const ranked = rankSignals(runEngine(pullbackTrend(), null, 'T', cfg).signals);
    expect(ranked.length).toBeGreaterThan(0);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.z).toBeGreaterThanOrEqual(ranked[i]!.z);
    }
  });
});

describe('confirmation + cooldown machinery', () => {
  it('counts flips identically with or without confirmation', () => {
    const raw = runEngine(pullbackTrend(), null, 'T', { ...cfg, confirmBars: 1 });
    const conf = runEngine(pullbackTrend(), null, 'T', { ...cfg, confirmBars: 2 });
    expect(raw.flips).toBe(conf.flips);
    expect(raw.flips).toBeGreaterThan(0);
  });
  it('confirmed signals sit on a held (2-bar) UT direction', () => {
    const cs = pullbackTrend();
    const out = runEngine(cs, null, 'T', { ...cfg, confirmBars: 2 });
    expect(out.signals.length).toBeGreaterThan(0);
    const u = utbot(cs, cfg.utKey, cfg.utAtrLen, { classic: cfg.classicUt, chopStrength: cfg.chopStrength });
    const t2i = new Map(cs.map((c, i) => [c.time, i] as [number, number]));
    for (const s of out.signals) {
      const i = t2i.get(s.time)!;
      expect(u.dir[i]).toBe(s.side === 'long' ? 1 : -1);
      expect(u.dir[i]).toBe(u.dir[i - 1]); // direction survived the confirmation bar
    }
  });
  it('3-bar confirmation holds 3 bars', () => {
    const cs = pullbackTrend();
    const out = runEngine(cs, null, 'T', { ...cfg, confirmBars: 3 });
    expect(out.flips).toBeGreaterThan(0);
    const u = utbot(cs, cfg.utKey, cfg.utAtrLen, { classic: cfg.classicUt, chopStrength: cfg.chopStrength });
    const t2i = new Map(cs.map((c, i) => [c.time, i] as [number, number]));
    for (const s of out.signals) {
      const i = t2i.get(s.time)!;
      const want = s.side === 'long' ? 1 : -1;
      expect(u.dir[i]).toBe(want);
      expect(u.dir[i - 1]).toBe(want);
      expect(u.dir[i - 2]).toBe(want);
    }
  });
  it('huge cooldown allows at most one signal', () => {
    const out = runEngine(pullbackTrend(), null, 'T', { ...cfg, cooldownBars: 1000 });
    expect(out.signals.length).toBeLessThanOrEqual(1);
  });
});

describe('regime guard', () => {
  const chop = new Array(440).fill(5); // BTC dead-chop ADX
  const trend = new Array(440).fill(25);
  it('blocks everything when the market chops', () => {
    const out = runEngine(pullbackTrend(), null, 'T', cfg, chop);
    expect(out.flips).toBeGreaterThan(0);
    expect(out.signals).toHaveLength(0);
    expect(out.blocked.some((b) => b.blockedBy.some((r) => r.startsWith('regime(')))).toBe(true);
  });
  it('passes through when the market trends', () => {
    const plain = runEngine(pullbackTrend(), null, 'T', cfg);
    const guarded = runEngine(pullbackTrend(), null, 'T', cfg, trend);
    expect(guarded.signals.length).toBe(plain.signals.length);
  });
  it('treats missing regime data as neutral', () => {
    const plain = runEngine(pullbackTrend(), null, 'T', cfg);
    const nodata = runEngine(pullbackTrend(), null, 'T', cfg, new Array(440).fill(null));
    expect(nodata.signals.length).toBe(plain.signals.length);
  });
});

describe('mtf confluence tapes', () => {
  const bullTape = trendingMarket(440, 100, 0.3, 0.05, 11);
  const bearTape = trendingMarket(440, 100, -0.3, 0.05, 12);
  it('keeps longs when higher timeframes agree', () => {
    const out = runEngine(pullbackTrend(), [{ minutes: 60, candles: bullTape }], 'T', cfg);
    expect(out.signals.length).toBeGreaterThanOrEqual(2);
    expect(out.signals.every((s) => s.side === 'long')).toBe(true);
  });
  it('kills longs when higher timeframes disagree', () => {
    const out = runEngine(pullbackTrend(), [{ minutes: 60, candles: bearTape }], 'T', cfg);
    expect(out.flips).toBeGreaterThan(0);
    expect(out.signals.some((s) => s.side === 'long')).toBe(false);
  });
});

describe('optional confirmation filters', () => {
  const plain = runEngine(pullbackTrend(), null, 'T', cfg).signals.length;
  it.each([
    ['rsi', { useRsiFilter: true }],
    ['supertrend', { useSupertrendFilter: true }],
    ['hull', { useHullFilter: true }],
  ])('%s filter can only remove signals', (_name, patch) => {
    const out = runEngine(pullbackTrend(), null, 'T', { ...cfg, ...patch });
    expect(out.signals.length).toBeLessThanOrEqual(plain);
  });
});

describe('lux mode (filters out of the box)', () => {
  it('emits on every flip when everything optional is off', () => {
    const lux = {
      ...cfg,
      useRegime: false, useAdx: false, useEmaTrend: false, useVwap: false, useMtf: false,
      useVolume: false, useFullCandle: false, useZoneFilter: false, useVolatility: false,
      useStructure: false, useRsiFilter: false, useSupertrendFilter: false, useHullFilter: false,
      cooldownBars: 0, confirmBars: 1, minConfidence: 0,
    };
    const out = runEngine(pullbackTrend(), null, 'T', lux);
    expect(out.flips).toBeGreaterThan(0);
    expect(out.signals.length).toBe(out.flips);
  });
});

describe('trading styles', () => {
  it('maps timeframes to styles', () => {
    expect(styleForTimeframe(1)).toBe('scalping');
    expect(styleForTimeframe(5)).toBe('scalping');
    expect(styleForTimeframe(15)).toBe('day');
    expect(styleForTimeframe(60)).toBe('day');
    expect(styleForTimeframe(240)).toBe('swing');
    expect(styleForTimeframe(1440)).toBe('swing');
    expect(styleForTimeframe(10080)).toBe('position');
  });
  it('day preset matches the 15m spec (1.5 / 10 / 1.3)', () => {
    expect(STYLE_PRESETS.day).toMatchObject({ utKey: 1.5, utAtrLen: 10, atrMult: 1.3 });
    expect(STYLE_PRESETS.scalping.utKey).toBeLessThan(STYLE_PRESETS.position.utKey);
  });
});

describe('forecastDuration', () => {
  const ctx = (over = {}) => ({
    zoneDistAtr: 5, volRel: 1.2, filtersPassed: 9, adx: 20, atrPct: 0.003, medAtrPct: 0.003, ...over,
  });
  it('simple returns the median', () => {
    expect(forecastDuration([10, 20, 30, 40, 50], 'simple', 0.3, ctx()).bars).toBe(30);
  });
  it('standard returns the EWMA (alpha 1 = last value)', () => {
    expect(forecastDuration([10, 20, 30], 'standard', 1, ctx()).bars).toBe(30);
  });
  it('advanced multiplies the five knobs', () => {
    const { bars, mults } = forecastDuration(
      [20, 20, 20],
      'advanced',
      1,
      ctx({ zoneDistAtr: 0.5, volRel: 2, filtersPassed: 10, adx: 30, atrPct: 0.001, medAtrPct: 0.004 }),
    );
    expect(mults).toMatchObject({ structure: 0.8, regime: 1.1, asset: 1.1 });
    expect(mults!.flip).toBeCloseTo(1.155, 10);
    expect(mults!.errorLearn).toBeCloseTo(1, 10);
    expect(bars).toBe(Math.round(20 * 0.8 * 1.155 * 1 * 1.1 * 1.1));
  });
  it('thin history falls back to 10 bars', () => {
    expect(forecastDuration([5, 6], 'advanced', 0.3, ctx()).bars).toBe(10);
    expect(forecastDuration([5, 6], 'advanced', 0.3, ctx()).mults).toBeNull();
  });
  it('engine records mode + mults on advanced signals', () => {
    const out = runEngine(pullbackTrend(), null, 'T', { ...cfg, forecastMode: 'advanced' });
    expect(out.signals.length).toBeGreaterThan(0);
    for (const s of out.signals) {
      expect(s.forecastMode).toBe('advanced');
      if (!s.forecastLowHistory) expect(Object.keys(s.forecastMults ?? {})).toHaveLength(5);
    }
  });
});

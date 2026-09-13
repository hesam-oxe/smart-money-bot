import { describe, expect, it } from 'vitest';
import { PRESET_15M, rankSignals, runEngine } from '../src/strategy.js';
import { utbot } from '../src/indicators.js';
import type { Candle } from '../src/types.js';
import { candlesFromCloses, chopMarket, mulberry32 } from './helpers.js';

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
    const raw = runEngine(pullbackTrend(), null, 'T', { ...cfg, twoBarConfirm: false });
    const conf = runEngine(pullbackTrend(), null, 'T', { ...cfg, twoBarConfirm: true });
    expect(raw.flips).toBe(conf.flips);
    expect(raw.flips).toBeGreaterThan(0);
  });
  it('confirmed signals sit on a held (2-bar) UT direction', () => {
    const cs = pullbackTrend();
    const out = runEngine(cs, null, 'T', { ...cfg, twoBarConfirm: true });
    expect(out.signals.length).toBeGreaterThan(0);
    const u = utbot(cs, cfg.utKey, cfg.utAtrLen, { classic: cfg.classicUt, chopStrength: cfg.chopStrength });
    const t2i = new Map(cs.map((c, i) => [c.time, i] as [number, number]));
    for (const s of out.signals) {
      const i = t2i.get(s.time)!;
      expect(u.dir[i]).toBe(s.side === 'long' ? 1 : -1);
      expect(u.dir[i]).toBe(u.dir[i - 1]); // direction survived the confirmation bar
    }
  });
  it('huge cooldown allows at most one signal', () => {
    const out = runEngine(pullbackTrend(), null, 'T', { ...cfg, cooldownBars: 1000 });
    expect(out.signals.length).toBeLessThanOrEqual(1);
  });
});

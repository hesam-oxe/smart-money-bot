/** Deterministic synthetic markets for tests (seeded PRNG, no network). */
import type { Candle } from '../src/types.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function candlesFromCloses(closes: number[], vol = 100, start = 1700000000000): Candle[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    const spread = Math.abs(c - o) * 0.2 + c * 0.0002;
    return {
      time: start + i * 900_000,
      open: o,
      high: Math.max(o, c) + spread,
      low: Math.min(o, c) - spread,
      close: c,
      volume: vol * (0.7 + ((i * 37) % 10) / 20),
    };
  });
}

/** Random walk with drift: trend legs + noise. */
export function trendingMarket(n: number, start: number, driftPct: number, noisePct: number, seed: number): Candle[] {
  const rnd = mulberry32(seed);
  const closes: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + driftPct / 100 + (rnd() - 0.5) * 2 * (noisePct / 100);
    closes.push(p);
  }
  return candlesFromCloses(closes);
}

/** Mean-reverting chop around `base`. */
export function chopMarket(n: number, base: number, ampPct: number, seed: number): Candle[] {
  const rnd = mulberry32(seed);
  const closes: number[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    p += (base - p) * 0.2 + (rnd() - 0.5) * 2 * base * (ampPct / 100);
    closes.push(p);
  }
  return candlesFromCloses(closes);
}

/** Regime tape: chop -> uptrend -> chop -> downtrend. */
export function regimeMarket(seed = 7): Candle[] {
  const parts = [
    chopMarket(130, 100, 0.25, seed),
    trendingMarket(140, 100, 0.12, 0.25, seed + 1),
    chopMarket(110, 118, 0.3, seed + 2),
    trendingMarket(140, 118, -0.12, 0.25, seed + 3),
  ];
  const out: Candle[] = [];
  let t = 1700000000000;
  for (const part of parts) {
    for (const c of part) {
      out.push({ ...c, time: t });
      t += 900_000;
    }
  }
  // stitch opens for continuity
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!.close;
    const c = out[i]!;
    const drift = c.open - prev;
    c.open -= drift * 0; // keep simple: opens already continuous within parts
    void drift;
  }
  return out;
}

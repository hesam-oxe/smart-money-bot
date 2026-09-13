/**
 * Hand-rolled indicators — zero dependencies.
 * All series are index-aligned with the input candles; `null` = warmup.
 */
import type { Candle } from './types.js';

export type Num = (number | null)[];

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function sma(values: number[], period: number): Num {
  const out: Num = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Num {
  const out: Num = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export function rma(values: number[], period: number): Num {
  const out: Num = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = prev + (values[i]! - prev) / period;
    out[i] = prev;
  }
  return out;
}

export function trueRange(c: Candle[]): number[] {
  return c.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = c[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export function atr(candles: Candle[], period: number): Num {
  return rma(trueRange(candles), period);
}

export function rsi(closes: number[], period = 14): Num {
  const out: Num = new Array(closes.length).fill(null);
  if (closes.length < period + 1 || period <= 0) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export interface AdxOut {
  adx: Num;
  plusDI: Num;
  minusDI: Num;
}

export function adx(candles: Candle[], period = 14): AdxOut {
  const n = candles.length;
  const plusDM = new Array(n).fill(0) as number[];
  const minusDM = new Array(n).fill(0) as number[];
  const tr = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const dn = candles[i - 1]!.low - candles[i]!.low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const sTR = rma(tr, period);
  const sP = rma(plusDM, period);
  const sM = rma(minusDM, period);
  const plusDI: Num = new Array(n).fill(null);
  const minusDI: Num = new Array(n).fill(null);
  const dx = new Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) {
    const t = sTR[i] ?? 0;
    if (t > 0 && sP[i] !== null && sM[i] !== null) {
      const p = (100 * sP[i]!) / t;
      const m = (100 * sM[i]!) / t;
      plusDI[i] = p;
      minusDI[i] = m;
      dx[i] = p + m > 0 ? (100 * Math.abs(p - m)) / (p + m) : 0;
    }
  }
  // ADX = Wilder smoothing of DX; first value seeded, warmup doubled.
  const raw = rma(dx, period);
  const out: Num = new Array(n).fill(null);
  for (let i = 2 * period - 1; i < n; i++) out[i] = raw[i];
  return { adx: out, plusDI, minusDI };
}

export interface SuperTrendOut {
  dir: number[]; // 1 | -1 | 0(warmup)
  line: Num;
}

export function supertrend(candles: Candle[], mult = 3, len = 10): SuperTrendOut {
  const n = candles.length;
  const a = atr(candles, len);
  const dir = new Array(n).fill(0) as number[];
  const line: Num = new Array(n).fill(null);
  let fUp = 0;
  let fDn = 0;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const atrV = a[i];
    if (atrV === null) continue;
    const hl2 = (candles[i]!.high + candles[i]!.low) / 2;
    const bUp = hl2 - mult * atrV;
    const bDn = hl2 + mult * atrV;
    fUp = i === 0 ? bUp : candles[i - 1]!.close > fUp ? Math.max(bUp, fUp) : bUp;
    fDn = i === 0 ? bDn : candles[i - 1]!.close < fDn ? Math.min(bDn, fDn) : bDn;
    if (i > 0) {
      if (candles[i]!.close > fDn) d = 1;
      else if (candles[i]!.close < fUp) d = -1;
      else if (d === 0) d = candles[i]!.close >= hl2 ? 1 : -1;
    }
    dir[i] = d;
    line[i] = d >= 0 ? fUp : fDn;
  }
  return { dir, line };
}

/** Kaufman Efficiency Ratio in [0,1]: 1 = clean trend, 0 = chop. */
export function kaufmanER(closes: number[], len = 10): Num {
  const out: Num = new Array(closes.length).fill(null);
  for (let i = len; i < closes.length; i++) {
    const change = Math.abs(closes[i]! - closes[i - len]!);
    let vol = 0;
    for (let k = i - len + 1; k <= i; k++) vol += Math.abs(closes[k]! - closes[k - 1]!);
    out[i] = vol > 0 ? change / vol : 0;
  }
  return out;
}

export interface UTBotOut {
  trail: Num;
  /** 1 = bull, -1 = bear, 0 = warmup */
  dir: number[];
  buy: number[];
  sell: number[];
  /** per-bar adaptive multiplier applied to keyValue (1 in classic mode) */
  adapt: Num;
}

export interface UTBotOpts {
  /** strip all adaptive layers: pure ATR x keyValue trail */
  classic?: boolean;
  /** how strongly chop widens the trail (0 disables adaptation width) */
  chopStrength?: number;
}

/**
 * UT Bot ATR trailing stop (classic algorithm, momentum-adaptive by default).
 * Signals flip on bar close only — no repaint by construction.
 */
export function utbot(
  candles: Candle[],
  keyValue = 1.5,
  atrLen = 10,
  opts: UTBotOpts = {},
): UTBotOut {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const a = atr(candles, atrLen);
  const er = kaufmanER(closes, 10);
  const trail: Num = new Array(n).fill(null);
  const adapt: Num = new Array(n).fill(null);
  const dir = new Array(n).fill(0) as number[];
  const buy: number[] = [];
  const sell: number[] = [];
  const chop = opts.chopStrength ?? 1.0;

  let prevTrail = 0;
  let prevDir = 0;
  for (let i = 0; i < n; i++) {
    const atrV = a[i];
    if (atrV === null || atrV <= 0) continue;
    // Chop (low ER) widens the trail to avoid whipsaw; clean trends tighten it.
    const e = er[i] ?? 0.5;
    const ad = opts.classic ? 1 : clamp(1 + chop * (0.5 - e), 0.6, 1.9);
    adapt[i] = ad;
    const nLoss = keyValue * ad * atrV;
    const close = closes[i]!;
    const prevClose = i > 0 ? closes[i - 1]! : close;
    // Ratcheting trailing stop.
    let t: number;
    if (close > prevTrail && prevClose > prevTrail) t = Math.max(prevTrail, close - nLoss);
    else if (close < prevTrail && prevClose < prevTrail) t = Math.min(prevTrail, close + nLoss);
    else t = close > prevTrail ? close - nLoss : close + nLoss;
    trail[i] = t;
    let d = prevDir;
    if (prevClose < prevTrail && close > prevTrail) d = 1;
    else if (prevClose > prevTrail && close < prevTrail) d = -1;
    else if (d === 0) d = close >= t ? 1 : -1;
    dir[i] = d;
    if (prevDir !== 0 && d !== prevDir) {
      if (d === 1) buy.push(i);
      else sell.push(i);
    }
    prevTrail = t;
    prevDir = d;
  }
  return { trail, dir, buy, sell, adapt };
}

/** Rolling VWAP over the last `window` bars (24/7 crypto has no session). */
export function rollingVwap(candles: Candle[], window: number): Num {
  const n = candles.length;
  const out: Num = new Array(n).fill(null);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const tp = (candles[i]!.high + candles[i]!.low + candles[i]!.close) / 3;
    const v = candles[i]!.volume;
    num += tp * v;
    den += v;
    if (i >= window) {
      const o = candles[i - window]!;
      const otp = (o.high + o.low + o.close) / 3;
      num -= otp * o.volume;
      den -= o.volume;
    }
    if (i >= window - 1) out[i] = den > 0 ? num / den : null;
  }
  return out;
}

/** VWAP anchored at `anchorIdx` (e.g. the current wave start). Null before anchor. */
export function anchoredVwap(candles: Candle[], anchorIdx: number): Num {
  const out: Num = new Array(candles.length).fill(null);
  let num = 0;
  let den = 0;
  for (let i = Math.max(0, anchorIdx); i < candles.length; i++) {
    const tp = (candles[i]!.high + candles[i]!.low + candles[i]!.close) / 3;
    const v = candles[i]!.volume;
    num += tp * v;
    den += v;
    out[i] = den > 0 ? num / den : candles[i]!.close;
  }
  return out;
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(v, 0));
}

/** z-score of a value vs a distribution (0 when degenerate). */
export function zscoreOf(value: number, m: number, sd: number): number {
  if (!Number.isFinite(value) || sd < 1e-9) return 0;
  return (value - m) / sd;
}

/**
 * Regular RSI divergences on confirmed swing pivots.
 * Bearish: higher price high + lower RSI high. Bullish: mirrored on lows.
 */
export function rsiDivergence(
  candles: Candle[],
  rsiArr: Num,
  swingHighs: { idx: number }[],
  swingLows: { idx: number }[],
): { bull: Set<number>; bear: Set<number> } {
  const bull = new Set<number>();
  const bear = new Set<number>();
  for (let k = 1; k < swingHighs.length; k++) {
    const a = swingHighs[k - 1]!;
    const b = swingHighs[k]!;
    const ra = rsiArr[a.idx];
    const rb = rsiArr[b.idx];
    if (ra === null || ra === undefined || rb === null || rb === undefined) continue;
    if (candles[b.idx]!.high > candles[a.idx]!.high && rb < ra) bear.add(b.idx);
  }
  for (let k = 1; k < swingLows.length; k++) {
    const a = swingLows[k - 1]!;
    const b = swingLows[k]!;
    const ra = rsiArr[a.idx];
    const rb = rsiArr[b.idx];
    if (ra === null || ra === undefined || rb === null || rb === undefined) continue;
    if (candles[b.idx]!.low < candles[a.idx]!.low && rb > ra) bull.add(b.idx);
  }
  return { bull, bear };
}

/** Weighted moving average (linear weights 1..period). */
export function wma(values: number[], period: number): Num {
  const out: Num = new Array(values.length).fill(null);
  if (period < 1) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) num += values[i - period + 1 + j]! * (j + 1);
    out[i] = num / denom;
  }
  return out;
}

/**
 * Hull moving average: WMA(n/2)*2 - WMA(n), smoothed by WMA(sqrt(n)).
 * Fast yet smooth — direction flips mark momentum turns.
 */
export function hullMA(closes: number[], period = 21): Num {
  const n = closes.length;
  const out: Num = new Array(n).fill(null);
  const half = Math.max(1, Math.floor(period / 2));
  const sq = Math.max(1, Math.round(Math.sqrt(period)));
  const wHalf = wma(closes, half);
  const wFull = wma(closes, period);
  const diff: number[] = closes.map((_, i) => {
    const a = wHalf[i];
    const b = wFull[i];
    return a === null || a === undefined || b === null || b === undefined ? NaN : 2 * a - b;
  });
  const denom = (sq * (sq + 1)) / 2;
  for (let i = 0; i < n; i++) {
    let num = 0;
    let ok = i - sq + 1 >= 0;
    if (ok) {
      for (let j = 0; j < sq; j++) {
        const v = diff[i - sq + 1 + j]!;
        if (!Number.isFinite(v)) {
          ok = false;
          break;
        }
        num += v * (j + 1);
      }
    }
    out[i] = ok ? num / denom : null;
  }
  return out;
}

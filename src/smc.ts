/**
 * Smart Money Concepts: swings, market structure (BOS/CHoCH), validated order
 * blocks, fair value gaps and clustered S/R zones.
 *
 * Order blocks are "double-checked real": a block only counts as VALID when
 * the displacement leg is confirmed AND (a fair value gap formed inside the
 * leg OR the block printed a volume spike). Mitigation/break state is tracked
 * bar by bar.
 */
import type { Candle } from './types.js';
import { sma } from './indicators.js';

export interface Swing {
  idx: number;
  price: number;
}

/** Fractal pivots: strictly greater/smaller than every neighbor in window. */
export function swings(candles: Candle[], left = 3, right = 3): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j]!.high >= candles[i]!.high) isHigh = false;
      if (candles[j]!.low <= candles[i]!.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, price: candles[i]!.high });
    if (isLow) lows.push({ idx: i, price: candles[i]!.low });
  }
  return { highs, lows };
}

export interface StructEvent {
  idx: number;
  type: 'BOS' | 'CHoCH';
  dir: 1 | -1;
  price: number;
}

export interface StructureOut {
  /** per-bar bias: 1 bull, -1 bear, 0 undecided */
  bias: number[];
  events: StructEvent[];
}

/**
 * Market structure on CONFIRMED swings only (a swing at `idx` confirms at
 * `idx + right`, so nothing here can repaint).
 */
export function marketStructure(
  candles: Candle[],
  highs: Swing[],
  lows: Swing[],
  right: number,
): StructureOut {
  const n = candles.length;
  const bias = new Array(n).fill(0) as number[];
  const events: StructEvent[] = [];
  let hp = 0;
  let lp = 0;
  let curHigh = -Infinity;
  let curLow = Infinity;
  let b = 0;
  for (let i = 0; i < n; i++) {
    while (hp < highs.length && highs[hp]!.idx + right <= i) {
      curHigh = highs[hp]!.price; // trails to most recent confirmed high
      hp++;
    }
    while (lp < lows.length && lows[lp]!.idx + right <= i) {
      curLow = lows[lp]!.price;
      lp++;
    }
    const c = candles[i]!.close;
    if (b === 0) {
      if (curHigh > -Infinity && c > curHigh) {
        b = 1;
        events.push({ idx: i, type: 'BOS', dir: 1, price: c });
      } else if (curLow < Infinity && c < curLow) {
        b = -1;
        events.push({ idx: i, type: 'BOS', dir: -1, price: c });
      }
    } else if (b === 1) {
      if (curHigh > -Infinity && c > curHigh) events.push({ idx: i, type: 'BOS', dir: 1, price: c });
      else if (curLow < Infinity && c < curLow) {
        b = -1;
        events.push({ idx: i, type: 'CHoCH', dir: -1, price: c });
      }
    } else {
      if (curLow < Infinity && c < curLow) events.push({ idx: i, type: 'BOS', dir: -1, price: c });
      else if (curHigh > -Infinity && c > curHigh) {
        b = 1;
        events.push({ idx: i, type: 'CHoCH', dir: 1, price: c });
      }
    }
    bias[i] = b;
  }
  return { bias, events };
}

export interface OrderBlock {
  dir: 1 | -1;
  /** bar of the block candle itself */
  obIdx: number;
  /** bar where the displacement leg was confirmed */
  createdIdx: number;
  top: number;
  bottom: number;
  /** displacement + (FVG in leg OR volume spike): the "double check" */
  valid: boolean;
  brokenIdx: number | null;
  mitigated: boolean;
  /** leg size in ATRs */
  displacement: number;
}

export interface OBOptions {
  minAtr?: number;
  maxBars?: number;
  lookback?: number;
  volMult?: number;
  volAvg?: number;
}

function hasBullFvg(candles: Candle[], from: number, to: number): boolean {
  for (let k = Math.max(from + 2, 2); k <= Math.min(to, candles.length - 1); k++) {
    if (candles[k]!.low > candles[k - 2]!.high) return true;
  }
  return false;
}

function hasBearFvg(candles: Candle[], from: number, to: number): boolean {
  for (let k = Math.max(from + 2, 2); k <= Math.min(to, candles.length - 1); k++) {
    if (candles[k]!.high < candles[k - 2]!.low) return true;
  }
  return false;
}

export function orderBlocks(
  candles: Candle[],
  atrArr: ((number | null)[]),
  opts: OBOptions = {},
): OrderBlock[] {
  const { minAtr = 1.0, maxBars = 5, lookback = 3, volMult = 1.5, volAvg = 20 } = opts;
  const n = candles.length;
  const vols = candles.map((c) => c.volume);
  const vma = sma(vols, volAvg);
  const out: OrderBlock[] = [];

  for (let i = volAvg; i < n - maxBars; i++) {
    const a = atrArr[i];
    if (a === null || a <= 0) continue;
    const c = candles[i]!.close;
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 1; k <= maxBars; k++) {
      hh = Math.max(hh, candles[i + k]!.high);
      ll = Math.min(ll, candles[i + k]!.low);
    }
    // Bullish displacement leg -> bearish block candle before it.
    if (hh - c > minAtr * a) {
      let j = -1;
      for (let k = i; k >= Math.max(0, i - lookback); k--) {
        if (candles[k]!.close < candles[k]!.open) {
          j = k;
          break;
        }
      }
      if (j >= 0) {
        const vAvg = vma[j] ?? 0;
        const spike = vAvg > 0 && vols[j]! > volMult * vAvg;
        out.push({
          dir: 1,
          obIdx: j,
          createdIdx: i,
          top: candles[j]!.high,
          bottom: candles[j]!.low,
          valid: hasBullFvg(candles, j, i + maxBars) || spike,
          brokenIdx: null,
          mitigated: false,
          displacement: (hh - c) / a,
        });
      }
    }
    // Bearish displacement leg -> bullish block candle before it.
    if (c - ll > minAtr * a) {
      let j = -1;
      for (let k = i; k >= Math.max(0, i - lookback); k--) {
        if (candles[k]!.close > candles[k]!.open) {
          j = k;
          break;
        }
      }
      if (j >= 0) {
        const vAvg = vma[j] ?? 0;
        const spike = vAvg > 0 && vols[j]! > volMult * vAvg;
        out.push({
          dir: -1,
          obIdx: j,
          createdIdx: i,
          top: candles[j]!.high,
          bottom: candles[j]!.low,
          valid: hasBearFvg(candles, j, i + maxBars) || spike,
          brokenIdx: null,
          mitigated: false,
          displacement: (c - ll) / a,
        });
      }
    }
  }

  // Mitigation pass: a block dies on a close through it, weakens on a 50% touch.
  for (const ob of out) {
    const mid = (ob.top + ob.bottom) / 2;
    for (let k = ob.createdIdx + 1; k < n; k++) {
      const b = candles[k]!;
      if (ob.dir === 1) {
        if (b.close < ob.bottom) {
          ob.brokenIdx = k;
          break;
        }
        if (b.low <= mid) ob.mitigated = true;
      } else {
        if (b.close > ob.top) {
          ob.brokenIdx = k;
          break;
        }
        if (b.high >= mid) ob.mitigated = true;
      }
    }
  }
  return out;
}

/** Blocks that were alive at bar `idx` (created, valid, not yet broken). */
export function activeOBs(obs: OrderBlock[], idx: number): OrderBlock[] {
  return obs.filter((o) => o.valid && o.createdIdx <= idx && (o.brokenIdx === null || o.brokenIdx > idx));
}

export interface FVG {
  idx: number;
  dir: 1 | -1;
  top: number;
  bottom: number;
  filled: boolean;
  filledIdx: number | null;
}

export function fairValueGaps(candles: Candle[]): FVG[] {
  const out: FVG[] = [];
  for (let i = 2; i < candles.length; i++) {
    if (candles[i]!.low > candles[i - 2]!.high) {
      out.push({ idx: i, dir: 1, top: candles[i]!.low, bottom: candles[i - 2]!.high, filled: false, filledIdx: null });
    } else if (candles[i]!.high < candles[i - 2]!.low) {
      out.push({ idx: i, dir: -1, top: candles[i - 2]!.low, bottom: candles[i]!.high, filled: false, filledIdx: null });
    }
  }
  for (const g of out) {
    for (let k = g.idx + 1; k < candles.length; k++) {
      const b = candles[k]!;
      if ((g.dir === 1 && b.low <= g.bottom) || (g.dir === -1 && b.high >= g.top)) {
        g.filled = true;
        g.filledIdx = k;
        break;
      }
    }
  }
  return out;
}

export interface Zone {
  dir: 1 | -1; // 1 = support, -1 = resistance
  price: number;
  top: number;
  bottom: number;
  touches: number;
}

/** Cluster swing pivots into persistent S/R zones (nearest S/R wins for display). */
export function buildZones(swings: Swing[], dir: 1 | -1, tol: number): Zone[] {
  const sorted = [...swings].sort((a, b) => (dir === 1 ? b.price - a.price : a.price - b.price));
  const zones: Zone[] = [];
  for (const s of sorted) {
    const z = zones.find((zz) => Math.abs(zz.price - s.price) <= tol);
    if (z) {
      z.price = (z.price * z.touches + s.price) / (z.touches + 1);
      z.top = Math.max(z.top, s.price);
      z.bottom = Math.min(z.bottom, s.price);
      z.touches++;
    } else {
      zones.push({ dir, price: s.price, top: s.price, bottom: s.price, touches: 1 });
    }
  }
  return zones.sort((a, b) => b.price - a.price);
}

export function nearestZones(zones: Zone[], price: number): { above: Zone | null; below: Zone | null } {
  let above: Zone | null = null;
  let below: Zone | null = null;
  for (const z of zones) {
    if (z.price >= price && (above === null || z.price < above.price)) above = z;
    if (z.price <= price && (below === null || z.price > below.price)) below = z;
  }
  return { above, below };
}

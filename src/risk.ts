/**
 * Risk: structural anti-stop-hunt HARD stops, R-multiple take profits,
 * risk-based position sizing and logarithmic performance stats.
 */
import type { BacktestStats, Side, Trade } from './types.js';
import type { Swing } from './smc.js';

export type SLMethod = 'structural' | 'atr' | 'scaled' | 'smart' | 'safer' | 'percent' | 'tick';

export interface SLContext {
  swing: number | null; // structural reference: recent swing low (long) / high (short)
  atr: number;
  atrPct: number; // atr / entry
  huntMult: number; // anti-hunt buffer in ATRs beyond structure
  atrMult: number; // base ATR multiple for atr-based methods
  pct: number; // % distance for the percent method
  ticks: number; // price steps for the tick method
}

export interface SLResult {
  price: number;
  method: SLMethod;
}

/** Most recent swing extreme of the protective side, within `lookback` bars. */
export function swingRef(
  side: Side,
  idx: number,
  highs: Swing[],
  lows: Swing[],
  lookback = 50,
): number | null {
  const arr = side === 'long' ? lows : highs;
  for (let k = arr.length - 1; k >= 0; k--) {
    const s = arr[k]!;
    if (s.idx < idx && idx - s.idx <= lookback) return s.price;
    if (s.idx < idx - lookback) break;
  }
  return null;
}

function atrStop(side: Side, entry: number, atr: number, mult: number): number {
  return side === 'long' ? entry - atr * mult : entry + atr * mult;
}

/**
 * Compute a HARD stop price. Structural = beyond the swing extreme plus an
 * anti-hunt ATR buffer (stop-hunters spike the obvious level; we sit behind it).
 */
export function computeSL(method: SLMethod, side: Side, entry: number, ctx: SLContext): SLResult {
  const used: SLMethod = method === 'structural' && ctx.swing === null ? 'atr' : method;
  const s = side === 'long' ? -1 : 1;
  switch (used) {
    case 'structural': {
      const ref = ctx.swing!;
      const price = ref + s * ctx.atr * ctx.huntMult;
      // never allow a "stop" on the wrong side of entry (can happen on parabolic legs)
      const fixed = side === 'long' ? Math.min(price, atrStop(side, entry, ctx.atr, ctx.atrMult)) : Math.max(price, atrStop(side, entry, ctx.atr, ctx.atrMult));
      return { price: fixed, method: used };
    }
    case 'atr':
      return { price: atrStop(side, entry, ctx.atr, ctx.atrMult), method: used };
    case 'scaled':
      return { price: atrStop(side, entry, ctx.atr, ctx.atrMult + 0.5), method: used };
    case 'smart': {
      // auto-scales with the volatility regime: calm -> ~1.0x, wild -> ~2.5x ATR
      const k = Math.min(2.5, Math.max(1.0, 1 + (ctx.atrPct - 0.003) * 100));
      return { price: atrStop(side, entry, ctx.atr, k), method: used };
    }
    case 'safer': {
      // widest of several candidates
      const cands = [
        atrStop(side, entry, ctx.atr, ctx.atrMult),
        atrStop(side, entry, ctx.atr, ctx.atrMult + 0.5),
        ctx.swing === null
          ? atrStop(side, entry, ctx.atr, ctx.atrMult)
          : ctx.swing + s * ctx.atr * ctx.huntMult,
      ];
      const price = side === 'long' ? Math.min(...cands) : Math.max(...cands);
      return { price, method: used };
    }
    case 'percent': {
      const d = entry * (ctx.pct / 100);
      return { price: side === 'long' ? entry - d : entry + d, method: used };
    }
    case 'tick': {
      // crypto spot has no contract tick — derive a venue-like step from price magnitude
      // (e.g. 1.0 steps at 77k BTC, 0.1 at 2.5k ETH). Use hundreds of ticks for sane stops.
      const tickSize = Math.pow(10, Math.floor(Math.log10(Math.max(entry, 1e-9))) - 4);
      const d = tickSize * ctx.ticks;
      return { price: side === 'long' ? entry - d : entry + d, method: used };
    }
  }
}

/** R-multiple take-profit prices. R = |entry - sl|. */
export function takeProfits(entry: number, sl: number, side: Side, rs = [1, 1.5, 2, 3]): number[] {
  const r = Math.abs(entry - sl);
  return rs.map((m) => (side === 'long' ? entry + m * r : entry - m * r));
}

/** Position size so that hitting SL loses exactly `riskPct` of equity. */
export function sizeForRisk(
  equity: number,
  riskPct: number,
  entry: number,
  sl: number,
): { qty: number; riskUsd: number } {
  const riskUsd = (equity * riskPct) / 100;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return { qty: 0, riskUsd };
  return { qty: riskUsd / dist, riskUsd };
}

/** Trade-level + logarithmic stats from closed paper trades. */
export function summarizeTrades(trades: Trade[], equity0: number): BacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  // equity path for drawdown + log returns
  let eq = equity0;
  const path = [eq];
  for (const t of trades) {
    eq += t.pnl;
    path.push(eq);
  }
  let peak = path[0]!;
  let maxDD = 0;
  for (const v of path) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, (peak - v) / peak);
  }
  const logRets: number[] = [];
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1]! > 0 && path[i]! > 0) logRets.push(Math.log(path[i]! / path[i - 1]!));
  }
  const totalLogReturn = logRets.reduce((a, b) => a + b, 0);
  let sharpeLike = 0;
  if (logRets.length > 1) {
    const m = logRets.reduce((a, b) => a + b, 0) / logRets.length;
    const v = logRets.reduce((a, b) => a + (b - m) * (b - m), 0) / (logRets.length - 1);
    const sd = Math.sqrt(Math.max(v, 0));
    sharpeLike = sd > 1e-12 ? (m / sd) * Math.sqrt(logRets.length) : 0;
  }
  const avgR = (ts: Trade[]): number => (ts.length ? ts.reduce((a, t) => a + t.rMultiple, 0) / ts.length : 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : 0,
    expectancyR: avgR(trades),
    totalPnl,
    totalReturnPct: ((eq - equity0) / equity0) * 100,
    totalLogReturn,
    sharpeLike,
    maxDrawdownPct: maxDD * 100,
    avgWinnerR: avgR(wins),
    avgLoserR: avgR(losses),
  };
}

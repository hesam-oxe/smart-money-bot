/**
 * Live paper positions — pure per-bar updates, no network, fully testable.
 * Rules: SL checked first (conservative), TP1 banks half + arms breakeven,
 * final TP exits the rest. Works for both live loop and (later) broker fills.
 */
import type { Candle, Side } from './types.js';

/** Fraction of the position banked when TP1 touches. */
export const PARTIAL_FRAC = 0.5;

export interface LivePosition {
  id: string;
  pair: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  /** first R target — touching it banks PARTIAL_FRAC + moves the stop to entry */
  tp1: number;
  size: number;
  entryTime: number;
  barsHeld: number;
  forecastBars: number;
  signalId: string;
  breakeven: boolean;
  /** 0..1 of size already banked via partials */
  closedFrac: number;
  /** net PnL banked via partials (fees already deducted) */
  realizedPnl: number;
}

export interface FillEvent {
  /** full exit of the REMAINING size (price + reason), if any */
  exit: { price: number; reason: 'sl' | 'tp' } | null;
  /** partial fill banked on this bar, if any */
  partial: { price: number; frac: number; pnl: number } | null;
  movedStopToBreakeven: boolean;
}

/**
 * Update one position against a fresh bar. Mutates `sl`/`breakeven`/
 * `closedFrac`/`realizedPnl` as rungs fill. A bar that sweeps from TP1
 * through TP banks the partial AND exits the rest (realistic ladder fill).
 */
export function updatePosition(p: LivePosition, bar: Candle, feeBps = 0): FillEvent {
  const stopHit = p.side === 'long' ? bar.low <= p.sl : bar.high >= p.sl;
  if (stopHit) return { exit: { price: p.sl, reason: 'sl' }, partial: null, movedStopToBreakeven: false };

  let partial: FillEvent['partial'] = null;
  let moved = false;
  // bank half at TP1 (skipped when the final target IS TP1 — the exit covers it)
  const beyond = p.side === 'long' ? p.tp > p.tp1 : p.tp < p.tp1;
  const tp1Hit = p.side === 'long' ? bar.high >= p.tp1 : bar.low <= p.tp1;
  if (p.closedFrac === 0 && beyond && tp1Hit) {
    const qty = p.size * PARTIAL_FRAC;
    const { pnl } = closeEconomics(p.side, p.entry, p.tp1, qty, feeBps);
    p.closedFrac = PARTIAL_FRAC;
    p.realizedPnl += pnl;
    p.sl = p.entry;
    p.breakeven = true;
    partial = { price: p.tp1, frac: PARTIAL_FRAC, pnl };
    moved = true;
  }

  const tpHit = p.side === 'long' ? bar.high >= p.tp : bar.low <= p.tp;
  if (tpHit) return { exit: { price: p.tp, reason: 'tp' }, partial, movedStopToBreakeven: moved };
  return { exit: null, partial, movedStopToBreakeven: moved };
}

/** Realized PnL net of round-trip fees. */
export function closeEconomics(
  side: Side,
  entry: number,
  exit: number,
  size: number,
  feeBps: number,
): { pnl: number; fees: number } {
  const fees = (entry * size + exit * size) * (feeBps / 1e4);
  const gross = (side === 'long' ? exit - entry : entry - exit) * size;
  return { pnl: gross - fees, fees };
}

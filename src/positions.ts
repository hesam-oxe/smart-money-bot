/**
 * Live paper positions — pure per-bar updates, no network, fully testable.
 * Rules: SL checked first (conservative), TP1 arms breakeven, chosen TP exits.
 */
import type { Candle, Side } from './types.js';

export interface LivePosition {
  id: string;
  pair: string;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  /** first R target — touching it moves the stop to breakeven */
  tp1: number;
  size: number;
  entryTime: number;
  barsHeld: number;
  forecastBars: number;
  signalId: string;
  breakeven: boolean;
}

export interface PositionEvent {
  exit: { price: number; reason: 'sl' | 'tp' } | null;
  movedStopToBreakeven: boolean;
}

/**
 * Update one position against a fresh bar. Mutates `sl`/`breakeven` when TP1
 * arms the breakeven stop. Never exits on the arming bar itself.
 */
export function updatePosition(p: LivePosition, bar: Candle): PositionEvent {
  if (p.side === 'long') {
    if (bar.low <= p.sl) return { exit: { price: p.sl, reason: 'sl' }, movedStopToBreakeven: false };
    if (bar.high >= p.tp) return { exit: { price: p.tp, reason: 'tp' }, movedStopToBreakeven: false };
    if (!p.breakeven && bar.high >= p.tp1) {
      p.sl = p.entry;
      p.breakeven = true;
      return { exit: null, movedStopToBreakeven: true };
    }
    return { exit: null, movedStopToBreakeven: false };
  }
  if (bar.high >= p.sl) return { exit: { price: p.sl, reason: 'sl' }, movedStopToBreakeven: false };
  if (bar.low <= p.tp) return { exit: { price: p.tp, reason: 'tp' }, movedStopToBreakeven: false };
  if (!p.breakeven && bar.low <= p.tp1) {
    p.sl = p.entry;
    p.breakeven = true;
    return { exit: null, movedStopToBreakeven: true };
  }
  return { exit: null, movedStopToBreakeven: false };
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

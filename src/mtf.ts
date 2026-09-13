/**
 * Multi-timeframe confluence: EMA 9/21 trend state of every higher timeframe,
 * aligned onto base bars by time. Zero lookahead — a base bar only ever sees
 * HTF bars that closed at or before its own time.
 */
import { ema } from './indicators.js';
import { loadCandles } from './data.js';
import type { Candle } from './types.js';

export interface MtfTape {
  minutes: number;
  candles: Candle[];
}

/** Higher timeframes above the base (venue-supported), capped at 5 tapes. */
export function htfsFor(baseMin: number): number[] {
  return [5, 15, 30, 60, 240, 1440, 10080].filter((t) => t > baseMin).slice(0, 5);
}

export async function loadMtfTapes(
  provider: 'kraken' | 'binance',
  pair: string,
  baseMin: number,
  fresh: boolean,
): Promise<MtfTape[]> {
  const out: MtfTape[] = [];
  for (const tf of htfsFor(baseMin)) {
    try {
      const candles = (await loadCandles(provider, pair, tf, { fresh })).closed;
      if (candles.length >= 25) out.push({ minutes: tf, candles });
    } catch {
      /* a missing HTF just weakens the vote — never fatal */
    }
  }
  return out;
}

/**
 * Per-base-bar fraction of HTFs in an EMA9>EMA21 bull state (null = no HTF data).
 * Pointer-walk per tape: O(bars + tape).
 */
export function mtfBullFraction(tapes: MtfTape[], base: Candle[]): (number | null)[] {
  const states = tapes.map((t) => {
    const cl = t.candles.map((c) => c.close);
    const e9 = ema(cl, 9);
    const e21 = ema(cl, 21);
    const bull = e9.map((v, i) => {
      const w = e21[i];
      return v !== null && v !== undefined && w !== null && w !== undefined ? v > w : null;
    });
    return { tape: t, bull };
  });
  const ptrs = new Array(states.length).fill(0) as number[];
  return base.map((b) => {
    let bull = 0;
    let n = 0;
    for (let k = 0; k < states.length; k++) {
      const st = states[k]!;
      const cs = st.tape.candles;
      while (ptrs[k]! + 1 < cs.length && cs[ptrs[k]! + 1]!.time <= b.time) ptrs[k]!++;
      if (cs[ptrs[k]!]!.time > b.time) continue; // base bar older than this tape
      const v = st.bull[ptrs[k]!];
      if (v === null || v === undefined) continue;
      n++;
      if (v) bull++;
    }
    return n ? bull / n : null;
  });
}

export function mtfLabel(minutes: number): string {
  if (minutes >= 10080) return `${minutes / 10080}W`;
  if (minutes >= 1440) return `${minutes / 1440}D`;
  if (minutes >= 60) return `${minutes / 60}H`;
  return `${minutes}m`;
}

/** Last-bar trend snapshot per tape (for the dashboard MTF row). */
export function mtfSnapshot(tapes: MtfTape[]): { tf: string; bull: boolean | null }[] {
  return tapes.map((t) => {
    const cl = t.candles.map((c) => c.close);
    const e9 = ema(cl, 9);
    const e21 = ema(cl, 21);
    const i = cl.length - 1;
    const a = e9[i];
    const w = e21[i];
    const bull = a !== null && a !== undefined && w !== null && w !== undefined ? a > w : null;
    return { tf: mtfLabel(t.minutes), bull };
  });
}

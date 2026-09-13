/** A single OHLCV bar. `time` is unix milliseconds (bar open time). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'long' | 'short';

/** A ranked, tooled-up trade signal. Committed on bar close only (no repaint). */
export interface Signal {
  id: string;
  pair: string;
  time: number;
  side: Side;
  entry: number;
  sl: number;
  slMethod: string;
  /** R-multiple take profits, e.g. [1R, 1.5R, 2R, 3R] prices */
  tps: number[];
  tpRs: number[];
  /** suggested position size in base units (risk-based) */
  size: number;
  /** USD risked on this trade */
  riskUsd: number;
  /** 0-100 confidence from the 7-engine stack */
  confidence: number;
  /** z-score of confidence vs recent signals — ranking key (higher first) */
  z: number;
  /** per-engine score breakdown */
  engines: Record<string, number>;
  /** expected remaining trend life, in bars */
  forecastBars: number;
  forecastLowHistory: boolean;
  /** empirical survival milestones: share of past trends lasting >= pct of projection */
  survival: { pct: number; share: number }[];
  filtersPassed: string[];
}

export interface BlockedFlip {
  pair: string;
  time: number;
  side: Side;
  blockedBy: string[];
  confidence: number;
}

export interface Trade {
  pair: string;
  side: Side;
  entryTime: number;
  entry: number;
  exitTime: number;
  exit: number;
  exitReason: 'tp' | 'sl' | 'time' | 'eod';
  size: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  fees: number;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  totalPnl: number;
  totalReturnPct: number;
  /** sum of log returns — the "logarithmic" performance view */
  totalLogReturn: number;
  sharpeLike: number;
  maxDrawdownPct: number;
  avgWinnerR: number;
  avgLoserR: number;
}

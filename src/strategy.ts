/**
 * Signal engine — Smart Money + UT Bot core on 15m.
 *
 * Pipeline per bar close: UT flip -> hard filters (fake-signal killers) ->
 * 7-engine confidence -> structural trade plan -> trend-duration forecast ->
 * z-score ranking. Signals commit on bar close only (no repaint).
 */
import type { BlockedFlip, Candle, Side, Signal } from './types.js';
import {
  adx,
  anchoredVwap,
  atr,
  clamp,
  ema,
  hullMA,
  mean,
  rollingVwap,
  rsi,
  rsiDivergence,
  sma,
  stdev,
  supertrend,
  utbot,
  zscoreOf,
} from './indicators.js';
import {
  activeOBs,
  buildZones,
  fairValueGaps,
  marketStructure,
  nearestZones,
  orderBlocks,
  swings,
  type OrderBlock,
  type Zone,
} from './smc.js';
import { computeSL, sizeForRisk, swingRef, takeProfits, type SLMethod } from './risk.js';
import { mtfBullFraction, type MtfTape } from './mtf.js';

export type TradingStyle = 'auto' | 'scalping' | 'day' | 'swing' | 'position' | 'custom';

export interface StylePreset {
  utKey: number;
  utAtrLen: number;
  atrMult: number;
  chopStrength: number;
  label: string;
}

/** 1-click trading styles (sensitivity / ATR / stop matched to the horizon). */
export const STYLE_PRESETS: Record<Exclude<TradingStyle, 'auto' | 'custom'>, StylePreset> = {
  scalping: { utKey: 1.0, utAtrLen: 7, atrMult: 1.0, chopStrength: 1.5, label: 'Scalping 1-5m' },
  day: { utKey: 1.5, utAtrLen: 10, atrMult: 1.3, chopStrength: 1.0, label: 'Day 15m-1h' },
  swing: { utKey: 2.0, utAtrLen: 14, atrMult: 1.8, chopStrength: 0.8, label: 'Swing 4h-D' },
  position: { utKey: 2.5, utAtrLen: 20, atrMult: 2.3, chopStrength: 0.6, label: 'Position D-W' },
};

/** Auto style from the chart timeframe (matches the preset bands above). */
export function styleForTimeframe(minutes: number): Exclude<TradingStyle, 'auto' | 'custom'> {
  if (minutes <= 5) return 'scalping';
  if (minutes <= 60) return 'day';
  if (minutes <= 1440) return 'swing';
  return 'position';
}

export type ForecastMode = 'simple' | 'standard' | 'advanced';

export interface StrategyConfig {
  style: TradingStyle;
  utKey: number;
  utAtrLen: number;
  classicUt: boolean;
  chopStrength: number;
  emaTrendLen: number;
  vwapWindow: number;
  useAdx: boolean;
  adxLen: number;
  adxMin: number;
  useEmaTrend: boolean;
  useVwap: boolean;
  useMtf: boolean;
  mtfMinAgree: number;
  useRegime: boolean;
  regimeAdxMin: number;
  useVolume: boolean;
  volLen: number;
  volMin: number;
  useFullCandle: boolean;
  useZoneFilter: boolean;
  useVolatility: boolean;
  minAtrPct: number;
  maxAtrPct: number;
  useStructure: boolean;
  useRsiFilter: boolean;
  useSupertrendFilter: boolean;
  useHullFilter: boolean;
  cooldownBars: number;
  confirmBars: number;
  swingLeft: number;
  swingRight: number;
  minConfidence: number;
  forecastMode: ForecastMode;
  slMethod: SLMethod;
  huntMult: number;
  atrMult: number;
  slPct: number;
  slTicks: number;
  tpRs: number[];
  equity: number;
  riskPct: number;
  forecastAlpha: number;
  scoreWindow: number;
}

/** Day-trading preset tuned for 15m (UT sens 1.5 / ATR 10 / stop 1.3). */
export const PRESET_15M: StrategyConfig = {
  style: 'day',
  utKey: 1.5,
  utAtrLen: 10,
  classicUt: false,
  chopStrength: 1.0,
  emaTrendLen: 200,
  vwapWindow: 96, // 24h of 15m bars
  useAdx: true,
  adxLen: 14,
  adxMin: 12,
  useEmaTrend: true,
  useVwap: true,
  useMtf: true,
  mtfMinAgree: 0.5,
  useRegime: true,
  regimeAdxMin: 10,
  useVolume: true,
  volLen: 20,
  volMin: 1.0,
  useFullCandle: false,
  useZoneFilter: true,
  useVolatility: true,
  minAtrPct: 0.0005,
  maxAtrPct: 0.05,
  useStructure: true,
  useRsiFilter: false,
  useSupertrendFilter: false,
  useHullFilter: false,
  cooldownBars: 2,
  confirmBars: 2,
  swingLeft: 3,
  swingRight: 3,
  minConfidence: 40,
  forecastMode: 'standard',
  slMethod: 'structural',
  huntMult: 0.5,
  atrMult: 1.3,
  slPct: 1.0,
  slTicks: 200,
  tpRs: [1, 1.5, 2, 3],
  equity: 10000,
  riskPct: 1,
  forecastAlpha: 0.3,
  scoreWindow: 50,
};

export interface EngineOut {
  signals: Signal[];
  blocked: BlockedFlip[];
  flips: number;
  zones: Zone[];
  orderBlocks: OrderBlock[];
  bias: number[];
}

function anchoredAt(candles: Candle[], anchor: number, i: number): number | null {
  let num = 0;
  let den = 0;
  for (let k = Math.max(0, anchor); k <= i; k++) {
    const tp = (candles[k]!.high + candles[k]!.low + candles[k]!.close) / 3;
    num += tp * candles[k]!.volume;
    den += candles[k]!.volume;
  }
  return den > 0 ? num / den : null;
}

export interface ForecastCtx {
  zoneDistAtr: number;
  volRel: number;
  filtersPassed: number;
  adx: number;
  atrPct: number;
  medAtrPct: number;
}

/**
 * Trend-duration forecast from this side's completed-trend history.
 * simple = median; standard = EWMA; advanced = EWMA x 5 adaptive multipliers
 * (S/R proximity, flip strength, error-learning proxy, regime, volatility profile).
 */
export function forecastDuration(
  hist: number[],
  mode: ForecastMode,
  alpha: number,
  ctx: ForecastCtx,
): { bars: number; mults: Record<string, number> | null } {
  if (hist.length < 3) return { bars: 10, mults: null };
  if (mode === 'simple') {
    const sorted = [...hist].sort((a, b) => a - b);
    return { bars: clamp(Math.round(sorted[Math.floor(sorted.length / 2)]!), 1, 500), mults: null };
  }
  let ew = hist[0]!;
  for (const d of hist.slice(1)) ew = alpha * d + (1 - alpha) * ew;
  if (mode !== 'advanced') return { bars: clamp(Math.round(ew), 1, 500), mults: null };
  const mStructure = ctx.zoneDistAtr < 1 ? 0.8 : ctx.zoneDistAtr > 3 ? 1.1 : 1.0;
  const mFlip = (ctx.volRel >= 1.5 ? 1.1 : ctx.volRel >= 1 ? 1.0 : 0.9) * (ctx.filtersPassed >= 8 ? 1.05 : 1.0);
  const recent = hist.slice(-3);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const mError = clamp(recentMean / Math.max(ew, 1e-9), 0.85, 1.15);
  const mRegime = ctx.adx >= 25 ? 1.1 : ctx.adx < 12 ? 0.85 : 1.0;
  const mAsset = ctx.atrPct > 2 * ctx.medAtrPct ? 0.9 : ctx.atrPct < 0.5 * ctx.medAtrPct ? 1.1 : 1.0;
  const mults = { structure: mStructure, flip: mFlip, errorLearn: mError, regime: mRegime, asset: mAsset };
  const bars = clamp(Math.round(ew * mStructure * mFlip * mError * mRegime * mAsset), 1, 500);
  return { bars, mults };
}

export function runEngine(
  c15: Candle[],
  mtfTapes: MtfTape[] | null,
  pair: string,
  cfg: StrategyConfig,
  regimeADX: (number | null)[] | null = null,
): EngineOut {
  const n = c15.length;
  const closes = c15.map((c) => c.close);
  const vols = c15.map((c) => c.volume);

  const emaT = ema(closes, cfg.emaTrendLen);
  const atrS = atr(c15, cfg.utAtrLen);
  const ut = utbot(c15, cfg.utKey, cfg.utAtrLen, { classic: cfg.classicUt, chopStrength: cfg.chopStrength });
  const st = supertrend(c15, 3, 10);
  const rsiS = rsi(closes, 14);
  const hull = hullMA(closes, 21);
  const adxS = adx(c15, cfg.adxLen);
  const vwap = rollingVwap(c15, cfg.vwapWindow);
  const vma = sma(vols, cfg.volLen);
  const sw = swings(c15, cfg.swingLeft, cfg.swingRight);
  const struct = marketStructure(c15, sw.highs, sw.lows, cfg.swingRight);
  const obs = orderBlocks(c15, atrS);
  fairValueGaps(c15); // computed for OB validation + future use
  const divs = rsiDivergence(c15, rsiS, sw.highs, sw.lows);
  const mtfBull = mtfTapes && mtfTapes.length ? mtfBullFraction(mtfTapes, c15) : new Array(n).fill(null);

  // S/R zones from confirmed swing pivots only (causal: no future swings at bar i).
  // Tolerance 1.0xATR merges pivots into real clusters; only multi-touch zones veto.
  const atrVals = atrS.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const medAtr = atrVals.length ? atrVals[Math.floor(atrVals.length / 2)]! : 1;
  const atrPctVals = c15
    .map((c, i) => (atrS[i] !== null ? atrS[i]! / c.close : null))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const medAtrPct = atrPctVals.length ? atrPctVals[Math.floor(atrPctVals.length / 2)]! : 0.003;
  const zonesAt = (i: number): Zone[] => {
    const hi = sw.highs.filter((s) => s.idx + cfg.swingRight <= i);
    const lo = sw.lows.filter((s) => s.idx + cfg.swingRight <= i);
    return [...buildZones(hi, -1, medAtr), ...buildZones(lo, 1, medAtr)];
  };
  // broken-through levels drop off: resistance must sit above price, support below
  const lastClose = closes[n - 1] ?? 0;
  const zones = zonesAt(n - 1).filter((z) => (z.dir === -1 ? z.price > lastClose : z.price < lastClose));

  const confirmN = Math.max(1, Math.round(cfg.confirmBars));
  const warm = Math.max(cfg.emaTrendLen + 5, 220);
  const signals: Signal[] = [];
  const blocked: BlockedFlip[] = [];
  const scoreHist: number[] = [];
  const durations: Record<Side, number[]> = { long: [], short: [] };
  let flips = 0;
  let lastFlip = warm;
  let lastDir = ut.dir[warm] ?? 0;
  let lastSignalBar = -1e9;
  let pending: { side: Side; flipBar: number; dueBar: number } | null = null;

  const emitFlip = (i: number, side: Side): void => {
    const close = c15[i]!.close;
    const a = atrS[i] ?? 0;
    const passed: string[] = [];
    const failed: string[] = [];
    const sgn = side === 'long' ? 1 : -1;

    // — hard filters (fake-signal killers) —
    // market-regime guard: BTC-chop shuts down new signals (missing data = neutral)
    if (cfg.useRegime && regimeADX) {
      const rax = regimeADX[i];
      if (rax === null || rax === undefined) passed.push('regime(nodata)');
      else rax >= cfg.regimeAdxMin ? passed.push('regime') : failed.push(`regime(chop-${rax.toFixed(0)})`);
    }
    if (cfg.useAdx) {
      const ax = adxS.adx[i] ?? 0;
      const diOk = side === 'long' ? (adxS.plusDI[i] ?? 0) > (adxS.minusDI[i] ?? 0) : (adxS.minusDI[i] ?? 0) > (adxS.plusDI[i] ?? 0);
      ax >= cfg.adxMin && diOk ? passed.push('adx-regime') : failed.push(`adx-regime(${ax.toFixed(1)})`);
    }
    if (cfg.useEmaTrend) {
      const e = emaT[i];
      const ok = e !== null && e !== undefined && (side === 'long' ? close > e : close < e);
      ok ? passed.push('ema200-trend') : failed.push('ema200-trend');
    }
    if (cfg.useVwap) {
      const rv = vwap[i];
      const av = anchoredAt(c15, lastFlip, i);
      const ok =
        rv !== null && rv !== undefined && av !== null && (side === 'long' ? close > rv && close > av : close < rv && close < av);
      ok ? passed.push('vwap-side') : failed.push('vwap-side');
    }
    if (cfg.useMtf) {
      const bf = mtfBull[i];
      if (bf === null || bf === undefined) passed.push('mtf(nodata)');
      else {
        const agree = side === 'long' ? bf : 1 - bf;
        agree >= cfg.mtfMinAgree ? passed.push('mtf') : failed.push(`mtf(${agree.toFixed(2)})`);
      }
    }
    if (cfg.useVolume) {
      const avg = vma[i] ?? 0;
      const rel = avg > 0 ? vols[i]! / avg : 0;
      rel >= cfg.volMin ? passed.push('volume') : failed.push(`volume(${rel.toFixed(2)}x)`);
    }
    if (cfg.useFullCandle) {
      const t = ut.trail[i] ?? 0;
      const ok = side === 'long' ? c15[i]!.low > t : c15[i]!.high < t;
      ok ? passed.push('full-candle') : failed.push('full-candle');
    }
    if (cfg.useVolatility) {
      const pct = a > 0 ? a / close : 0;
      pct >= cfg.minAtrPct && pct <= cfg.maxAtrPct ? passed.push('volatility-band') : failed.push('volatility-band');
    }
    if (i - lastSignalBar < cfg.cooldownBars) failed.push('cooldown');
    else passed.push('cooldown');
    if (cfg.useZoneFilter) {
      // strong + still standing: broken-through levels never veto
      const strong = zonesAt(i).filter(
        (z) => z.touches >= 2 && (z.dir === -1 ? z.price > close : z.price < close),
      );
      const { above, below } = nearestZones(strong, close);
      const opp = side === 'long' ? above : below;
      const dist = opp ? Math.abs(opp.price - close) : Infinity;
      dist > 0.5 * a ? passed.push('zone') : failed.push('zone(into-SR)');
    }
    // structure alignment (bias agrees OR fresh BOS/CHoCH in our direction)
    if (cfg.useStructure) {
      const agree = struct.bias[i] === sgn;
      const fresh = struct.events.some((e) => e.dir === sgn && i - e.idx <= 8);
      agree || fresh ? passed.push('structure') : failed.push('structure');
    } else {
      passed.push('structure(off)');
    }
    if (cfg.useRsiFilter) {
      const r = rsiS[i];
      if (r === null || r === undefined) passed.push('rsi(nodata)');
      else (side === 'long' ? r > 50 : r < 50) ? passed.push('rsi') : failed.push(`rsi(${r.toFixed(0)})`);
    }
    if (cfg.useSupertrendFilter) {
      st.dir[i] === sgn ? passed.push('supertrend') : failed.push('supertrend');
    }
    if (cfg.useHullFilter) {
      const h0 = hull[i];
      const h1 = hull[i - 1];
      if (h0 === null || h0 === undefined || h1 === null || h1 === undefined) passed.push('hull(nodata)');
      else (side === 'long' ? h0 > h1 : h0 < h1) ? passed.push('hull') : failed.push('hull');
    }

    if (failed.length) {
      blocked.push({ pair, time: c15[i]!.time, side, blockedBy: failed, confidence: 0 });
      return;
    }

    // — 7-engine confidence (0-100) —
    const engines: Record<string, number> = {};
    {
      const t = ut.trail[i] ?? close;
      engines['ut-bot'] = 8 + 7 * Math.min(1, Math.abs(close - t) / Math.max(a, 1e-9) / 2);
    }
    {
      const ln = st.line[i];
      if (st.dir[i] === sgn && ln !== null && ln !== undefined) engines['supertrend'] = 10 + 5 * Math.min(1, Math.abs(close - ln) / Math.max(a, 1e-9) / 2);
      else engines['supertrend'] = 0;
    }
    {
      let s = struct.bias[i] === sgn ? 10 : 0;
      if (struct.events.some((e) => e.dir === sgn && i - e.idx <= 10)) s += 5;
      engines['structure'] = s;
    }
    {
      const ax = adxS.adx[i] ?? 0;
      engines['adx'] = ax >= cfg.adxMin ? 8 + 7 * Math.min(1, (ax - cfg.adxMin) / 25) : 2;
    }
    {
      const bf = mtfBull[i];
      if (bf === null || bf === undefined) engines['mtf'] = 7;
      else engines['mtf'] = 15 * (side === 'long' ? bf : 1 - bf);
    }
    {
      const avg = vma[i] ?? 0;
      const rel = avg > 0 ? vols[i]! / avg : 0;
      engines['volume'] = 12 * Math.min(1, rel / 2);
    }
    {
      const r = rsiS[i] ?? 50;
      let s = side === 'long' ? (r > 50 ? 8 : 2) : r < 50 ? 8 : 2;
      const divSet = side === 'long' ? divs.bull : divs.bear;
      for (const dIdx of divSet) {
        if (i - dIdx >= 0 && i - dIdx <= 10) {
          s += 5;
          break;
        }
      }
      engines['rsi'] = Math.min(13, s);
    }
    const confidence = clamp(
      Object.values(engines).reduce((x, y) => x + y, 0),
      0,
      100,
    );
    if (confidence < cfg.minConfidence) {
      blocked.push({ pair, time: c15[i]!.time, side, blockedBy: [`low-confidence(${confidence.toFixed(0)})`], confidence });
      return;
    }

    // — structural trade plan —
    const swing = swingRef(side, i, sw.highs, sw.lows);
    const sl = computeSL(cfg.slMethod, side, close, {
      swing,
      atr: a,
      atrPct: a / close,
      huntMult: cfg.huntMult,
      atrMult: cfg.atrMult,
      pct: cfg.slPct,
      ticks: cfg.slTicks,
    });
    const tps = takeProfits(close, sl.price, side, cfg.tpRs);
    const { qty, riskUsd } = sizeForRisk(cfg.equity, cfg.riskPct, close, sl.price);

    // — trend-duration forecast from this side's own history —
    const hist = durations[side];
    const { above, below } = nearestZones(zonesAt(i), close);
    const oppZone = side === 'long' ? above : below;
    const zoneDistAtr = oppZone && a > 0 ? Math.abs(oppZone.price - close) / a : 10;
    const vmaNow = vma[i] ?? 0;
    const fc = forecastDuration(hist, cfg.forecastMode, cfg.forecastAlpha, {
      zoneDistAtr,
      volRel: vmaNow > 0 ? vols[i]! / vmaNow : 1,
      filtersPassed: passed.length,
      adx: adxS.adx[i] ?? 0,
      atrPct: close > 0 ? a / close : 0,
      medAtrPct,
    });
    const lowHistory = hist.length < 5;
    const survival =
      hist.length >= 3
        ? [25, 50, 75, 90, 100].map((pct) => {
            const cut = (pct / 100) * fc.bars;
            const share = (hist.filter((d) => d >= cut).length / hist.length) * 100;
            return { pct, share: Math.round(share) };
          })
        : [];

    // — z-score vs recent signals: the ranking key (high score first) —
    scoreHist.push(confidence);
    const win = scoreHist.slice(-cfg.scoreWindow);
    const z = win.length >= 5 ? zscoreOf(confidence, mean(win), stdev(win)) : 0;

    signals.push({
      id: `${pair}-${c15[i]!.time}-${side}`,
      pair,
      time: c15[i]!.time,
      side,
      entry: close,
      sl: sl.price,
      slMethod: sl.method,
      tps,
      tpRs: [...cfg.tpRs],
      size: qty,
      riskUsd,
      confidence: Math.round(confidence * 10) / 10,
      z: Math.round(z * 100) / 100,
      engines,
      forecastBars: fc.bars,
      forecastLowHistory: lowHistory,
      survival,
      forecastMode: cfg.forecastMode,
      forecastMults: fc.mults,
      filtersPassed: passed,
    });
    lastSignalBar = i;
  };

  for (let i = warm + 1; i < n; i++) {
    const d = ut.dir[i]!;
    const pd = ut.dir[i - 1]!;
    // resolve pending N-bar confirmation first
    if (pending) {
      const want: number = pending.side === 'long' ? 1 : -1;
      if (d !== want) pending = null; // whipsawed before confirmation — kill it
      else if (i >= pending.dueBar) {
        emitFlip(i, pending.side);
        lastFlip = pending.flipBar;
        lastDir = d;
        pending = null;
      }
    }
    if (d === 0 || pd === 0 || d === pd) continue;
    flips++;
    durations[lastDir > 0 ? 'long' : 'short'].push(i - lastFlip);
    const side: Side = d > 0 ? 'long' : 'short';
    if (confirmN <= 1) {
      emitFlip(i, side);
      lastFlip = i;
      lastDir = d;
      continue;
    }
    pending = { side, flipBar: i, dueBar: i + confirmN - 1 };
  }

  return {
    signals,
    blocked,
    flips,
    zones,
    orderBlocks: obs.filter((o) => o.valid),
    bias: struct.bias,
  };
}

/** Ranked copy of signals (z-score desc, then confidence desc). */
export function rankSignals(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => b.z - a.z || b.confidence - a.confidence);
}

export { activeOBs, anchoredVwap };

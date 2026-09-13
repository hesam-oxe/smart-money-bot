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

export interface StrategyConfig {
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
  useVolume: boolean;
  volLen: number;
  volMin: number;
  useFullCandle: boolean;
  useZoneFilter: boolean;
  useVolatility: boolean;
  minAtrPct: number;
  maxAtrPct: number;
  cooldownBars: number;
  twoBarConfirm: boolean;
  swingLeft: number;
  swingRight: number;
  minConfidence: number;
  slMethod: SLMethod;
  huntMult: number;
  atrMult: number;
  slPct: number;
  tpRs: number[];
  equity: number;
  riskPct: number;
  forecastAlpha: number;
  scoreWindow: number;
}

/** Day-trading preset tuned for 15m (UT sens 1.5 / ATR 10). */
export const PRESET_15M: StrategyConfig = {
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
  useVolume: true,
  volLen: 20,
  volMin: 1.0,
  useFullCandle: false,
  useZoneFilter: true,
  useVolatility: true,
  minAtrPct: 0.0005,
  maxAtrPct: 0.05,
  cooldownBars: 2,
  twoBarConfirm: true,
  swingLeft: 3,
  swingRight: 3,
  minConfidence: 40,
  slMethod: 'structural',
  huntMult: 0.5,
  atrMult: 1.3,
  slPct: 1.0,
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

export function runEngine(
  c15: Candle[],
  c1h: Candle[] | null,
  pair: string,
  cfg: StrategyConfig,
): EngineOut {
  const n = c15.length;
  const closes = c15.map((c) => c.close);
  const vols = c15.map((c) => c.volume);

  const emaT = ema(closes, cfg.emaTrendLen);
  const atrS = atr(c15, cfg.utAtrLen);
  const ut = utbot(c15, cfg.utKey, cfg.utAtrLen, { classic: cfg.classicUt, chopStrength: cfg.chopStrength });
  const st = supertrend(c15, 3, 10);
  const rsiS = rsi(closes, 14);
  const adxS = adx(c15, cfg.adxLen);
  const vwap = rollingVwap(c15, cfg.vwapWindow);
  const vma = sma(vols, cfg.volLen);
  const sw = swings(c15, cfg.swingLeft, cfg.swingRight);
  const struct = marketStructure(c15, sw.highs, sw.lows, cfg.swingRight);
  const obs = orderBlocks(c15, atrS);
  fairValueGaps(c15); // computed for OB validation + future use
  const divs = rsiDivergence(c15, rsiS, sw.highs, sw.lows);

  // S/R zones from confirmed swing pivots only (causal: no future swings at bar i).
  // Tolerance 1.0xATR merges pivots into real clusters; only multi-touch zones veto.
  const atrVals = atrS.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const medAtr = atrVals.length ? atrVals[Math.floor(atrVals.length / 2)]! : 1;
  const zonesAt = (i: number): Zone[] => {
    const hi = sw.highs.filter((s) => s.idx + cfg.swingRight <= i);
    const lo = sw.lows.filter((s) => s.idx + cfg.swingRight <= i);
    return [...buildZones(hi, -1, medAtr), ...buildZones(lo, 1, medAtr)];
  };
  const zones = zonesAt(n - 1);

  // 1H trend tape aligned onto 15m bars (EMA50 > EMA200 = bull)
  let htfBull: (boolean | null)[] = new Array(n).fill(null);
  if (c1h && c1h.length > 210) {
    const hCloses = c1h.map((c) => c.close);
    const e50 = ema(hCloses, 50);
    const e200 = ema(hCloses, 200);
    let p = 0;
    for (let i = 0; i < n; i++) {
      while (p + 1 < c1h.length && c1h[p + 1]!.time <= c15[i]!.time) p++;
      if (c1h[p]!.time <= c15[i]!.time && e50[p] !== null && e200[p] !== null) {
        htfBull[i] = e50[p]! > e200[p]!;
      }
    }
  }

  const warm = Math.max(cfg.emaTrendLen + 5, 220);
  const signals: Signal[] = [];
  const blocked: BlockedFlip[] = [];
  const scoreHist: number[] = [];
  const durations: Record<Side, number[]> = { long: [], short: [] };
  let flips = 0;
  let lastFlip = warm;
  let lastDir = ut.dir[warm] ?? 0;
  let lastSignalBar = -1e9;
  let pending: { side: Side; flipBar: number } | null = null;

  const emitFlip = (i: number, side: Side): void => {
    const close = c15[i]!.close;
    const a = atrS[i] ?? 0;
    const passed: string[] = [];
    const failed: string[] = [];
    const sgn = side === 'long' ? 1 : -1;

    // — hard filters (fake-signal killers) —
    if (cfg.useAdx) {
      const ax = adxS.adx[i] ?? 0;
      const diOk = side === 'long' ? (adxS.plusDI[i] ?? 0) > (adxS.minusDI[i] ?? 0) : (adxS.minusDI[i] ?? 0) > (adxS.plusDI[i] ?? 0);
      ax >= cfg.adxMin && diOk ? passed.push('adx-regime') : failed.push(`adx-regime(${ax.toFixed(1)})`);
    }
    if (cfg.useEmaTrend) {
      const e = emaT[i];
      const ok = e !== null && (side === 'long' ? close > e : close < e);
      ok ? passed.push('ema200-trend') : failed.push('ema200-trend');
    }
    if (cfg.useVwap) {
      const rv = vwap[i];
      const av = anchoredAt(c15, lastFlip, i);
      const ok =
        rv !== null && av !== null && (side === 'long' ? close > rv && close > av : close < rv && close < av);
      ok ? passed.push('vwap-side') : failed.push('vwap-side');
    }
    if (cfg.useMtf) {
      const hb = htfBull[i];
      if (hb === null) passed.push('mtf(nodata)');
      else (hb === (side === 'long') ? passed.push('mtf') : failed.push('mtf'));
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
      const strong = zonesAt(i).filter((z) => z.touches >= 2);
      const { above, below } = nearestZones(strong, close);
      const opp = side === 'long' ? above : below;
      const dist = opp ? Math.abs(opp.price - close) : Infinity;
      dist > 0.5 * a ? passed.push('zone') : failed.push('zone(into-SR)');
    }
    // structure alignment (bias agrees OR fresh BOS/CHoCH in our direction)
    {
      const agree = struct.bias[i] === sgn;
      const fresh = struct.events.some((e) => e.dir === sgn && i - e.idx <= 8);
      agree || fresh ? passed.push('structure') : failed.push('structure');
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
      if (st.dir[i] === sgn && ln !== null) engines['supertrend'] = 10 + 5 * Math.min(1, Math.abs(close - ln) / Math.max(a, 1e-9) / 2);
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
      const hb = htfBull[i];
      engines['mtf'] = hb === null ? 7 : hb === (side === 'long') ? 15 : 0;
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
    });
    const tps = takeProfits(close, sl.price, side, cfg.tpRs);
    const { qty, riskUsd } = sizeForRisk(cfg.equity, cfg.riskPct, close, sl.price);

    // — trend-duration forecast from this side's own history —
    const hist = durations[side];
    let forecastBars = 10;
    let lowHistory = true;
    let survival: { pct: number; share: number }[] = [];
    if (hist.length >= 3) {
      lowHistory = hist.length < 5;
      let ew = hist[0]!;
      for (const d of hist.slice(1)) ew = cfg.forecastAlpha * d + (1 - cfg.forecastAlpha) * ew;
      forecastBars = Math.min(500, Math.max(1, Math.round(ew)));
      survival = [25, 50, 75, 90].map((pct) => {
        const cut = (pct / 100) * forecastBars;
        const share = (hist.filter((d) => d >= cut).length / hist.length) * 100;
        return { pct, share: Math.round(share) };
      });
    }

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
      forecastBars,
      forecastLowHistory: lowHistory,
      survival,
      filtersPassed: passed,
    });
    lastSignalBar = i;
  };

  for (let i = warm + 1; i < n; i++) {
    const d = ut.dir[i]!;
    const pd = ut.dir[i - 1]!;
    // resolve pending 2-bar confirmation first
    if (pending) {
      if (d === (pending.side === 'long' ? 1 : -1)) {
        emitFlip(i, pending.side);
        lastFlip = pending.flipBar;
        lastDir = d;
      }
      pending = null;
    }
    if (d === 0 || pd === 0 || d === pd) continue;
    flips++;
    durations[lastDir > 0 ? 'long' : 'short'].push(i - lastFlip);
    const side: Side = d > 0 ? 'long' : 'short';
    if (cfg.twoBarConfirm) {
      pending = { side, flipBar: i };
      continue;
    }
    emitFlip(i, side);
    lastFlip = i;
    lastDir = d;
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

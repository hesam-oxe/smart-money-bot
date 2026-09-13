/** Central configuration — everything tunable via environment (.env supported by hand). */
export interface AppConfig {
  provider: 'kraken' | 'binance';
  pairs: string[];
  timeframeMin: number;
  fresh: boolean;
  style: string;
  filterPreset: string;
  utKey: number;
  utAtrLen: number;
  chopStrength: number;
  classicUt: boolean;
  useAdx: boolean;
  adxMin: number;
  useEmaTrend: boolean;
  useVwap: boolean;
  useMtf: boolean;
  mtfMinAgree: number;
  useRegime: boolean;
  regimeAdxMin: number;
  useVolume: boolean;
  volMin: number;
  useFullCandle: boolean;
  useZoneFilter: boolean;
  useVolatility: boolean;
  useStructure: boolean;
  useRsiFilter: boolean;
  useSupertrendFilter: boolean;
  useHullFilter: boolean;
  cooldownBars: number;
  confirmBars: number;
  twoBarConfirm: boolean;
  minConfidence: number;
  forecastMode: string;
  equity: number;
  riskPct: number;
  slMethod: string;
  huntMult: number;
  atrMult: number;
  slTicks: number;
  tpChoice: number;
  feeBps: number;
  telegramToken: string;
  telegramChatId: string;
  pollSec: number;
  dashPort: number;
}

function str(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v.toLowerCase() === 'true' || v === '1';
}

/** Load a tiny `.env` file (KEY=VALUE lines) into process.env if present. No dependency. */
export async function loadDotEnv(path = '.env'): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const eq = t.indexOf('=');
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* no .env — fine */
  }
}

export function loadConfig(): AppConfig {
  const provider = str('PROVIDER', 'kraken').toLowerCase() === 'binance' ? 'binance' : 'kraken';
  return {
    provider,
    pairs: str('PAIRS', 'XBTUSD,ETHUSD').split(',').map((s) => s.trim()).filter(Boolean),
    timeframeMin: num('TIMEFRAME', 15),
    fresh: bool('FRESH', false),
    style: str('STYLE', 'auto'),
    filterPreset: str('FILTER_PRESET', 'strict'),
    utKey: num('UT_KEY', 1.5),
    utAtrLen: num('UT_ATR', 10),
    chopStrength: num('CHOP', 1.0),
    classicUt: bool('CLASSIC_UT', false),
    useAdx: bool('USE_ADX', true),
    adxMin: num('ADX_MIN', 12),
    useEmaTrend: bool('USE_EMA_TREND', true),
    useVwap: bool('USE_VWAP', true),
    useMtf: bool('USE_MTF', true),
    mtfMinAgree: num('MTF_MIN_AGREE', 0.5),
    useRegime: bool('USE_REGIME', true),
    regimeAdxMin: num('REGIME_ADX_MIN', 10),
    useVolume: bool('USE_VOLUME', true),
    volMin: num('VOL_MIN', 1.0),
    useFullCandle: bool('USE_FULL_CANDLE', false),
    useZoneFilter: bool('USE_ZONE_FILTER', true),
    useVolatility: bool('USE_VOLATILITY', true),
    useStructure: bool('USE_STRUCTURE', true),
    useRsiFilter: bool('USE_RSI_FILTER', false),
    useSupertrendFilter: bool('USE_SUPERTREND_FILTER', false),
    useHullFilter: bool('USE_HULL_FILTER', false),
    cooldownBars: num('COOLDOWN_BARS', 2),
    confirmBars: num('CONFIRM_BARS', 0),
    twoBarConfirm: bool('TWO_BAR_CONFIRM', true),
    minConfidence: num('MIN_CONFIDENCE', 40),
    forecastMode: str('FORECAST_MODE', 'standard'),
    equity: num('EQUITY', 10000),
    riskPct: num('RISK_PCT', 1),
    slMethod: str('SL_METHOD', 'structural'),
    huntMult: num('HUNT_MULT', 0.5),
    atrMult: num('ATR_MULT', 1.3),
    slTicks: num('SL_TICKS', 200),
    tpChoice: num('TP_CHOICE', 2),
    feeBps: num('FEE_BPS', 5),
    telegramToken: str('TELEGRAM_BOT_TOKEN', ''),
    telegramChatId: str('TELEGRAM_CHAT_ID', ''),
    pollSec: num('POLL_SEC', 60),
    dashPort: num('DASH_PORT', 8080),
  };
}

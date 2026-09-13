/**
 * Market-data providers. Public endpoints only — no API keys, no trading,
 * this bot can only *read* candles (paper trading by construction).
 *
 * - Kraken (default): free OHLC, up to 720 bars, works without geo blocks.
 * - Binance (optional): 1000 klines, geo-restricted in some regions.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Candle } from './types.js';

export interface CandleSet {
  /** fully closed bars (signals are computed on these only — no repaint) */
  closed: Candle[];
  /** the still-forming bar, if the venue returned one */
  live: Candle | null;
}

const CACHE_DIR = 'results/cache';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function cachePath(source: string, pair: string, intervalMin: number): string {
  const safe = pair.replace(/[^A-Za-z0-9]/g, '');
  return `${CACHE_DIR}/${source}-${safe}-${intervalMin}.json`;
}

async function readCache(source: string, pair: string, intervalMin: number): Promise<Candle[] | null> {
  try {
    const p = cachePath(source, pair, intervalMin);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(await readFile(p, 'utf8')) as { savedAt: number; candles: Candle[] };
    if (Date.now() - raw.savedAt > CACHE_TTL_MS) return null;
    if (!Array.isArray(raw.candles) || raw.candles.length < 50) return null;
    return raw.candles;
  } catch {
    return null;
  }
}

async function writeCache(source: string, pair: string, intervalMin: number, candles: Candle[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(source, pair, intervalMin), JSON.stringify({ savedAt: Date.now(), candles }));
  } catch {
    /* cache is best-effort */
  }
}

async function fetchJson(url: string, timeoutMs = 20000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'smart-money-bot/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(t);
  }
}

/** Kraken OHLC. `pair` like XBTUSD / ETHUSD, `intervalMin` in {1,5,15,30,60,240,1440}. */
export async function fetchKraken(pair: string, intervalMin: number): Promise<CandleSet> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${intervalMin}`;
  const data = (await fetchJson(url)) as { error: string[]; result: Record<string, unknown> };
  if (data.error?.length) throw new Error(`Kraken: ${data.error.join('; ')}`);
  const key = Object.keys(data.result).find((k) => k !== 'last');
  if (!key) throw new Error('Kraken: empty result');
  const rows = data.result[key] as [number, string, string, string, string, string, string, number][];
  const all: Candle[] = rows.map((r) => ({
    time: r[0] * 1000,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  }));
  // Last row is the still-forming bar.
  const live = all.length ? all[all.length - 1]! : null;
  return { closed: all.slice(0, -1), live };
}

/** Binance klines. `symbol` like BTCUSDT, interval like '15m'/'1h'. Geo-restricted in some regions. */
export async function fetchBinance(symbol: string, interval: string, limit = 1000): Promise<CandleSet> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  const rows = (await fetchJson(url)) as [number, string, string, string, string, string][];
  if (!Array.isArray(rows)) {
    const maybe = rows as unknown as { msg?: string };
    throw new Error(`Binance: ${maybe?.msg ?? 'unexpected response (region may be restricted)'}`);
  }
  const all: Candle[] = rows.map((r) => ({
    time: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
  const live = all.length ? all[all.length - 1]! : null;
  return { closed: all.slice(0, -1), live };
}

function binanceSymbol(krakenPair: string): string {
  // crude XBTUSD -> BTCUSDT mapping for the common pairs
  const p = krakenPair.toUpperCase().replace(/^XX/, 'X').replace(/\.D$/, '');
  const base = p.replace(/USD$|USDT$/, '').replace(/^XBT$/, 'BTC').replace(/^X /, '');
  const b = base.startsWith('X') && base.length === 4 ? base.slice(1) : base;
  return `${b}USDT`;
}

/**
 * Load closed 15m (or `intervalMin`) bars for a pair, with disk cache.
 * Falls back gracefully: Binance error -> clear message (suggest Kraken).
 */
export async function loadCandles(
  source: 'kraken' | 'binance',
  pair: string,
  intervalMin: number,
  opts: { fresh?: boolean; live?: boolean } = {},
): Promise<CandleSet> {
  if (!opts.fresh && !opts.live) {
    const cached = await readCache(source, pair, intervalMin);
    if (cached) return { closed: cached, live: null };
  }
  let set: CandleSet;
  if (source === 'kraken') {
    // NOTE: Kraken caps public OHLC at the latest 720 bars (`since` cannot backfill).
    set = await fetchKraken(pair, intervalMin);
  } else {
    const tf = intervalMin >= 60 ? `${Math.round(intervalMin / 60)}h` : `${intervalMin}m`;
    set = await fetchBinance(binanceSymbol(pair), tf);
  }
  await writeCache(source, pair, intervalMin, set.closed);
  // small courtesy delay for public rate limits
  await new Promise((r) => setTimeout(r, 800));
  return set;
}

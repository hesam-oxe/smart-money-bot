/** Telegram alerts via Bot API (plain fetch, no deps). Console fallback. */
import type { Signal } from './types.js';

export function formatSignal(s: Signal): string {
  const arrow = s.side === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const band = s.confidence >= 80 ? '💪 strong' : s.confidence >= 60 ? '👍 good' : s.confidence >= 40 ? '⚠️ weak' : '🚫 very-weak';
  const tps = s.tps.map((t, i) => `TP${s.tpRs[i]} ${fmt(t)}`).join(' | ');
  const surv = s.survival.length
    ? ` | hold~${s.forecastBars} bars (P50 ${s.survival[1]?.share ?? '-'}%)`
    : '';
  return (
    `${arrow} ${s.pair} — conf ${s.confidence} ${band} (z ${s.z >= 0 ? '+' : ''}${s.z})${surv}\n` +
    `Entry ${fmt(s.entry)} | SL ${fmt(s.sl)} [${s.slMethod}] | ${tps}\n` +
    `Size ${s.size.toPrecision(4)} | risk $${s.riskUsd.toFixed(2)} | ${new Date(s.time).toISOString()}`
  );
}

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Number(n.toPrecision(6)));
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  console.log(`[signal]\n${text}`);
  if (!token || !chatId) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        console.error('[telegram] send failed:', res.status, await res.text().catch(() => ''));
        return false;
      }
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error('[telegram] error:', (e as Error).message);
    return false;
  }
}

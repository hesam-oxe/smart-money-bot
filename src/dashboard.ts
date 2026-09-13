#!/usr/bin/env tsx
/**
 * Dashboard server (zero deps): serves the HTML cockpit + JSON APIs.
 * Usage: npm run dashboard  ->  http://localhost:8080
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotEnv } from './config.js';
import { runBacktest } from './backtest.js';
import type { Signal } from './types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

function send(res: ServerResponse, code: number, body: string | Buffer, type = 'application/json'): void {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

async function readJsonlRanked(limit: number): Promise<Signal[]> {
  try {
    const raw = await readFile('results/signals.jsonl', 'utf8');
    const byId = new Map<string, Signal>();
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const s = JSON.parse(line) as Signal;
        byId.set(s.id, s);
      } catch { /* skip */ }
    }
    return [...byId.values()].sort((a, b) => b.z - a.z || b.confidence - a.confidence).slice(0, limit);
  } catch {
    return [];
  }
}

let backtestRunning = false;

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const app = loadConfig();

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile('public/index.html');
      send(res, 200, html, MIME['.html']!);
    } catch {
      send(res, 500, JSON.stringify({ error: 'public/index.html missing' }));
    }
    return;
  }
  if (url.pathname === '/api/status') {
    let files: string[] = [];
    try {
      files = await readdir('results');
    } catch { /* empty */ }
    let mtime: string | null = null;
    try {
      mtime = (await stat('results/signals.jsonl')).mtime.toISOString();
    } catch { /* none */ }
    send(res, 200, JSON.stringify({
      provider: app.provider,
      pairs: app.pairs,
      timeframeMin: app.timeframeMin,
      telegram: Boolean(app.telegramToken && app.telegramChatId),
      backtestRunning,
      signalsUpdatedAt: mtime,
      resultFiles: files.filter((f) => f.endsWith('.json')).length,
    }));
    return;
  }
  if (url.pathname === '/api/signals') {
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50));
    send(res, 200, JSON.stringify(await readJsonlRanked(limit)));
    return;
  }
  if (url.pathname === '/api/backtest') {
    const pair = (url.searchParams.get('pair') ?? app.pairs[0] ?? 'XBTUSD').replace(/[^A-Za-z0-9]/g, '');
    try {
      const data = await readFile(`results/backtest-${pair}.json`, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      send(res, 404, JSON.stringify({ error: `no backtest for ${pair} yet — press Run backtest` }));
    }
    return;
  }
  if (url.pathname === '/api/equity') {
    const pair = (url.searchParams.get('pair') ?? app.pairs[0] ?? 'XBTUSD').replace(/[^A-Za-z0-9]/g, '');
    try {
      const data = await readFile(`results/equity-${pair}.json`, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      send(res, 404, JSON.stringify({ error: 'no equity data yet' }));
    }
    return;
  }
  if (url.pathname === '/api/run-backtest' && req.method === 'POST') {
    if (backtestRunning) {
      send(res, 409, JSON.stringify({ error: 'backtest already running' }));
      return;
    }
    const pair = url.searchParams.get('pair');
    const fresh = url.searchParams.get('fresh') === '1';
    backtestRunning = true;
    runBacktest({ pairs: pair ? [pair] : undefined, fresh, log: true })
      .then((s) => {
        backtestRunning = false;
        send(res, 200, JSON.stringify({ ok: true, summaries: s }));
      })
      .catch((e: Error) => {
        backtestRunning = false;
        send(res, 500, JSON.stringify({ error: e.message }));
      });
    return;
  }
  send(res, 404, JSON.stringify({ error: 'not found' }));
}

export async function startDashboard(): Promise<void> {
  await loadDotEnv();
  const app = loadConfig();
  const server = createServer((req, res) => {
    router(req, res).catch((e: Error) => send(res, 500, JSON.stringify({ error: e.message })));
  });
  await new Promise<void>((resolve) => server.listen(app.dashPort, '0.0.0.0', resolve));
  console.log(`dashboard: http://localhost:${app.dashPort}  (pairs: ${app.pairs.join(', ')})`);
  if (!existsSync('results/signals.jsonl')) {
    console.log('hint: no signals yet — run `npm run backtest` or press “Run backtest” in the UI');
  }
}

function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  } catch {
    return false;
  }
}

if (isMain()) {
  startDashboard().catch((e) => {
    console.error('dashboard failed:', (e as Error).message);
    process.exit(1);
  });
}

#!/usr/bin/env node
/*
 * Backfill: resolved Polymarket "Bitcoin Up or Down" 5-minute markets + their minute-by-minute odds,
 * paired with Coinbase BTC-USD 1-minute and 5-minute candles for the same period.
 *
 *   node tools/backfill.mjs [days=4] [out=data/backfill.json]
 *
 * Public endpoints only — no API keys.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAYS = +(process.argv[2] || 4);
const OUT = resolve(process.argv[3] || resolve(HERE, '../data/backfill.json'));
const W = 300;
const CHECKPOINTS = [0, 60, 120, 180, 240];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t * 1000).toISOString();
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

async function getJSON(url, tries = 5) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'btc-pattern-watch-backfill/1.0', Accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) { const e = new Error('HTTP ' + r.status + ' ' + url); e.fatal = true; throw e; }
      return await r.json();
    } catch (e) {
      if (e.fatal || a >= tries) throw e;
      await sleep(700 * 2 ** a);
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      if (++done % 100 === 0) log(`  ${done}/${items.length}`);
    }
  }));
  return out;
}

async function coinbaseCandles(gran, from, to) {
  const per = 290, map = new Map();
  for (let e = to; e > from; e -= per * gran) {
    const s = Math.max(from, e - per * gran);
    const rows = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}&start=${iso(s)}&end=${iso(e)}`);
    for (const r of rows) map.set(r[0], [r[0], +r[3], +r[2], +r[1], +r[4], +r[5]]); // t,o,h,l,c,v
    await sleep(150);
  }
  return [...map.values()].sort((a, b) => a[0] - b[0]);
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const end = Math.floor(now / W) * W - 2 * W;           // last window surely resolved
  const start = end - DAYS * 86400;
  log(`Backfilling ${DAYS} day(s): ${iso(start)} → ${iso(end)}`);

  // 1) Markets, 25 slugs per request
  const starts = [];
  for (let t = start; t <= end; t += W) starts.push(t);
  const batches = [];
  for (let i = 0; i < starts.length; i += 25) batches.push(starts.slice(i, i + 25));
  log(`Fetching ${starts.length} markets in ${batches.length} batches…`);
  const markets = new Map();
  await pool(batches, 4, async (b) => {
    const q = b.map((t) => 'slug=btc-updown-5m-' + t).join('&');
    const rows = await getJSON(`https://gamma-api.polymarket.com/markets?limit=50&closed=true&${q}`);
    for (const m of rows) {
      const t = +m.slug.split('-').pop();
      const outcomes = JSON.parse(m.outcomes || '[]');
      const prices = JSON.parse(m.outcomePrices || '[]');
      const tokens = JSON.parse(m.clobTokenIds || '[]');
      const ui = outcomes.indexOf('Up');
      if (ui < 0) continue;
      const res = prices[ui] === '1' ? 1 : prices[ui] === '0' ? 0 : null;
      markets.set(t, { t, token: tokens[ui], up: res, volume: +m.volume || 0 });
    }
  });
  const resolved = [...markets.values()].filter((m) => m.up !== null).sort((a, b) => a.t - b.t);
  log(`Resolved markets: ${resolved.length}/${starts.length}`);

  // 2) Minute odds for the Up token through each window
  log('Fetching odds history…');
  const windows = (await pool(resolved, 6, async (m) => {
    try {
      const j = await getJSON(`https://data-api.polymarket.com/v2/prices-history?token_id=${m.token}&start=${m.t - 120}&end=${m.t + W}`);
      const pts = (j.data || []).map((d) => [d.timestamp, d.price]).sort((a, b) => a[0] - b[0]);
      const odds = {};
      for (const e of [-60, ...CHECKPOINTS]) {
        let best = null;
        for (const [ts, p] of pts) if (ts <= m.t + e) best = p;
        if (best != null) odds[e] = best;
      }
      return { t: m.t, up: m.up, volume: m.volume, odds };
    } catch (e) {
      log('  odds failed for', m.t, e.message);
      return null;
    }
  })).filter(Boolean);

  // 3) Coinbase candles (5m with 2 days of warm-up for pattern hit rates; 1m for intra-window)
  log('Fetching Coinbase 5m candles…');
  const c5m = await coinbaseCandles(300, start - 2 * 86400, end + W);
  log('Fetching Coinbase 1m candles…');
  const c1m = await coinbaseCandles(60, start - 2 * 3600, end + W);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generated: iso(now), start, end, windows, c5m, c1m }));
  const upRate = windows.reduce((s, w) => s + w.up, 0) / windows.length;
  log(`Wrote ${OUT}: ${windows.length} windows (Up ${(upRate * 100).toFixed(1)}%), ${c5m.length} 5m + ${c1m.length} 1m candles`);
}

main().catch((e) => { console.error(e); process.exit(1); });

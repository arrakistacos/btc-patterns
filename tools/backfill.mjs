#!/usr/bin/env node
/*
 * Backfill: resolved Polymarket "Bitcoin Up or Down" 5-minute markets + their minute-by-minute odds,
 * paired with Coinbase BTC-USD 1-minute and 5-minute candles for the same period.
 *
 *   node tools/backfill.mjs [days=4] [out=data/backfill.json]
 *
 * Logic lives in ../calib.js (shared with the browser "Calibrate now" button). Public endpoints only.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const Calib = createRequire(import.meta.url)(resolve(HERE, '../calib.js'));
const DAYS = +(process.argv[2] || 4);
const OUT = resolve(process.argv[3] || resolve(HERE, '../data/backfill.json'));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

let lastStage = '', lastPct = -1;
const data = await Calib.backfill({
  days: DAYS,
  onProgress: (stage, done, total) => {
    const pct = Math.floor((done / Math.max(1, total)) * 10) * 10;
    if (stage !== lastStage || pct !== lastPct) { log(`  ${stage}: ${done}/${total}`); lastStage = stage; lastPct = pct; }
  },
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data));
const upRate = data.windows.reduce((s, w) => s + w.up, 0) / data.windows.length;
log(`Wrote ${OUT}: ${data.windows.length} windows (Up ${(upRate * 100).toFixed(1)}%), ${data.c5m.length} 5m + ${data.c1m.length} 1m candles`);

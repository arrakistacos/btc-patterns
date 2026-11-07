#!/usr/bin/env node
/*
 * Replay tuner: scores our window-odds model against resolved Polymarket 5-minute BTC markets
 * and against Polymarket's own odds at the same moments, then grid-searches the parameters.
 *
 *   node tools/tune.mjs [in=data/backfill.json]
 *
 * Writes params.json (used by the app), data/calibration.json (report) and data/edge.json (edge table).
 * Train/test split is chronological (first 70% / last 30%). Logic lives in ../calib.js.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const req = createRequire(import.meta.url);
const E = req(resolve(ROOT, 'engine.js'));
const Calib = req(resolve(ROOT, 'calib.js'));
const IN = resolve(process.argv[2] || resolve(ROOT, 'data/backfill.json'));

const data = JSON.parse(readFileSync(IN, 'utf8'));
const t0 = Date.now();
const { report, params, edge } = await Calib.tune(data, E);
writeFileSync(resolve(ROOT, 'data/calibration.json'), JSON.stringify(report, null, 1));
writeFileSync(resolve(ROOT, 'params.json'), JSON.stringify(params, null, 1));
writeFileSync(resolve(ROOT, 'data/edge.json'), JSON.stringify(edge, null, 1));

const f = (x) => x.toFixed(4);
console.log(`Tuned in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${report.data.windows} windows, ${report.data.samples} samples · test = last 30% (${report.data.test})`);
console.log(`Best vs outcomes : ${JSON.stringify(params.window)}`);
console.log(`Best match market: ${JSON.stringify(params.marketMatch)}`);
console.log(`Test log loss  model ${f(report.bestOutcome.test.logloss)} | market ${f(report.market.test.logloss)} | coin ${f(Math.log(2))}`);
console.log(`Test Brier     model ${f(report.bestOutcome.test.brier)} | market ${f(report.market.test.brier)} | coin 0.2500`);
console.log('Edge (buy favorite, after fees): ' + [60, 120, 180, 240].map((e) => { const c = edge.checkpoints[e]; return `${e / 60}:00 all ${(c.all.ev * 100).toFixed(1)}¢ (n${c.all.n}) · agree ${(c.agree.ev * 100).toFixed(1)}¢ (n${c.agree.n})`; }).join(' | '));

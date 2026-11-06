#!/usr/bin/env node
/*
 * Replay tuner: scores our window-odds model against resolved Polymarket 5-minute BTC markets
 * and against Polymarket's own odds at the same moments, then grid-searches the parameters.
 *
 *   node tools/tune.mjs [in=data/backfill.json]
 *
 * Writes data/calibration.json (report for calibration.html) and params.json (used by the app).
 * Train/test split is chronological (first 70% / last 30%) so the reported test scores are out-of-sample.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const E = createRequire(import.meta.url)(resolve(ROOT, 'engine.js'));
const IN = resolve(process.argv[2] || resolve(ROOT, 'data/backfill.json'));
const W = 300;
const CPS = [0, 60, 120, 180, 240];
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const data = JSON.parse(readFileSync(IN, 'utf8'));
const C5 = data.c5m.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const c1 = new Map(data.c1m.map(([t, o, h, l, c, v]) => [t, { t, o, h, l, c, v }]));
const idx5 = new Map(C5.map((k, i) => [k.t, i]));

// Pattern lean for every 5m bar (walk-forward, so no peeking)
log('Running pattern engine over', C5.length, '5m candles…');
const A = E.analyze(C5, { collect: true, interval: W });
const zByTime = new Map(A.zSeries);

// Build replay samples: one per (window, checkpoint)
const samples = [];
for (const w of data.windows) {
  const i5 = idx5.get(w.t - W);
  const k0 = c1.get(w.t);
  if (i5 == null || i5 < 60 || !k0) continue;
  let sum = 0, cnt = 0;
  for (const e of CPS) {
    const m = c1.get(w.t + e);
    const mkt = w.odds[e];
    if (!m || mkt == null) continue;
    samples.push({
      t: w.t, e, up: w.up, mkt,
      S: m.o, K: k0.o, avgSoFar: cnt ? sum / cnt : m.o,
      i5, z: zByTime.get(w.t) || 0,
    });
    sum += (m.o + m.h + m.l + m.c) / 4; cnt++;
  }
}
const windowsUsed = new Set(samples.map((s) => s.t));
const tSplit = [...windowsUsed].sort((a, b) => a - b)[Math.floor(windowsUsed.size * 0.7)];
const train = samples.filter((s) => s.t < tSplit), test = samples.filter((s) => s.t >= tSplit);
log(`Samples: ${samples.length} from ${windowsUsed.size} windows (train ${train.length}, test ${test.length})`);

// Precompute sigma and velocity per (volBars, velBars)
const sigCache = new Map(), velCache = new Map();
const sigmaAt = (i5, n) => { const k = i5 * 100 + n; if (!sigCache.has(k)) sigCache.set(k, E.parkinsonSigma(C5, i5, n, W)); return sigCache.get(k); };
const velAt = (i5, n, vb) => { const k = (i5 * 100 + n) * 100 + vb; if (!velCache.has(k)) velCache.set(k, E.velocity(C5, i5, n, sigmaAt(i5, vb), W)); return velCache.get(k); };

const clip = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
function modelP(s, P) {
  const sigma = sigmaAt(s.i5, P.volBars) * P.volScale;
  const pv = E.windowUpProb({ S: s.S, K: s.K, sigma, elapsed: s.e, avgSoFar: s.avgSoFar, mode: P.mode, W });
  return E.combineWindow(pv, s.z, velAt(s.i5, P.velBars, P.volBars), P);
}
function score(set, P) {
  let ll = 0, br = 0, sq = 0;
  for (const s of set) {
    const p = clip(modelP(s, P));
    ll -= s.up ? Math.log(p) : Math.log(1 - p);
    br += (p - s.up) ** 2;
    sq += (p - s.mkt) ** 2;
  }
  return { logloss: ll / set.length, brier: br / set.length, mse: sq / set.length };
}
function marketScore(set) {
  let ll = 0, br = 0;
  for (const s of set) { const p = clip(s.mkt); ll -= s.up ? Math.log(p) : Math.log(1 - p); br += (p - s.up) ** 2; }
  return { logloss: ll / set.length, brier: br / set.length };
}

// Grid search
const grid = [];
for (const mode of ['spot', 'end60', 'full'])
  for (const volBars of [3, 6, 12, 24, 48])
    for (const volScale of [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2])
      for (const beta of [0, 0.5, 1])
        for (const gamma of [-0.3, -0.15, 0, 0.15, 0.3])
          for (const velBars of gamma === 0 ? [3] : [1, 3, 6, 12])
            grid.push({ mode, volBars, volScale, beta, gamma, velBars });
log('Grid size', grid.length);
let bestOutcome = null, bestMarket = null;
const t0 = Date.now();
for (const P of grid) {
  const sc = score(train, P);
  if (!bestOutcome || sc.logloss < bestOutcome.sc.logloss) bestOutcome = { P, sc };
  if (!bestMarket || sc.mse < bestMarket.sc.mse) bestMarket = { P, sc };
}
log(`Grid done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Hypothesis checks on the best outcome model: does velocity help? do patterns help?
const ablate = (P, patch) => score(test, Object.assign({}, P, patch));

// Blend test: does adding our pattern lean / velocity to the MARKET's own odds improve it?
function blendScore(set, beta, gamma, vb) {
  let ll = 0;
  for (const s of set) {
    const m = clip(s.mkt);
    const z = Math.log(m / (1 - m)) + beta * s.z + gamma * velAt(s.i5, vb, 12);
    const p = clip(1 / (1 + Math.exp(-z)));
    ll -= s.up ? Math.log(p) : Math.log(1 - p);
  }
  return ll / set.length;
}
let bestBlend = { beta: 0, gamma: 0, vb: 3, ll: blendScore(train, 0, 0, 3) };
for (const beta of [-0.5, -0.25, 0, 0.25, 0.5, 1])
  for (const gamma of [-0.2, -0.1, 0, 0.1, 0.2])
    for (const vb of [1, 3, 6]) {
      const ll = blendScore(train, beta, gamma, vb);
      if (ll < bestBlend.ll) bestBlend = { beta, gamma, vb, ll };
    }

// Per-checkpoint table + reliability bins on the test set
function perCheckpoint(P) {
  return CPS.map((e) => {
    const set = test.filter((s) => s.e === e);
    if (!set.length) return { e, n: 0 };
    const m = score(set, P), k = marketScore(set);
    let mae = 0, hitM = 0, hitK = 0;
    for (const s of set) {
      const p = modelP(s, P);
      mae += Math.abs(p - s.mkt);
      hitM += (p >= 0.5 ? 1 : 0) === s.up ? 1 : 0;
      hitK += (s.mkt >= 0.5 ? 1 : 0) === s.up ? 1 : 0;
    }
    return { e, n: set.length, model: m, market: k, maeToMarket: mae / set.length, modelAcc: hitM / set.length, marketAcc: hitK / set.length };
  });
}
function reliability(fn, set) {
  const bins = Array.from({ length: 10 }, (_, b) => ({ lo: b / 10, hi: (b + 1) / 10, n: 0, sumP: 0, ups: 0 }));
  for (const s of set) { const p = fn(s); const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.sumP += p; b.ups += s.up; }
  return bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, avgP: b.n ? b.sumP / b.n : null, freq: b.n ? b.ups / b.n : null }));
}
// Scatter sample of model vs market (test set, intra-window checkpoints)
const scatter = test.filter((s) => s.e > 0).filter((_, i) => i % 3 === 0).slice(0, 1200)
  .map((s) => [+modelP(s, bestOutcome.P).toFixed(4), +s.mkt.toFixed(4), s.e]);

const P = bestOutcome.P;
const report = {
  generated: new Date().toISOString(),
  data: { from: data.start, to: data.end, windows: windowsUsed.size, samples: samples.length, train: train.length, test: test.length, upRate: data.windows.reduce((a, w) => a + w.up, 0) / data.windows.length },
  bestOutcome: { params: P, train: bestOutcome.sc, test: score(test, P) },
  bestMarketMatch: { params: bestMarket.P, train: bestMarket.sc, test: score(test, bestMarket.P) },
  market: { test: marketScore(test) },
  coinFlip: { logloss: Math.log(2), brier: 0.25 },
  ablation: {
    full: score(test, P),
    noVelocity: ablate(P, { gamma: 0 }),
    noPatterns: ablate(P, { beta: 0 }),
    modes: Object.fromEntries(['spot', 'end60', 'full'].map((m) => [m, ablate(P, { mode: m })])),
  },
  blend: { params: { beta: bestBlend.beta, gamma: bestBlend.gamma, velBars: bestBlend.vb }, trainLogloss: bestBlend.ll, testLogloss: blendScore(test, bestBlend.beta, bestBlend.gamma, bestBlend.vb), marketTestLogloss: marketScore(test).logloss },
  checkpoints: perCheckpoint(P),
  reliability: { model: reliability((s) => modelP(s, P), test), market: reliability((s) => s.mkt, test) },
  scatter,
};
writeFileSync(resolve(ROOT, 'data/calibration.json'), JSON.stringify(report, null, 1));
writeFileSync(resolve(ROOT, 'params.json'), JSON.stringify({
  generated: report.generated, window: P, marketMatch: bestMarket.P,
  note: 'Tuned by tools/tune.mjs on resolved Polymarket 5m BTC markets. window = best vs outcomes; marketMatch = closest to Polymarket odds.',
}, null, 1));

// Console summary
const f = (x) => x.toFixed(4);
console.log(`\nData: ${windowsUsed.size} windows, ${samples.length} samples · test = last 30% (${test.length})`);
console.log(`Best vs outcomes : ${JSON.stringify(P)}`);
console.log(`Best match market: ${JSON.stringify(bestMarket.P)}`);
console.log(`\nTest log loss  model ${f(report.bestOutcome.test.logloss)} | market ${f(report.market.test.logloss)} | coin ${f(Math.log(2))}`);
console.log(`Test Brier     model ${f(report.bestOutcome.test.brier)} | market ${f(report.market.test.brier)} | coin 0.2500`);
console.log(`Ablation (test logloss): full ${f(report.ablation.full.logloss)} · no velocity ${f(report.ablation.noVelocity.logloss)} · no patterns ${f(report.ablation.noPatterns.logloss)}`);
console.log(`Modes: ` + Object.entries(report.ablation.modes).map(([k, v]) => `${k} ${f(v.logloss)}`).join(' · '));
console.log(`Blend market+ours: ${JSON.stringify(report.blend.params)} test ${f(report.blend.testLogloss)} vs market ${f(report.blend.marketTestLogloss)}`);
console.log('\n  t   n    model-LL  market-LL  model-acc  market-acc  |model-market|');
for (const c of report.checkpoints) if (c.n) console.log(`${String(c.e).padStart(4)} ${String(c.n).padStart(4)}   ${f(c.model.logloss)}    ${f(c.market.logloss)}     ${(c.modelAcc * 100).toFixed(1)}%      ${(c.marketAcc * 100).toFixed(1)}%       ${c.maeToMarket.toFixed(3)}`);

/*
 * Calibration against Polymarket 5-minute BTC "Up or Down" markets.
 * Shared by the browser (calibration.html "Calibrate now") and the Node tools
 * (tools/backfill.mjs, tools/tune.mjs) so both produce identical results.
 *
 *   Calib.backfill({ days, onProgress, fetchJSON }) -> data
 *   Calib.tune(data, Engine, { onProgress }) -> { report, params, edge }
 *
 * Public endpoints only (Polymarket Gamma + data API, Coinbase Exchange). No keys.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Calib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 300;
  const CPS = [0, 60, 120, 180, 240];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const iso = (t) => new Date(t * 1000).toISOString();
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));

  async function defaultFetchJSON(url, tries = 5) {
    for (let a = 0; ; a++) {
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
        if (!r.ok) { const e = new Error('HTTP ' + r.status); e.fatal = true; throw e; }
        return await r.json();
      } catch (e) {
        if (e.fatal || a >= tries) throw e;
        await sleep(700 * 2 ** a);
      }
    }
  }

  async function pool(items, n, fn, onDone) {
    const out = new Array(items.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        done++;
        if (onDone) onDone(done, items.length);
      }
    }));
    return out;
  }

  // ---------------------------------------------------------------- backfill
  async function backfill(opts) {
    opts = opts || {};
    const days = opts.days || 4;
    const getJSON = opts.fetchJSON || defaultFetchJSON;
    const progress = opts.onProgress || (() => {});
    const now = Math.floor(Date.now() / 1000);
    const end = Math.floor(now / W) * W - 2 * W;      // last window surely resolved
    const start = end - days * 86400;

    // 1) Markets, 25 slugs per request
    const starts = [];
    for (let t = start; t <= end; t += W) starts.push(t);
    const batches = [];
    for (let i = 0; i < starts.length; i += 25) batches.push(starts.slice(i, i + 25));
    const markets = new Map();
    progress('markets', 0, batches.length);
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
    }, (d, n) => progress('markets', d, n));
    const resolved = [...markets.values()].filter((m) => m.up !== null).sort((a, b) => a.t - b.t);

    // 2) Minute odds for the Up token through each window
    progress('odds', 0, resolved.length);
    const windows = (await pool(resolved, 6, async (m) => {
      try {
        const j = await getJSON(`https://data-api.polymarket.com/v2/prices-history?token_id=${m.token}&start=${m.t - 120}&end=${m.t + W}`);
        const pts = (j.data || []).map((d) => [d.timestamp, d.price]).sort((a, b) => a[0] - b[0]);
        const odds = {};
        for (const e of [-60, ...CPS]) {
          let best = null;
          for (const [ts, p] of pts) if (ts <= m.t + e) best = p;
          if (best != null) odds[e] = best;
        }
        return { t: m.t, up: m.up, volume: m.volume, odds };
      } catch (e) { return null; }
    }, (d, n) => progress('odds', d, n))).filter(Boolean);

    // 3) Coinbase candles: 5m with 2 days of warm-up for pattern hit rates; 1m for intra-window prices
    async function candles(gran, from, to, label) {
      const per = 290, map = new Map(), spans = [];
      for (let e = to; e > from; e -= per * gran) spans.push([Math.max(from, e - per * gran), e]);
      progress(label, 0, spans.length);
      let k = 0;
      for (const [s, e] of spans) {
        const rows = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}&start=${iso(s)}&end=${iso(e)}`);
        for (const r of rows) map.set(r[0], [r[0], +r[3], +r[2], +r[1], +r[4], +r[5]]); // t,o,h,l,c,v
        progress(label, ++k, spans.length);
        await sleep(150);
      }
      return [...map.values()].sort((a, b) => a[0] - b[0]);
    }
    const c5m = await candles(300, start - 2 * 86400, end + W, 'candles5m');
    const c1m = await candles(60, start - 2 * 3600, end + W, 'candles1m');
    return { generated: iso(now), start, end, windows, c5m, c1m };
  }

  // ---------------------------------------------------------------- tune
  async function tune(data, E, opts) {
    opts = opts || {};
    const progress = opts.onProgress || (() => {});
    const C5 = data.c5m.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
    const c1 = new Map(data.c1m.map(([t, o, h, l, c, v]) => [t, { t, o, h, l, c, v }]));
    const idx5 = new Map(C5.map((k, i) => [k.t, i]));

    progress('patterns', 0, 1);
    await yieldNow();
    const A = E.analyze(C5, { collect: true, interval: W });
    const zByTime = new Map(A.zSeries);
    progress('patterns', 1, 1);

    // Replay samples: one per (window, checkpoint)
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
        samples.push({ t: w.t, e, up: w.up, mkt, S: m.o, K: k0.o, avgSoFar: cnt ? sum / cnt : m.o, i5, z: zByTime.get(w.t) || 0 });
        sum += (m.o + m.h + m.l + m.c) / 4; cnt++;
      }
    }
    if (samples.length < 200) throw new Error('Not enough resolved windows to calibrate (' + samples.length + ' samples)');
    const windowsUsed = new Set(samples.map((s) => s.t));
    const tSplit = [...windowsUsed].sort((a, b) => a - b)[Math.floor(windowsUsed.size * 0.7)];
    const train = samples.filter((s) => s.t < tSplit), test = samples.filter((s) => s.t >= tSplit);

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
    let bestOutcome = null, bestMarket = null;
    for (let gi = 0; gi < grid.length; gi++) {
      const P = grid[gi];
      const sc = score(train, P);
      if (!bestOutcome || sc.logloss < bestOutcome.sc.logloss) bestOutcome = { P, sc };
      if (!bestMarket || sc.mse < bestMarket.sc.mse) bestMarket = { P, sc };
      if (gi % 150 === 0) { progress('grid', gi, grid.length); await yieldNow(); }
    }
    progress('grid', grid.length, grid.length);

    const P = bestOutcome.P;
    const ablate = (patch) => score(test, Object.assign({}, P, patch));
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

    function perCheckpoint(Pp) {
      return CPS.map((e) => {
        const set = test.filter((s) => s.e === e);
        if (!set.length) return { e, n: 0 };
        const m = score(set, Pp), k = marketScore(set);
        let mae = 0, hitM = 0, hitK = 0;
        for (const s of set) {
          const p = modelP(s, Pp);
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
    const scatter = test.filter((s) => s.e > 0).filter((_, i) => i % 3 === 0).slice(0, 1200)
      .map((s) => [+modelP(s, P).toFixed(4), +s.mkt.toFixed(4), s.e]);

    const generated = new Date().toISOString();
    const report = {
      generated,
      data: { from: data.start, to: data.end, windows: windowsUsed.size, samples: samples.length, train: train.length, test: test.length, upRate: data.windows.reduce((a, w) => a + w.up, 0) / data.windows.length },
      bestOutcome: { params: P, train: bestOutcome.sc, test: score(test, P) },
      bestMarketMatch: { params: bestMarket.P, train: bestMarket.sc, test: score(test, bestMarket.P) },
      market: { test: marketScore(test) },
      coinFlip: { logloss: Math.log(2), brier: 0.25 },
      ablation: {
        full: score(test, P),
        noVelocity: ablate({ gamma: 0 }),
        noPatterns: ablate({ beta: 0 }),
        modes: Object.fromEntries(['spot', 'end60', 'full'].map((m) => [m, ablate({ mode: m })])),
      },
      blend: { params: { beta: bestBlend.beta, gamma: bestBlend.gamma, velBars: bestBlend.vb }, trainLogloss: bestBlend.ll, testLogloss: blendScore(test, bestBlend.beta, bestBlend.gamma, bestBlend.vb), marketTestLogloss: marketScore(test).logloss },
      checkpoints: perCheckpoint(P),
      reliability: { model: reliability((s) => modelP(s, P), test), market: reliability((s) => s.mkt, test) },
      scatter,
    };
    const params = {
      generated, window: P, marketMatch: bestMarket.P,
      note: 'Tuned on resolved Polymarket 5m BTC markets. window = best vs outcomes; marketMatch = closest to Polymarket odds.',
    };

    // Edge table: buying the market favorite at each minute, by price bucket and signal agreement.
    // Cost per share = price + half-spread (0.5¢) + taker fee 0.07·p·(1−p). Wilson 95% intervals on win rate.
    const FEE = (p) => 0.07 * p * (1 - p);
    const HALF_SPREAD = 0.005;
    const wilson = (k, n) => { if (!n) return [0, 1]; const z = 1.96, ph = k / n, den = 1 + z * z / n, c = (ph + z * z / (2 * n)) / den, h = z * Math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den; return [c - h, c + h]; };
    const BUCKETS = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 0.97], [0.97, 1.0001]];
    const edgeRows = [];
    for (const s of samples) {
      if (s.e === 0) continue;
      const favUp = s.mkt >= 0.5, fav = favUp ? s.mkt : 1 - s.mkt, sign = favUp ? 1 : -1;
      const pUp = modelP(s, P), oursFav = favUp ? pUp : 1 - pUp;
      const prev = c1.get(s.t + s.e - 60);
      const mom = prev ? Math.sign(s.S - prev.o) : 0;
      const vel = velAt(s.i5, P.velBars, P.volBars);
      const agree = oursFav >= fav && mom === sign && Math.sign(vel) === sign;
      edgeRows.push({ e: s.e, fav, won: (s.up === 1) === favUp ? 1 : 0, agree });
    }
    function cell(set) {
      const n = set.length;
      if (!n) return { n: 0 };
      const wins = set.reduce((a, r) => a + r.won, 0);
      const price = set.reduce((a, r) => a + r.fav, 0) / n;
      const breakeven = set.reduce((a, r) => a + r.fav + HALF_SPREAD + FEE(r.fav), 0) / n;
      const [lo, hi] = wilson(wins, n);
      return { n, wins, winRate: wins / n, price, breakeven, ev: wins / n - breakeven, ciLo: lo, ciHi: hi };
    }
    const edge = { generated, from: data.start, to: data.end, halfSpread: HALF_SPREAD, feeRate: 0.07, buckets: BUCKETS, checkpoints: {} };
    for (const e of [60, 120, 180, 240]) {
      const R = edgeRows.filter((r) => r.e === e);
      edge.checkpoints[e] = {
        all: cell(R), agree: cell(R.filter((r) => r.agree)),
        byBucket: BUCKETS.map(([lo, hi]) => {
          const B = R.filter((r) => r.fav >= lo && r.fav < hi);
          return { lo, hi, all: cell(B), agree: cell(B.filter((r) => r.agree)) };
        }),
      };
    }
    progress('done', 1, 1);
    return { report, params, edge };
  }

  return { backfill, tune, W, CPS };
});

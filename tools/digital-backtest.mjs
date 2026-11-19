#!/usr/bin/env node
// Offline backtest: price each 5-minute window as a digital (cash-or-nothing) option from second-by-second data and
// compare it with the pinned live model and with Polymarket's own prices. Read-only: touches no bot code or state.
//
//   node tools/digital-backtest.mjs --lag <dir>[,<dir>...] [--cache data/digital-cache.json]
//
// Inputs
//   lag files    the bot's recordings, one JSON row per second: [ts ms, Ws, elapsed s, Coinbase BTC, .com bid, .com ask,
//                US bid, US ask, ...] (US = Polymarket US prices for Up). Rows exist from 5 s into a window while both
//                books are readable.
//   fetched      Polymarket US start price (K) and settlement for every window (cached), Coinbase 5-min candles for
//                the pinned model, Coinbase 1-min candles as the start-gap fallback.
//
// Models, all P(Up) at a moment with tau seconds left
//   pinned   the live model (Nov 17): 6 x 5-min Parkinson vol, end-60 settlement, velocity 3 bars, gamma -0.15
//   digital  zero drift, end-60 settlement, sigma ($ per sqrt-second) from 1-second Coinbase moves over the last
//            60/120/180/300 s or an EWMA (60 s half-life); CDF Normal or Student-t (nu 3, 5) scaled to unit variance;
//            Coinbase shifted by the start gap (Coinbase's 60-s average before the window minus Polymarket's start
//            price, which is the official index's 60-s average)
//   market   Polymarket US mid, polymarket.com mid
//
// Scoring: Brier and log loss at fixed checkpoints (240..30 s left). Trading: one taker buy per window, the first second
// from 240 to 30 s left where the model's chance beats ask + fee + slippage by the edge threshold; a "missed fill"
// variant drops the order when the side's ask rises within the next 2 seconds (the price running away, which is when
// live orders failed to fill). The days are split in half: choose on the first half, judge on the second.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const E = req(join(ROOT, 'engine.js'));
const Signal = req(join(ROOT, 'signal.js'));
const W = 300, A = 60;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LAG_DIRS = (arg('--lag', '') || '').split(',').filter(Boolean);
const CACHE = resolve(arg('--cache', join(ROOT, 'data', 'digital-cache.json')));
if (!LAG_DIRS.length) { console.error('usage: node tools/digital-backtest.mjs --lag <dir>[,<dir>...]'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fee = (p) => 0.095 * p * (1 - p);   // Polymarket US taker fee per contract

// ---------------------------------------------------------------- data
const rows = new Map();   // Ws -> [{ ts, e, btc, cb, ca, ub, ua }] by time
for (const dir of LAG_DIRS) for (const f of readdirSync(dir).filter((x) => /^lag-.*\.jsonl$/.test(x)).sort()) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    const [ts, Ws, e, btc, cb, ca, ub, ua] = r;
    if (!(btc > 0)) continue;
    if (!rows.has(Ws)) rows.set(Ws, new Map());
    rows.get(Ws).set(ts, { ts: ts / 1000, e, btc, cb, ca, ub, ua });   // keyed by ts: overlapping copies merge
  }
}
for (const [Ws, m] of rows) rows.set(Ws, [...m.values()].sort((a, b) => a.ts - b.ts));
const windows = [...rows.keys()].sort((a, b) => a - b);
const tick = []; for (const Ws of windows) for (const r of rows.get(Ws)) tick.push(r);   // one Coinbase series
tick.sort((a, b) => a.ts - b.ts);

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : { terms: {}, c5: {}, c1: {} };
async function getJSON(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: { 'User-Agent': 'btc-patterns-backtest' } }); if (r.ok) return r.json(); } catch { /* retry */ } await sleep(800 * (i + 1)); } return null; }
async function fetchTerms() {
  const todo = windows.filter((Ws) => !(Ws in cache.terms) && Ws + W + 120 < Date.now() / 1000);
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length) {
      const Ws = todo[i++];
      for (let k = 0; k < 3; k++) { try { const u = await Signal.fetchUsTerms(Ws); cache.terms[Ws] = u && u.priceToBeat && u.settlementPrice ? [u.priceToBeat, u.settlementPrice] : null; break; } catch { await sleep(700); } }
    }
  }));
}
async function fetchCandles(gran, key) {
  const lo = windows[0] - 40 * 300, hi = windows[windows.length - 1] + 600;
  for (let t = lo - (lo % (gran * 300)); t < hi; t += gran * 300) {
    if (cache[key][t]) continue;
    const j = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${gran}&start=${new Date(t * 1000).toISOString()}&end=${new Date(Math.min(hi, t + gran * 300) * 1000).toISOString()}`);
    if (Array.isArray(j)) { cache[key][t] = 1; const d = cache[key + 'd'] || (cache[key + 'd'] = {}); for (const c of j) d[c[0]] = [c[3], c[2], c[1], c[4]]; }   // [open, high, low, close]
    await sleep(150);
  }
}
await fetchTerms(); await fetchCandles(300, 'c5'); await fetchCandles(60, 'c1');
writeFileSync(CACHE, JSON.stringify(cache));
const C5 = Object.entries(cache.c5d || {}).map(([t, [o, h, l, c]]) => ({ t: +t, o, h, l, c })).sort((a, b) => a.t - b.t);
const idx5 = new Map(C5.map((k, i) => [k.t, i]));
const c1 = cache.c1d || {};

// ---------------------------------------------------------------- math
const PIN = { mode: 'end60', volBars: 6, volScale: 1, beta: 0, gamma: -0.15, velBars: 3 };
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
// Student-t CDFs (closed forms for nu = 3 and 5), argument scaled so the distribution has unit variance
function tCdf(z, nu) {
  const t = z * Math.sqrt(nu / (nu - 2)), u = t / Math.sqrt(nu), a = 1 + t * t / nu;
  if (nu === 3) return 0.5 + (u / a + Math.atan(u)) / Math.PI;
  if (nu === 5) return 0.5 + ((u / a) * (1 + 2 / (3 * a)) + Math.atan(u)) / Math.PI;
  throw new Error('nu must be 3 or 5');
}
function normInv(p) {   // Acklam
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const q = p < 0.02425 ? Math.sqrt(-2 * Math.log(p)) : p > 1 - 0.02425 ? Math.sqrt(-2 * Math.log(1 - p)) : null;
  if (q != null) { const x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); return p < 0.5 ? x : -x; }
  const r = p - 0.5, s = r * r; return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}
// end-60 settlement: mean and spread of the settlement average, per unit sigma
function settleDist(S, K, tau, avgLast60) {
  if (tau > A) return { mean: S, g: Math.sqrt(tau - A + A / 3) };
  const avg = avgLast60 != null ? avgLast60 : S;
  return { mean: ((A - tau) * avg + S * tau) / A, g: Math.pow(tau, 1.5) / (Math.sqrt(3) * A) };
}
// realized sigma ($ per sqrt-second) from 1-second Coinbase moves ending at time t
let tp = 0;
function rv(t, win) {
  while (tp < tick.length - 1 && tick[tp + 1].ts <= t) tp++;
  while (tp > 0 && tick[tp].ts > t) tp--;
  let s = 0, w = 0, n = 0;
  for (let j = tp; j > 0; j--) {
    const a = tick[j - 1], b = tick[j], dt = b.ts - a.ts, age = t - b.ts;
    if (win !== 'ewma' && age > win) break;
    if (win === 'ewma' && age > 600) break;
    if (!(dt > 0) || dt > 10) continue;
    const x = (b.btc - a.btc) ** 2 / dt, wt = win === 'ewma' ? Math.pow(0.5, age / 60) : 1;
    s += wt * x; w += wt; n++;
  }
  const need = win === 'ewma' ? 30 : win * 0.5;
  return n >= need && w > 0 ? Math.sqrt(s / w) : null;
}

// ---------------------------------------------------------------- per-window states
const RV_WINS = [60, 120, 180, 300, 'ewma'], CDFS = [['normal', (z) => normCdf(z)], ['t3', (z) => tCdf(z, 3)], ['t5', (z) => tCdf(z, 5)]];
const CHECK = [240, 180, 120, 90, 60, 45, 30];
const dayOf = (Ws) => new Date((Ws - 6 * 3600) * 1000).toISOString().slice(0, 10);
const days = [...new Set(windows.filter((Ws) => cache.terms[Ws]).map(dayOf))].sort();
const isDays = new Set(days.slice(0, Math.ceil(days.length / 2)));
const states = [];   // one per (window, second) with everything every model needs
for (const Ws of windows) {
  const tm = cache.terms[Ws]; if (!tm) continue;
  const [K, settle] = tm, up = settle >= K ? 1 : 0, rs = rows.get(Ws);
  // start gap: Coinbase's average over the minute before the window (the previous window's last 60 s of recordings,
  // else the 1-minute candle) minus the start price
  const prev = (rows.get(Ws - W) || []).filter((r) => r.e >= 240);
  const k1 = c1[Ws - 60];
  const cbStart = prev.length >= 20 ? prev.reduce((s, r) => s + r.btc, 0) / prev.length : k1 ? (k1[0] + k1[1] + k1[2] + k1[3]) / 4 : null;
  const gap = cbStart != null && Math.abs(cbStart - K) < 100 ? cbStart - K : 0;
  const i5 = idx5.get(Ws - W);
  const sig5 = i5 != null && i5 >= 10 ? E.parkinsonSigma(C5, i5, PIN.volBars, W) : null;
  const vel = sig5 ? E.velocity(C5, i5, PIN.velBars, sig5, W) : 0;
  for (const r of rs) {
    const tau = W - r.e; if (tau < 25 || tau > 245) continue;
    if (!(r.ua > 0 && r.ub >= 0 && r.ua <= 1 && r.ub < r.ua)) continue;
    const last = rs.filter((x) => x.e >= 240 && x.e <= r.e);
    const avg60 = last.length ? last.reduce((s, x) => s + x.btc, 0) / last.length : null;
    states.push({ Ws, e: r.e, tau, t: r.ts, S: r.btc, K, up, gap, avg60, ub: r.ub, ua: r.ua, com: r.cb >= 0 && r.ca > 0 ? (r.cb + r.ca) / 2 : null, sig5, vel, is: isDays.has(dayOf(Ws)) });
  }
}
// next-2-second ask for the missed-fill rule
const byWs = new Map(); for (const s of states) { if (!byWs.has(s.Ws)) byWs.set(s.Ws, []); byWs.get(s.Ws).push(s); }
for (const a of byWs.values()) for (let i = 0; i < a.length; i++) { const n = a.filter((x) => x.t > a[i].t && x.t <= a[i].t + 2.5); a[i].upNext = n.length ? Math.max(...n.map((x) => x.ua)) : a[i].ua; a[i].dnNext = n.length ? Math.max(...n.map((x) => 1 - x.ub)) : 1 - a[i].ub; }

// model functions: P(Up) for a state
const rvCache = new Map();
const rvAt = (s, win) => { const k = s.t + '|' + win; if (!rvCache.has(k)) rvCache.set(k, rv(s.t, win)); return rvCache.get(k); };
const pinned = (s) => { if (!s.sig5) return null; const pv = E.windowUpProb({ S: s.S, K: s.K, sigma: s.sig5 * PIN.volScale, elapsed: s.e, avgLast60: s.avg60, avgSoFar: s.S, mode: 'end60', W }); return E.combineWindow(pv, 0, s.vel, PIN); };
const digital = (win, F) => (s) => { const sig = rvAt(s, win); if (!(sig > 0)) return null; const d = settleDist(s.S - s.gap, s.K, s.tau, s.avg60 != null ? s.avg60 - s.gap : null); return F((d.mean - s.K) / (sig * d.g)); };
const models = [['pinned live model', pinned]];
for (const win of RV_WINS) for (const [cn, F] of CDFS) models.push([`digital ${win === 'ewma' ? 'EWMA 60s' : win + 's'} ${cn}`, digital(win, F)]);
models.push(['Polymarket US mid', (s) => (s.ub + s.ua) / 2], ['polymarket.com mid', (s) => s.com]);

// ---------------------------------------------------------------- scoring
const clamp = (p) => Math.min(0.999, Math.max(0.001, p));
function score(fn, set) {
  let ll = 0, br = 0, n = 0;
  for (const s of set) { const p = fn(s); if (p == null || !isFinite(p)) continue; const q = clamp(p); ll -= s.up ? Math.log(q) : Math.log(1 - q); br += (q - s.up) ** 2; n++; }
  return n ? { ll: ll / n, br: br / n, n } : null;
}
const atCheck = (half) => states.filter((s) => (half === 'is' ? s.is : !s.is) && CHECK.some((c) => s.tau === c));
// common set: only states where every model has a value, so the comparison is like for like
const common = (set) => set.filter((s) => models.every(([, fn]) => { const p = fn(s); return p != null && isFinite(p); }));

// ---------------------------------------------------------------- trading
function trade(fn, set, { thr, slip, missed, favOnly }) {
  const out = [];
  const ws = new Map(); for (const s of set) { if (s.tau > 240 || s.tau < 30) continue; if (!ws.has(s.Ws)) ws.set(s.Ws, []); ws.get(s.Ws).push(s); }
  for (const a of ws.values()) {
    for (const s of a) {
      const p = fn(s); if (p == null) continue;
      let took = null;
      for (const [isUp, pp, ask, next] of [[1, p, s.ua, s.upNext], [0, 1 - p, 1 - s.ub, s.dnNext]]) {
        if (!(ask > 0.02 && ask < 0.98)) continue;
        if (favOnly && ask < 0.5) continue;
        const cost = ask + slip + fee(ask + slip);
        if (pp - cost < thr) continue;
        took = { isUp, cost, miss: next > ask + 1e-9 }; break;
      }
      if (!took) continue;
      if (missed && took.miss) break;   // order didn't fill: price ran away; no retry this window
      out.push({ won: took.isUp === s.up ? 1 : 0, cost: took.cost }); break;
    }
  }
  const n = out.length, w = out.filter((x) => x.won).length, r = out.reduce((a, x) => a + (x.won ? 1 / x.cost - 1 : -1), 0);
  return { n, w, ret: n ? r / n : 0 };
}
// volatility compression: favorite where realized vol is well under the vol implied by its ask
function compression(win, ratio, set, { slip, missed }) {
  const out = [];
  const ws = new Map(); for (const s of set) { if (s.tau > 240 || s.tau < 30) continue; if (!ws.has(s.Ws)) ws.set(s.Ws, []); ws.get(s.Ws).push(s); }
  for (const a of ws.values()) for (const s of a) {
    const sig = rvAt(s, win); if (!(sig > 0)) continue;
    const d = settleDist(s.S - s.gap, s.K, s.tau, s.avg60 != null ? s.avg60 - s.gap : null), dist = d.mean - s.K;
    const isUp = dist >= 0, ask = isUp ? s.ua : 1 - s.ub; if (!(ask >= 0.5 && ask < 0.97) || Math.abs(dist) < 1e-6) continue;
    const ivSig = Math.abs(dist) / (normInv(ask) * d.g); if (!(ivSig > 0)) continue;
    if (sig / ivSig >= ratio) continue;
    const next = isUp ? s.upNext : s.dnNext;
    if (missed && next > ask + 1e-9) break;
    const cost = ask + slip + fee(ask + slip); out.push({ won: isUp === !!s.up ? 1 : 0, cost }); break;
  }
  const n = out.length, w = out.filter((x) => x.won).length, r = out.reduce((a, x) => a + (x.won ? 1 / x.cost - 1 : -1), 0);
  return { n, w, ret: n ? r / n : 0 };
}

// ---------------------------------------------------------------- report
const f4 = (x) => (x == null ? '—' : x.toFixed(4)), pct = (x) => (x >= 0 ? '+' : '') + (100 * x).toFixed(1) + '%';
const IS = states.filter((s) => s.is), OOS = states.filter((s) => !s.is);
console.log(`# Digital option backtest\n\nRecordings: ${windows.length} windows, ${states.length} seconds scored (25–245 s left), ${days.length} days (${days[0]} to ${days[days.length - 1]}). In-sample: ${[...isDays].join(', ')}. Out-of-sample: ${days.filter((d) => !isDays.has(d)).join(', ')}.\n`);
const cIS = common(atCheck('is')), cOOS = common(atCheck('oos'));
console.log(`## Accuracy at ${CHECK.join('/')} s left (same seconds for every model: ${cIS.length} in-sample, ${cOOS.length} out-of-sample)\n`);
console.log('| Model | Log loss IS | Log loss OOS | Brier IS | Brier OOS |\n|---|---|---|---|---|');
const scored = models.map(([name, fn]) => ({ name, is: score(fn, cIS), oos: score(fn, cOOS) }));
for (const m of scored) console.log(`| ${m.name} | ${f4(m.is && m.is.ll)} | ${f4(m.oos && m.oos.ll)} | ${f4(m.is && m.is.br)} | ${f4(m.oos && m.oos.br)} |`);
const dig = scored.filter((m) => m.name.startsWith('digital'));
const best = dig.reduce((a, b) => (b.is.ll < a.is.ll ? b : a));
console.log(`\nBest digital model on the in-sample days: **${best.name}**.\n`);
console.log('## Accuracy by time left, out-of-sample (log loss)\n');
const pick = [scored[0], best, scored.find((m) => m.name === 'Polymarket US mid')];
console.log(`| Seconds left | ${pick.map((m) => m.name).join(' | ')} |\n|---|${pick.map(() => '---').join('|')}|`);
for (const c of CHECK) { const set = cOOS.filter((s) => s.tau === c); console.log(`| ${c} | ${pick.map((m) => f4((score(models.find(([n]) => n === m.name)[1], set) || {}).ll)).join(' | ')} |`); }
console.log('\n## Trading: one taker buy per window when the model beats ask + fee + slippage\n');
console.log('Each cell: bets · won · return per $1. "Missed fills" drops an order when the side\'s ask rises within 2 s.\n');
const fnOf = (name) => models.find(([n]) => n === name)[1];
for (const favOnly of [false, true]) {
  console.log(`### ${favOnly ? 'Favorites only (ask 50¢+)' : 'Any side'}\n`);
  console.log('| Model | Edge needed | Slippage | IS | OOS | OOS with missed fills |\n|---|---|---|---|---|---|');
  for (const name of ['pinned live model', best.name]) for (const thr of [0, 0.03, 0.06]) for (const slip of [0, 0.01, 0.02]) {
    const a = trade(fnOf(name), IS, { thr, slip, missed: false, favOnly }), b = trade(fnOf(name), OOS, { thr, slip, missed: false, favOnly }), c = trade(fnOf(name), OOS, { thr, slip, missed: true, favOnly });
    const cell = (x) => `${x.n} · ${x.n ? Math.round(100 * x.w / x.n) : 0}% · ${pct(x.ret)}`;
    console.log(`| ${name} | ${thr * 100}% | ${slip * 100}¢ | ${cell(a)} | ${cell(b)} | ${cell(c)} |`);
  }
  console.log('');
}
console.log('## Volatility compression: buy the favorite when realized vol / implied vol is under the ratio\n');
console.log('| Realized vol window | Ratio under | Slippage | IS | OOS | OOS with missed fills |\n|---|---|---|---|---|---|');
for (const win of RV_WINS) for (const ratio of [0.7, 0.8]) for (const slip of [0, 0.01]) {
  const a = compression(win, ratio, IS, { slip, missed: false }), b = compression(win, ratio, OOS, { slip, missed: false }), c = compression(win, ratio, OOS, { slip, missed: true });
  const cell = (x) => `${x.n} · ${x.n ? Math.round(100 * x.w / x.n) : 0}% · ${pct(x.ret)}`;
  console.log(`| ${win === 'ewma' ? 'EWMA 60s' : win + 's'} | ${ratio} | ${slip * 100}¢ | ${cell(a)} | ${cell(b)} | ${cell(c)} |`);
}

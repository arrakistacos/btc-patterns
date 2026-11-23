#!/usr/bin/env node
// TV Divergence: offline backtest of the manual "TradingView flipped, Polymarket hasn't caught up" strategy on the
// bot's 1-second recordings. Reads files only; trades nothing, changes nothing, touches no live code.
//
// Entry (one per window), every condition at the same second:
//   time      Tmin <= T <= 150 s left, Tmin in {20, 30, 45}
//   flip      Coinbase spot is on side X of the window's open K (Polymarket's price to beat), and was on the other
//             side of K at some point in the 60 s before the hold began
//   distance  |S - K| >= B, B in {$20, $35, $50, $75, $100}
//   hold      spot has stayed >= B on side X for k consecutive seconds, k in {1, 3, 5}
//   lag       Polymarket US's ask for side X <= cap, cap in {70¢, 65¢, 50¢ (Polymarket still favors the other side)}
//   order     limit = ask + tol, tol in {0, 1, 2}¢, filled at the next second's ask
// Conviction (for the sizing check only): c = (|S-K| - B)/B + (0.70 - ask)/0.20 + (150 - T)/120, i.e. distance past
//   the buffer, how far under 70¢ Polymarket still is, and how little time is left, in roughly equal units.
// Evaluation: flat $1 per bet with the Polymarket taker fee 0.095·p·(1-p); days in order, the first half picks the
//   setting, the second half is only scored. Sizing is simulated only if high-conviction bets beat low-conviction ones
//   out-of-sample. The catch-up check asks how often Polymarket's price for side X rose 5¢+ within 15 s.
//
// usage: node tools/tv-divergence-backtest.mjs --lag DIR[,DIR...] --log FILE@start=YYYY-MM-DD [--log FILE@end=YYYY-MM-DD]
//          [--min-bets 25] [--out report.md]

import { writeFileSync } from 'node:fs';
import { loadWindows, fee } from './recordings.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const lagDirs = (opt('--lag', '') || '').split(',').filter(Boolean), logs = opts('--log');
const MIN_BETS = +opt('--min-bets', 25), OUT = opt('--out', null);
if (!lagDirs.length || !logs.length) { console.error('usage: --lag DIR[,DIR] --log FILE@start=YYYY-MM-DD|@end=YYYY-MM-DD ...'); process.exit(1); }

const { windows, days, ticksIn, ticksOut } = loadWindows({ lagDirs, logs });
const IS_DAYS = new Set(days.slice(0, Math.floor(days.length / 2)));
const ret = (px, win) => { const c = px + fee(px); return win ? 1 / c - 1 : -1; };

// per window: the last 150 s with the side-X ask, the next second's ask and the ask 15 s later
for (const w of windows) {
  w.pre = null; if (w.K == null) continue;
  const a = [];
  for (let i = 0; i < w.rows.length; i++) {
    const r = w.rows[i], T = 300 - r.e; if (T > 150) continue;
    const later = (dt) => { for (let j = i + 1; j < w.rows.length; j++) if (w.rows[j].e >= r.e + dt) return w.rows[j].e - r.e <= dt + 3 ? w.rows[j] : null; return null; };
    const n = w.rows[i + 1], l15 = later(15);
    a.push({ i, e: r.e, T, d: r.S - w.K, askUp: r.ask, askDn: 1 - r.bid, nUp: n && n.e - r.e <= 2 ? n.ask : null, nDn: n && n.e - r.e <= 2 ? 1 - n.bid : null, l15Up: l15 ? (l15.bid + l15.ask) / 2 : null });
  }
  w.pre = a;
  w.sideAt = (e) => { let s = 0; for (const r of w.rows) { if (r.e > e) break; if (r.S > w.K) s = 1; else if (r.S < w.K) s = -1; } return s; };
}

const cache = new Map();
function trades(cfg) {
  const key = JSON.stringify(cfg); if (cache.has(key)) return cache.get(key);
  const out = [];
  for (const w of windows) {
    if (!w.pre) continue;
    const rows = w.rows;
    let hold = 0, holdSide = 0, holdStartE = null;
    for (const x of w.pre) {
      if (x.T < cfg.tmin) break;
      const side = x.d >= cfg.B ? 1 : x.d <= -cfg.B ? -1 : 0;
      if (side !== 0 && side === holdSide) hold++; else { hold = side ? 1 : 0; holdSide = side; holdStartE = x.e; }
      if (!side || hold < cfg.k) continue;
      // the flip: on the other side of K at some point in the 60 s before the hold began
      let flipped = false;
      for (let j = x.i - hold; j >= 0 && holdStartE - rows[j].e <= 60; j--) { const s = rows[j].S - w.K; if ((side > 0 && s < 0) || (side < 0 && s > 0)) { flipped = true; break; } }
      if (!flipped) continue;
      const up = side > 0, ask = up ? x.askUp : x.askDn;
      if (!(ask <= cfg.cap + 1e-9) || ask <= 0.02) continue;
      const nAsk = up ? x.nUp : x.nDn, filled = nAsk != null && nAsk <= ask + cfg.tol + 1e-9;
      const midX = up ? null : null; void midX;
      const now = up ? (x.askUp + (1 - x.askDn)) / 2 : 1 - (x.askUp + (1 - x.askDn)) / 2;
      const l15 = x.l15Up == null ? null : up ? x.l15Up : 1 - x.l15Up;
      const conv = (Math.abs(x.d) - cfg.B) / cfg.B + (0.70 - ask) / 0.20 + (150 - x.T) / 120;
      out.push({ Ws: w.Ws, day: w.day, is: IS_DAYS.has(w.day), T: x.T, dist: Math.abs(x.d), ask, filled, px: filled ? nAsk : null, win: (up ? 1 : 0) === w.won ? 1 : 0, conv, caught: l15 == null ? null : l15 - now >= 0.05 ? 1 : 0 });
      break;
    }
  }
  cache.set(key, out); return out;
}
const S = (t) => {
  const f = t.filter((x) => x.filled), m = t.filter((x) => !x.filled), w = f.filter((x) => x.win).length;
  return { seen: t.length, n: f.length, w, px: f.length ? f.reduce((s, x) => s + x.px, 0) / f.length : null, r: f.length ? f.reduce((s, x) => s + ret(x.px, x.win), 0) / f.length : null, missN: m.length, missW: m.filter((x) => x.win).length };
};

const GRID = [];
for (const tmin of [20, 30, 45]) for (const B of [20, 35, 50, 75, 100]) for (const k of [1, 3, 5]) for (const cap of [0.70, 0.65, 0.50]) for (const tol of [0, 0.01, 0.02]) GRID.push({ tmin, B, k, cap, tol });
const name = (c) => `T ${c.tmin}–150 s, B $${c.B}, hold ${c.k} s, ask ≤ ${Math.round(c.cap * 100)}¢, +${Math.round(c.tol * 100)}¢`;

const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const sgn = (x) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const wil = (w, n) => { if (!n) return '—'; const z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${((c - h) * 100).toFixed(0)}–${((c + h) * 100).toFixed(0)}%`; };
const line = (lab, s) => `| ${lab} | ${s.seen} | ${s.n} (${pct(s.seen ? s.n / s.seen : null)}) | ${pct(s.n ? s.w / s.n : null)} (${wil(s.w, s.n)}) | ${s.px == null ? '—' : (s.px * 100).toFixed(1) + '¢'} | ${pct(s.px == null ? null : s.px + fee(s.px))} | ${sgn(s.r)} | ${s.missN ? `${s.missW}/${s.missN} (${pct(s.missW / s.missN)})` : '—'} |`;
const HEAD = '| Sample | Triggers | Filled | Won (95% range) | Avg fill | Break-even | Per $1 | Unfilled that won |\n|---|---|---|---|---|---|---|---|';

const L = [];
L.push('# TV Divergence backtest', '', `Generated ${new Date().toISOString()}. Recordings: ${lagDirs.join(', ')}.`, '');
L.push(`- Windows with a recording, a known outcome and an open price: **${windows.filter((w) => w.pre).length}** over ${days.length} days (${days[0]} to ${days.at(-1)}). Sanity guard dropped ${ticksOut} of ${ticksIn} ticks.`);
L.push(`- In-sample (picks the setting): ${[...IS_DAYS][0]} to ${[...IS_DAYS].at(-1)} · out-of-sample (scored only): ${days.find((d) => !IS_DAYS.has(d))} to ${days.at(-1)}. Settings tried: ${GRID.length}.`, '');

// flat $1, all settings
const res = GRID.map((c) => { const t = trades(c); return { c, si: S(t.filter((x) => x.is)), so: S(t.filter((x) => !x.is)), t }; });
const okOut = res.filter((x) => x.so.n >= MIN_BETS);
L.push('## Flat $1 per bet', '', `Out-of-sample, ${okOut.filter((x) => x.so.r > 0).length} of ${okOut.length} settings (with at least ${MIN_BETS} out-of-sample bets) made money; median ${sgn(okOut.map((x) => x.so.r).sort((a, b) => a - b)[Math.floor(okOut.length / 2)])} per $1.`, '');
const pick = res.filter((x) => x.si.n >= MIN_BETS).sort((a, b) => b.si.r - a.si.r);
L.push('### Top 10 on the first half, scored on the second', '', '| Setting | In: bets, won, per $1 | Out: bets, won, per $1 | Out: unfilled that won |', '|---|---|---|---|');
for (const x of pick.slice(0, 10)) L.push(`| ${name(x.c)} | ${x.si.n}, ${pct(x.si.w / x.si.n)}, ${sgn(x.si.r)} | ${x.so.n}, ${pct(x.so.n ? x.so.w / x.so.n : null)}, ${sgn(x.so.r)} | ${x.so.missN ? `${x.so.missW}/${x.so.missN}` : '—'} |`);
L.push('');
// the three lag caps side by side, at a middle setting, so the "true disagreement" case is visible on its own
L.push('### The lag cap on its own (T 30–150 s, B $35, hold 3 s, +1¢)', '', HEAD.replace('Sample', 'Cap · sample'));
for (const cap of [0.70, 0.65, 0.50]) { const t = trades({ tmin: 30, B: 35, k: 3, cap, tol: 0.01 }); L.push(line(`≤ ${Math.round(cap * 100)}¢ · in`, S(t.filter((x) => x.is))), line(`≤ ${Math.round(cap * 100)}¢ · **out**`, S(t.filter((x) => !x.is)))); }
L.push('');

const best = pick[0];
if (best) {
  L.push(`## The in-sample pick in full: ${name(best.c)}`, '', HEAD, line('in-sample', best.si), line('**out-of-sample**', best.so), '');
  // price bands: long shots can carry an average
  const fo = best.t.filter((x) => x.filled);
  L.push('| Price paid (all days, filled) | Bets | Won | Per $1 |', '|---|---|---|---|');
  for (const [lo, hi] of [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.71]]) { const a = fo.filter((x) => x.px >= lo && x.px < hi); if (a.length) { const w = a.filter((x) => x.win).length; L.push(`| ${Math.round(lo * 100)}–${Math.round(Math.min(hi, 0.7) * 100)}¢ | ${a.length} | ${pct(w / a.length)} (${wil(w, a.length)}) | ${sgn(a.reduce((s, x) => s + ret(x.px, x.win), 0) / a.length)} |`); } }
  L.push('');
  // conviction tertiles, out-of-sample
  const oo = best.t.filter((x) => !x.is && x.filled).sort((a, b) => a.conv - b.conv);
  const third = Math.floor(oo.length / 3), tiers = [['Low', oo.slice(0, third)], ['Medium', oo.slice(third, 2 * third)], ['High', oo.slice(2 * third)]];
  L.push('### Does conviction predict? (out-of-sample, flat $1)', '', '| Conviction | Bets | Won | Avg price | Per $1 |', '|---|---|---|---|---|');
  for (const [lab, a] of tiers) { const w = a.filter((x) => x.win).length; L.push(`| ${lab} | ${a.length} | ${pct(a.length ? w / a.length : null)} (${wil(w, a.length)}) | ${a.length ? (a.reduce((s, x) => s + x.px, 0) / a.length * 100).toFixed(1) + '¢' : '—'} | ${sgn(a.length ? a.reduce((s, x) => s + ret(x.px, x.win), 0) / a.length : null)} |`); }
  const rr = (a) => (a.length ? a.reduce((s, x) => s + ret(x.px, x.win), 0) / a.length : -Infinity);
  const highBeats = tiers[2][1].length >= 10 && rr(tiers[2][1]) > rr(tiers[0][1]) && rr(tiers[2][1]) > 0;
  L.push('');
  if (!highBeats) L.push('High conviction did not beat low conviction out-of-sample (or lost money), so bigger bets on high conviction are not supported and the sizing simulation is skipped, as planned.', '');
  else {
    const lo = oo[third] ? oo[third].conv : 0, hi = oo[2 * third] ? oo[2 * third].conv : 0;
    const size = (scheme, x) => scheme === 'flat2' ? 0.02 : scheme === 's5_10' ? (x.conv >= hi ? 0.10 : x.conv >= lo ? 0.075 : 0.05) : (x.conv >= hi ? 0.30 : x.conv >= lo ? 0.25 : 0.20);
    const sim = (scheme, a, runs = 4000) => { let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648; const N = Math.round(a.length / Math.max(1, new Set(a.map((x) => x.day)).size) * 30); let ruin = 0; const ends = [], dds = []; for (let k = 0; k < runs; k++) { let b = 1, pk = 1, dd = 0; for (let i = 0; i < N; i++) { const x = a[Math.floor(rnd() * a.length)]; b += b * size(scheme, x) * ret(x.px, x.win); pk = Math.max(pk, b); dd = Math.max(dd, 1 - b / pk); } ends.push(b); dds.push(dd); if (b < 0.25) ruin++; } ends.sort((p, q) => p - q); dds.sort((p, q) => p - q); return { N, med: ends[runs >> 1], p10: ends[Math.floor(runs * 0.1)], dd: dds[runs >> 1], ruin: ruin / runs }; };
    L.push('### Sizing (out-of-sample bets, 30-day bootstrap)', '', '| Sizing | Median end | 10th pct end | Median worst drop | Lost 75%+ |', '|---|---|---|---|---|');
    for (const [lab, sc] of [['2% flat', 'flat2'], ['5–10% by conviction', 's5_10'], ['20–30% by conviction', 's20_30']]) { const r = sim(sc, oo); L.push(`| ${lab} | ${r.med.toFixed(2)}× | ${r.p10.toFixed(2)}× | ${pct(r.dd)} | ${pct(r.ruin)} |`); }
    L.push('');
  }
}

// catch-up: does Polymarket actually follow?
L.push('## Catch-up check: is the lag real?', '', 'For every trigger (filled or not), how often Polymarket\'s price for the bet side rose 5¢ or more within 15 s, and how those windows ended.', '', '| Setting | Triggers | Rose 5¢+ in 15 s | Won when it rose | Won when it didn\'t |', '|---|---|---|---|---|');
for (const c of [{ tmin: 30, B: 20, k: 1, cap: 0.70, tol: 0.01 }, { tmin: 30, B: 35, k: 3, cap: 0.70, tol: 0.01 }, { tmin: 30, B: 50, k: 3, cap: 0.65, tol: 0.01 }, { tmin: 30, B: 35, k: 3, cap: 0.50, tol: 0.01 }, ...(best ? [best.c] : [])]) {
  const t = trades(c).filter((x) => x.caught != null), up = t.filter((x) => x.caught), dn = t.filter((x) => !x.caught);
  L.push(`| ${name(c)} | ${t.length} | ${pct(t.length ? up.length / t.length : null)} | ${pct(up.length ? up.filter((x) => x.win).length / up.length : null)} | ${pct(dn.length ? dn.filter((x) => x.win).length / dn.length : null)} |`);
}
L.push('', '## Notes', '',
  '- Spot is Coinbase, once a second. TradingView on another exchange (Binance BTCUSDT especially) can lead or sit a few dollars away; the recordings can\'t show that.',
  '- K is Polymarket\'s price to beat (the BRTI index), which is what the market settles against; a TradingView candle\'s open can differ by about $12, which is what the buffer B is for.',
  '- A fill is the next recorded second\'s ask. Clicking by hand is slower, so manual fills would be later and often worse.',
  '- Per $1 is the average over filled bets of (won ? 1/(price + fee) − 1 : −1).');
const report = L.join('\n');
if (OUT) writeFileSync(OUT, report + '\n');
console.log(report);

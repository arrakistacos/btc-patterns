#!/usr/bin/env node
// Spot flip ("TradingView flipped, Polymarket hasn't caught up"): offline backtest of Paul's manual strategy on the
// bot's 1-second recordings. Reads files only; trades nothing, changes nothing, touches no live code.
//
// The manual strategy, as described (Nov 23):
//   With 2:30 or less left, watch the 5-minute candle (Coinbase spot) against Polymarket. When the candle has just
//   flipped to the other side of its open, far enough from it to trust, while Polymarket still prices that side
//   near 50/50 or as the underdog, buy that side on Polymarket (usually under 70¢), early enough that Polymarket has
//   time to catch up. Bet bigger (20–30%) the more of the edges line up: less time left, more distance, Polymarket
//   further behind.
//
// As rules (each a setting below):
//   T        seconds left, Tmin <= T <= 150
//   open     the candle's open: 'candle' = the first Coinbase price recorded in the window (TradingView's open, give
//            or take a few seconds), or 'ptb' = Polymarket's price to beat (the BRTI index the market settles on)
//   flip     spot is now on side X of the open, and was on the other side within the last F seconds
//   distance |spot - open| >= D dollars
//   price    side X's ask on Polymarket US < maxAsk (the "Polymarket hasn't caught up" part)
//   order    first moment in the window that all hold: buy X, limit = ask + tol, filled at the next second's ask
//   sizing   flat 2/10/20/30% of the balance, or tiered by confidence (10%, +10% if distance >= 2D, +10% if the
//            ask <= 55¢: 10–30%), compounding in time order
//
// Returns per $1 include the Polymarket taker fee 0.095·p·(1-p). One setting chosen up front from the description is
// scored on every day with no tuning; the full grid picks on the first half of the days and is scored on the second.
//
// usage: node tools/spot-flip-backtest.mjs --lag DIR[,DIR...] --log FILE@start=YYYY-MM-DD [--log FILE@end=YYYY-MM-DD]
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
// per window and open: the last 150 s as plain arrays, with when spot was last on each side of the open
for (const w of windows) {
  const f = w.rows.find((r) => r.e <= 10); w.candleOpen = f ? f.S : null;
  w.pre = {};
  for (const open of ['candle', 'ptb']) {
    const O = open === 'candle' ? w.candleOpen : w.K; if (O == null) continue;
    let lastUp = -1e9, lastDn = -1e9; const a = [];
    for (let i = 0; i < w.rows.length; i++) {
      const r = w.rows[i], d = r.S - O;
      if (300 - r.e <= 150) {
        const up = d > 0, n = w.rows[i + 1];
        a.push({ e: r.e, T: 300 - r.e, d, up, lastOpp: up ? lastDn : lastUp, ask: up ? r.ask : 1 - r.bid, nAsk: n && n.e - r.e <= 2 ? (up ? n.ask : 1 - n.bid) : null });
      }
      if (d > 0) lastUp = r.e; else if (d < 0) lastDn = r.e;
    }
    w.pre[open] = a;
  }
}

const ret = (px, win) => { const c = px + fee(px); return win ? 1 / c - 1 : -1; };

// one setting: every window's first qualifying moment, its fill and result
const cache = new Map();
function trades(cfg, which) {
  const key = JSON.stringify(cfg);
  let all = cache.get(key);
  if (!all) {
    all = [];
    for (const w of windows) {
      const a = w.pre[cfg.open]; if (!a) continue;
      for (const x of a) {
        if (x.T < cfg.tmin) break;
        if (Math.abs(x.d) < cfg.D || x.e - x.lastOpp > cfg.F) continue;
        if (!(x.ask < cfg.maxAsk) || x.ask <= 0.02) continue;
        const win = (x.up ? 1 : 0) === w.won ? 1 : 0;
        const tier = 0.10 + (Math.abs(x.d) >= 2 * cfg.D ? 0.10 : 0) + (x.ask <= 0.55 ? 0.10 : 0);
        all.push({ Ws: w.Ws, day: w.day, T: x.T, dist: Math.abs(x.d), ask: x.ask, filled: x.nAsk != null && x.nAsk <= x.ask + cfg.tol + 1e-9, px: x.nAsk, win, tier });
        break;
      }
    }
    if (cache.size < 50000) cache.set(key, all);
  }
  return which === 'all' ? all : all.filter((t) => IS_DAYS.has(t.day) === (which === 'in'));
}
const stats = (t) => {
  const f = t.filter((x) => x.filled), w = f.filter((x) => x.win).length;
  return { seen: t.length, n: f.length, w, px: f.length ? f.reduce((s, x) => s + x.px, 0) / f.length : null, r: f.length ? f.reduce((s, x) => s + ret(x.px, x.win), 0) / f.length : null, knife: f.filter((x) => x.px < x.ask - 0.015).length };
};

// bankroll: compounding in time order, and by bootstrap over 30 days at the same pace
function bankroll(t, size) {
  const f = t.filter((x) => x.filled).sort((a, b) => a.Ws - b.Ws);
  let b = 1, peak = 1, dd = 0;
  for (const x of f) { const k = typeof size === 'number' ? size : x.tier; b += b * k * ret(x.px, x.win); peak = Math.max(peak, b); dd = Math.max(dd, 1 - b / peak); }
  return { end: b, dd };
}
function bootstrap(t, size, nDays, runs = 4000) {
  const f = t.filter((x) => x.filled); if (!f.length) return null;
  const perDay = f.length / new Set(t.map((x) => x.day)).size, N = Math.round(perDay * nDays);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ends = [], dds = []; let ruin = 0;
  for (let k = 0; k < runs; k++) {
    let b = 1, peak = 1, dd = 0;
    for (let i = 0; i < N; i++) { const x = f[Math.floor(rnd() * f.length)]; const s = typeof size === 'number' ? size : x.tier; b += b * s * ret(x.px, x.win); peak = Math.max(peak, b); dd = Math.max(dd, 1 - b / peak); }
    ends.push(b); dds.push(dd); if (b < 0.25) ruin++;
  }
  ends.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  return { N, p10: ends[Math.floor(runs * 0.1)], med: ends[Math.floor(runs / 2)], p90: ends[Math.floor(runs * 0.9)], ddMed: dds[Math.floor(runs / 2)], ruin: ruin / runs };
}

// ---------- grid
const GRID = [];
for (const open of ['candle', 'ptb']) for (const tmin of [15, 30, 45, 60]) for (const F of [10, 30, 60]) for (const D of [5, 10, 20, 30, 50]) for (const maxAsk of [0.55, 0.60, 0.65, 0.70]) for (const tol of [0, 0.01, 0.02]) GRID.push({ open, tmin, F, D, maxAsk, tol });
const AS_DESCRIBED = { open: 'candle', tmin: 30, F: 30, D: 20, maxAsk: 0.70, tol: 0.01 };
const name = (c) => `open=${c.open}, T ${c.tmin}–150 s, flip within ${c.F} s, distance ≥ $${c.D}, ask < ${Math.round(c.maxAsk * 100)}¢, +${Math.round(c.tol * 100)}¢ tol`;

// ---------- report
const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const sgn = (x) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const wilson = (w, n) => { if (!n) return '—'; const z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${((c - h) * 100).toFixed(0)}–${((c + h) * 100).toFixed(0)}%`; };
const row = (lab, s) => `| ${lab} | ${s.seen} | ${s.n} (${pct(s.seen ? s.n / s.seen : null)}) | ${pct(s.n ? s.w / s.n : null)} (${wilson(s.w, s.n)}) | ${s.px == null ? '—' : (s.px * 100).toFixed(1) + '¢'} | ${pct(s.px == null ? null : s.px + fee(s.px))} | ${sgn(s.r)} | ${s.knife} |`;
const HEAD = '| Sample | Setups | Filled | Won (95% range) | Avg fill | Break-even | Per $1 | Filled 2¢+ under |\n|---|---|---|---|---|---|---|---|';
const L = [];
L.push('# Spot flip backtest (the manual TradingView vs Polymarket strategy)', '', `Generated ${new Date().toISOString()}. Recordings: ${lagDirs.join(', ')}.`, '');
L.push(`- Windows with a recording and a known outcome: **${windows.length}** over ${days.length} days (${days[0]} to ${days.at(-1)}). Sanity guard dropped ${ticksOut} of ${ticksIn} ticks.`);
L.push(`- In-sample (picks settings): ${[...IS_DAYS][0]} to ${[...IS_DAYS].at(-1)} · out-of-sample: ${days.find((d) => !IS_DAYS.has(d))} to ${days.at(-1)}. Grid: ${GRID.length} settings.`, '');

const show = (title, cfg) => {
  const all = trades(cfg, 'all'), si = stats(trades(cfg, 'in')), so = stats(trades(cfg, 'out')), sa = stats(all);
  L.push(`### ${title}`, '', `**${name(cfg)}**`, '', HEAD, row('in-sample', si), row('**out-of-sample**', so), row('all days', sa), '');
  // does confidence predict? tiers and distance bands, all days
  const f = all.filter((x) => x.filled);
  const band = (lab, a) => { const w = a.filter((x) => x.win).length; return `| ${lab} | ${a.length} | ${pct(a.length ? w / a.length : null)} (${wilson(w, a.length)}) | ${sgn(a.length ? a.reduce((s, x) => s + ret(x.px, x.win), 0) / a.length : null)} |`; };
  L.push('| Confidence (all days, filled) | Bets | Won | Per $1 |', '|---|---|---|---|',
    band('tier 10% (base)', f.filter((x) => Math.abs(x.tier - 0.1) < 1e-9)), band('tier 20%', f.filter((x) => Math.abs(x.tier - 0.2) < 1e-9)), band('tier 30% (all levers)', f.filter((x) => Math.abs(x.tier - 0.3) < 1e-9)),
    band('ask under 50¢ (Polymarket still against it)', f.filter((x) => x.ask < 0.5)), band('ask 50–70¢', f.filter((x) => x.ask >= 0.5)),
    band(`60–150 s left`, f.filter((x) => x.T >= 60)), band(`under 60 s left`, f.filter((x) => x.T < 60)), '');
  // a few long shots that won at 2–20¢ can carry the average, so the result by price is what matters
  L.push('| Price paid (all days, filled) | Bets | Won | Per $1 |', '|---|---|---|---|');
  for (const [lo, hi] of [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1]]) { const a = f.filter((x) => x.px >= lo && x.px < hi); if (a.length) L.push(band(`${Math.round(lo * 100)}–${Math.round(hi * 100)}¢`, a).replace(/^\| /, '| ')); }
  const r = f.map((x) => ret(x.px, x.win)).sort((a, b) => b - a), top = r.slice(0, 10).reduce((a, b) => a + b, 0), tot = r.reduce((a, b) => a + b, 0);
  L.push('', `The 10 best bets add ${top >= 0 ? '+' : ''}${top.toFixed(2)} to a total of ${tot >= 0 ? '+' : ''}${tot.toFixed(2)} on $1 bets; the other ${Math.max(0, r.length - 10)} add ${(tot - top).toFixed(2)}.`, '');
  L.push('| Bet size (all days, in time order) | Balance at the end (×start) | Worst drop from a peak | 30 days by bootstrap: 10th pct / median / 90th pct | Chance of losing 75%+ in 30 days |', '|---|---|---|---|---|');
  for (const [lab, s] of [['flat 2%', 0.02], ['flat 10%', 0.10], ['flat 20%', 0.20], ['flat 30%', 0.30], ['tiered 10–30%', 'tier']]) {
    const b = bankroll(all, s), bs = bootstrap(all, s, 30);
    L.push(`| ${lab} | ${b.end.toFixed(2)}× | ${pct(b.dd)} | ${bs ? `${bs.p10.toFixed(2)}× / ${bs.med.toFixed(2)}× / ${bs.p90.toFixed(2)}× (${bs.N} bets)` : '—'} | ${bs ? pct(bs.ruin) : '—'} |`);
  }
  L.push('');
};
L.push('## The strategy as described, no tuning', '', 'Settings picked from the description before looking at results: the TradingView candle\'s open, 30–150 s left, a flip within the last 30 s, at least $20 from the open, Polymarket under 70¢ for that side, 1¢ of room on the order.', '');
show('As described', AS_DESCRIBED);

const res = GRID.map((c) => ({ c, si: stats(trades(c, 'in')) })).filter((x) => x.si.n >= MIN_BETS).sort((a, b) => b.si.r - a.si.r);
L.push('## Best settings on the first week, scored on the second', '', `Top 10 in-sample by return per $1 (at least ${MIN_BETS} filled bets in-sample), each with its out-of-sample result.`, '', '| Settings | In: bets, won, per $1 | Out: bets, won, per $1 |', '|---|---|---|');
for (const x of res.slice(0, 10)) { const so = stats(trades(x.c, 'out')); L.push(`| ${name(x.c)} | ${x.si.n}, ${pct(x.si.w / x.si.n)}, ${sgn(x.si.r)} | ${so.n}, ${pct(so.n ? so.w / so.n : null)}, ${sgn(so.r)} |`); }
L.push('');
if (res.length) show('The best in-sample setting, in full', res[0].c);
const outAll = GRID.map((c) => stats(trades(c, 'out'))).filter((s) => s.n >= MIN_BETS);
L.push('## How often any setting made money out-of-sample', '', `${outAll.filter((s) => s.r > 0).length} of ${outAll.length} settings with at least ${MIN_BETS} out-of-sample bets had a positive return per $1 (median ${sgn(outAll.map((s) => s.r).sort((a, b) => a - b)[Math.floor(outAll.length / 2)])}).`, '');
L.push('## Notes', '',
  '- "TradingView" here is Coinbase spot, recorded once a second. If your chart is another exchange (Binance, Bitstamp), its price can sit a few dollars away.',
  '- The candle open is the first Coinbase price the bot recorded in the window, usually 5–10 s after it opened; Polymarket settles on the BRTI index against its own price to beat, about $12 away on average, which is why both are tested.',
  '- A fill is the next recorded second\'s ask. You clicking by hand is slower than that, so real fills would be later and often worse.',
  '- The recorder runs only while polymarket.com prices flow, which covers contested windows like these.',
  '- Chance of losing 75%+: share of 4,000 simulated 30-day runs, drawing bets at random from these results at the same pace, that ended below a quarter of the starting balance.');
const report = L.join('\n');
if (OUT) writeFileSync(OUT, report + '\n');
console.log(report);

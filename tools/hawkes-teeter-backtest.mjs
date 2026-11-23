#!/usr/bin/env node
// Hawkes teeter-totter: offline backtest on the bot's 1-second Polymarket US recordings. Reads files only; trades
// nothing, changes nothing, touches no live code.
//
// The live teeter-totter (Nov 22 rules) buys the side whose price makes a fresh cross into 85% with 30–5 s left,
// if the leader flipped 2+ times between 60 and 30 s left, the price seen is 92¢ or less, with an order limit of 94¢.
// Here the "2+ flips in a fixed 30 s box" is replaced by a flip intensity with exponential decay (a Hawkes-style
// self-exciting count): every flip of the leader (mid >= 53% / <= 47%, 47–53 ignored) anywhere in the window adds 1,
// and each one fades with half-life h:  I_h(t) = Σ exp(-ln2 · (t - t_i) / h)  over flips t_i <= t.
// High I means the book is still churning; I that was high and is fading means the contest is settling.
//
// Rules compared (everything else as live: fresh cross into 85%, trigger <= 92¢, limit 94¢, next-second fill):
//   none        no flip condition at all (any fresh cross)
//   current     the live rule: 2+ flips between 60 and 30 s left
//   flips >= k  k+ flips anywhere in the window so far, no decay
//   hawkes      lo <= I_h(trigger) < hi, for half-lives h and bands [lo, hi)
// Returns per $1 staked include the Polymarket taker fee 0.095·p·(1-p). Days in order: the first half picks the
// parameters (in-sample), the second half is only scored (out-of-sample).
//
// usage: node tools/hawkes-teeter-backtest.mjs --lag DIR[,DIR...] --log FILE@start=YYYY-MM-DD [--log FILE@end=YYYY-MM-DD]
//          [--min-fills 20] [--out report.md]

import { writeFileSync } from 'node:fs';
import { loadWindows, fee } from './recordings.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const lagDirs = (opt('--lag', '') || '').split(',').filter(Boolean), logs = opts('--log');
const MIN_FILLS = +opt('--min-fills', 20), OUT = opt('--out', null);
if (!lagDirs.length || !logs.length) { console.error('usage: --lag DIR[,DIR] --log FILE@start=YYYY-MM-DD|@end=YYYY-MM-DD ...'); process.exit(1); }

const TH = 0.85, TRIG_CAP = 0.92, LIMIT = 0.94, HALF = [5, 10, 20, 40, 80];
const { windows, days, ticksIn, ticksOut } = loadWindows({ lagDirs, logs });
const IS_DAYS = new Set(days.slice(0, Math.floor(days.length / 2)));
const mid = (r) => (r.bid + r.ask) / 2;
const leader = (m) => (m >= 0.53 ? 1 : m <= 0.47 ? 0 : null);

// ---------- per window: flips, and every fresh cross into 85% in the last 30–5 s
for (const w of windows) {
  const flips = []; let lead = null;
  for (const r of w.rows) { const l = leader(mid(r)); if (l != null) { if (lead != null && l !== lead) flips.push(r.e); lead = l; } }
  let f60 = 0; lead = null;   // the live count: leader state starts fresh at 60 s left
  for (const r of w.rows) { if (r.e < 240 || r.e > 270) continue; const l = leader(mid(r)); if (l != null) { if (lead != null && l !== lead) f60++; lead = l; } }
  w.cands = [];
  for (let i = 1; i < w.rows.length; i++) {
    const r = w.rows[i], p = w.rows[i - 1];
    if (r.e < 270 || r.e > 295 || r.e - p.e > 5) continue;
    const m = mid(r), up = m >= 0.5, sm = up ? m : 1 - m, pm = up ? mid(p) : 1 - mid(p);
    if (!(sm >= TH && pm < TH)) continue;
    const ask = up ? r.ask : 1 - r.bid, n = w.rows[i + 1];
    const nAsk = n && n.e - r.e <= 2 ? (up ? n.ask : 1 - n.bid) : null;
    const past = flips.filter((t) => t <= r.e);
    const I = {}; for (const h of HALF) I[h] = past.reduce((s, t) => s + Math.exp(-Math.LN2 * (r.e - t) / h), 0);
    w.cands.push({ e: r.e, ask, nAsk, win: (up ? 1 : 0) === w.won ? 1 : 0, f60, fAll: past.length, I });
  }
}

// ---------- one rule over one sample
const ret = (px, win) => { const c = px + fee(px); return win ? 1 / c - 1 : -1; };
function run(cond, inSample) {
  const o = { trig: 0, capped: 0, orders: 0, tret: 0, tw: 0, fills: 0, w: 0, px: 0, r: 0, knife: 0 };
  for (const w of windows) {
    if (IS_DAYS.has(w.day) !== inSample) continue;
    const c = w.cands.find(cond); if (!c) continue;
    o.trig++;
    if (c.ask > TRIG_CAP + 1e-9 || c.ask >= 0.99) { o.capped++; continue; }
    o.orders++; o.tret += ret(c.ask, c.win); o.tw += c.win;
    if (c.nAsk == null || c.nAsk > LIMIT + 1e-9) continue;
    o.fills++; o.w += c.win; o.px += c.nAsk; o.r += ret(c.nAsk, c.win);
    if (c.nAsk < c.ask - 0.015) o.knife++;
  }
  return o;
}
const RULES = [
  { name: 'none (no flip condition)', cond: () => true },
  { name: 'current: 2+ flips, 60–30 s left', cond: (c) => c.f60 >= 2 },
  ...[1, 2, 3, 4].map((k) => ({ name: `${k}+ flips anywhere, no decay`, cond: (c) => c.fAll >= k })),
];
const LO = [0, 0.25, 0.5, 1, 2], HI = [0.5, 1, 2, 3, Infinity];
for (const h of HALF) for (const lo of LO) for (const hi of HI) if (hi > lo && !(lo === 0 && hi === Infinity)) {
  RULES.push({ name: `hawkes h=${h}s, ${lo} <= I < ${hi === Infinity ? '∞' : hi}`, cond: (c) => c.I[h] >= lo && c.I[h] < hi, hawkes: true });
}
const res = RULES.map((r) => ({ ...r, is: run(r.cond, true), oos: run(r.cond, false) }));

// ---------- report
const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const sgn = (x) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const wilson = (w, n) => { if (!n) return '—'; const z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${((c - h) * 100).toFixed(0)}–${((c + h) * 100).toFixed(0)}%`; };
const line = (o) => `${o.trig} | ${o.orders} | ${o.fills} (${pct(o.orders ? o.fills / o.orders : null)}) | ${pct(o.fills ? o.w / o.fills : null)} (${wilson(o.w, o.fills)}) | ${o.fills ? (o.px / o.fills * 100).toFixed(1) + '¢' : '—'} | ${sgn(o.fills ? o.r / o.fills : null)} | ${o.r >= 0 ? '+' : ''}${o.r.toFixed(2)} | ${sgn(o.orders ? o.tret / o.orders : null)}`;
const HEAD = '| Rule | Sample | Triggers | Orders (≤92¢) | Filled | Won | Avg fill | Per $1 filled | Total, $1 bets | Per $1 at trigger price |\n|---|---|---|---|---|---|---|---|---|---|';
const L = [];
L.push('# Hawkes teeter-totter backtest', '', `Generated ${new Date().toISOString()}. Recordings: ${lagDirs.join(', ')}. Outcomes: ${logs.join(', ')}.`, '');
L.push(`- Windows with a recording and a known outcome: **${windows.length}** over ${days.length} days (${days[0]} to ${days.at(-1)}). Sanity guard dropped ${ticksOut} of ${ticksIn} ticks.`);
L.push(`- In-sample (picks parameters): ${[...IS_DAYS][0]} to ${[...IS_DAYS].at(-1)} · out-of-sample (scored only): ${days.find((d) => !IS_DAYS.has(d))} to ${days.at(-1)}.`);
L.push(`- Windows with a fresh cross into 85% in the last 30–5 s: ${windows.filter((w) => w.cands.length).length}.`);
L.push(`- Rules tried: ${RULES.length} (${RULES.filter((r) => r.hawkes).length} Hawkes bands). Fills: the next second's ask, if at or under the 94¢ limit.`, '');

L.push('## Baselines', '', HEAD);
for (const r of res.filter((x) => !x.hawkes)) { L.push(`| ${r.name} | in | ${line(r.is)} |`, `| ${r.name} | **out** | ${line(r.oos)} |`); }
L.push('');

const pool = res.filter((r) => r.hawkes && r.is.fills >= MIN_FILLS).sort((a, b) => b.is.r / b.is.fills - a.is.r / a.is.fills);
L.push('## Hawkes rules picked on in-sample, scored out-of-sample', '', `Best in-sample by return per $1 filled, among rules with at least ${MIN_FILLS} in-sample fills.`, '', HEAD);
for (const r of pool.slice(0, 10)) L.push(`| ${r.name} | in | ${line(r.is)} |`, `| ${r.name} | **out** | ${line(r.oos)} |`);
const cur = res[1];
if (pool.length) {
  const b = pool[0];
  L.push('', `Pick: **${b.name}**. Out-of-sample: ${b.oos.fills} fills, ${pct(b.oos.fills ? b.oos.w / b.oos.fills : null)} won, ${sgn(b.oos.fills ? b.oos.r / b.oos.fills : null)} per $1, total ${b.oos.r.toFixed(2)} on $1 bets; the current rule: ${cur.oos.fills} fills, ${pct(cur.oos.fills ? cur.oos.w / cur.oos.fills : null)} won, ${sgn(cur.oos.fills ? cur.oos.r / cur.oos.fills : null)}, total ${cur.oos.r.toFixed(2)}.`);
}
L.push('');

// does intensity separate? no search: every fresh cross at or under 92¢, bucketed by I at the moment of the cross
L.push('## Does flip intensity separate winners from reversals?', '', 'Every window\'s first fresh cross into 85% at or under 92¢ (no flip condition), grouped by flip intensity at that moment. Bucket edges are the in-sample thirds of the non-zero values, then applied unchanged out-of-sample. Results at the trigger price (unfilled included).', '');
const firsts = (inS) => windows.filter((w) => IS_DAYS.has(w.day) === inS).map((w) => w.cands[0]).filter((c) => c && c.ask <= TRIG_CAP + 1e-9 && c.ask < 0.99);
for (const h of [10, 20, 40]) {
  const nz = firsts(true).map((c) => c.I[h]).filter((x) => x > 1e-6).sort((a, b) => a - b);
  const q1 = nz[Math.floor(nz.length / 3)], q2 = nz[Math.floor(nz.length * 2 / 3)];
  const bands = [['no flips', (x) => x <= 1e-6], [`low (< ${q1.toFixed(2)})`, (x) => x > 1e-6 && x < q1], [`middle (${q1.toFixed(2)}–${q2.toFixed(2)})`, (x) => x >= q1 && x < q2], [`high (≥ ${q2.toFixed(2)})`, (x) => x >= q2]];
  L.push(`### Half-life ${h} s`, '', '| Intensity | In: crosses, won, per $1 | Out: crosses, won, per $1 |', '|---|---|---|');
  for (const [lab, f] of bands) {
    const cell = (inS) => { const a = firsts(inS).filter((c) => f(c.I[h])); const w = a.reduce((s, c) => s + c.win, 0); return `${a.length}, ${pct(a.length ? w / a.length : null)} (${wilson(w, a.length)}), ${sgn(a.length ? a.reduce((s, c) => s + ret(c.ask, c.win), 0) / a.length : null)}`; };
    L.push(`| ${lab} | ${cell(true)} | ${cell(false)} |`);
  }
  L.push('');
}
L.push('### The live count (flips between 60 and 30 s left), for comparison', '', '| Flips | In: crosses, won, per $1 | Out: crosses, won, per $1 |', '|---|---|---|');
for (const [lab, f] of [['0', (k) => k === 0], ['1', (k) => k === 1], ['2', (k) => k === 2], ['3+', (k) => k >= 3]]) {
  const cell = (inS) => { const a = firsts(inS).filter((c) => f(c.f60)); const w = a.reduce((s, c) => s + c.win, 0); return `${a.length}, ${pct(a.length ? w / a.length : null)} (${wilson(w, a.length)}), ${sgn(a.length ? a.reduce((s, c) => s + ret(c.ask, c.win), 0) / a.length : null)}`; };
  L.push(`| ${lab} | ${cell(true)} | ${cell(false)} |`);
}
L.push('', '## Notes', '',
  '- A fill is the next recorded second\'s ask; a real order arrives a fraction of a second after the trigger.',
  '- The recorder runs only while polymarket.com prices flow; contested windows, the ones this strategy trades, are recorded.',
  '- Per $1 filled is the average over filled bets of (won ? 1/(price + fee) − 1 : −1). Total is the sum, as if $1 went on each filled bet.',
  `- With ${RULES.length} rules tried, the best in-sample result is flattered by chance; only the out-of-sample rows count.`);
const report = L.join('\n');
if (OUT) writeFileSync(OUT, report + '\n');
console.log(report);

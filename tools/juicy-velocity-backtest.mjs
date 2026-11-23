#!/usr/bin/env node
// Juicy Velocity: offline backtest on the bot's 1-second Polymarket US recordings. Reads files only; trades nothing,
// changes nothing, touches no live code.
//
// Strategy under test (one Leg 1 attempt per 5-minute window):
//   Setup     a side (the favorite) has already reached > 81¢ (its mid) earlier in the window
//   Leg 1     with T = seconds left in [Tmin, 150], the favorite's ask pulls back into 72¢ < ask < 80¢
//             and the velocity filter passes -> buy, limit = ask + tolerance, filled at the next second's ask
//   Leg 2     only after Leg 1 filled: the favorite's ask recovers to 85–92¢ (T >= 5 s) -> buy the same stake again,
//             order limit 92¢ or 94¢, filled at the next second's ask
//   Filters   control: none
//             Mode A (odds velocity): v = (p(t-Δt) - p(t)) / Δt on the favorite's mid (+ = pulling back);
//                     require v > 0 (or >= 0), p(t) - v·T >= M, and optionally v <= a hard cap (1¢/s, 2¢/s)
//             Mode B (spot distance): D = distance of Coinbase spot from the window's open price on the favorite's
//                     side (negative = wrong side); v = (D(t-Δt) - D(t)) / Δt (+ = closing toward the open);
//                     require v > 0 (or >= 0) and D(t) - v·T > B
//   Returns   per $1 staked, Polymarket taker fee 0.095·p·(1-p) per share included
//
// Data
//   recordings  lag-YYYY-MM-DD.jsonl rows [ts, windowStart, elapsed, btc, comBid, comAsk, usBid, usAsk, latency, src]
//   outcomes    from the "price to beat <time> window: <price>" log lines: a window's open price is the previous
//               window's settlement, so Up won when the next window's price to beat is higher. A log has times of
//               day only, so each one comes with the date of its first line (@start=) or of its last (@end=).
//   sanity      ticks with a crossed or empty book, a spread over 10¢, or a one-second jump of 25¢+ that comes
//               straight back are dropped (the kind of tick behind the Nov 20 10¢ practice fill)
//   split       days in order: the first half picks parameters (in-sample), the second half is only scored (out-of-sample)
//
// usage: node tools/juicy-velocity-backtest.mjs --lag DIR[,DIR...] --log FILE@start=YYYY-MM-DD [--log FILE@end=YYYY-MM-DD]
//          [--min-trades 15] [--out report.md]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const LAG_DIRS = (opt('--lag', '') || '').split(',').filter(Boolean);
const LOGS = opts('--log');
const MIN_TRADES = +opt('--min-trades', 15);
const OUT = opt('--out', null);
if (!LAG_DIRS.length || !LOGS.length) { console.error('usage: --lag DIR[,DIR] --log FILE@start=YYYY-MM-DD|@end=YYYY-MM-DD ...'); process.exit(1); }

const fee = (p) => 0.095 * p * (1 - p);
const CT = 'America/Chicago';
const dayOf = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: CT });

// ---------- outcomes and open prices from the logs
function parseLog(spec) {
  const [file, anchor] = spec.split('@');
  const m = /^(start|end)=(\d{4})-(\d\d)-(\d\d)$/.exec(anchor || '');
  if (!m) throw new Error(`--log ${spec}: add @start=YYYY-MM-DD or @end=YYYY-MM-DD`);
  let lines = readFileSync(file, 'latin1').split('\n');
  const back = m[1] === 'end';
  if (back) lines = lines.reverse();
  let day = Date.UTC(+m[2], +m[3] - 1, +m[4]) / 1000, prev = back ? 1e9 : -1;
  const P = {};
  for (const l of lines) {
    const t = /^(\d\d):(\d\d):(\d\d) /.exec(l); if (!t) continue;
    const s = +t[1] * 3600 + +t[2] * 60 + +t[3];
    if (!back && s < prev - 3600) day += 86400;
    if (back && s > prev + 3600) day -= 86400;
    prev = s;
    const r = /price to beat (\d+):(\d\d) (AM|PM) window: ([0-9.]+)/.exec(l); if (!r) continue;
    const at = day + s, h = (+r[1] % 12) + (r[3] === 'PM' ? 12 : 0);
    let best = null;   // the window start, as UTC, whose Central label matches and is nearest the log time
    for (const off of [5, 6]) for (const dd of [-1, 0, 1]) {
      const Ws = day + dd * 86400 + (h + off) * 3600 + +r[2] * 60;
      if (new Date(Ws * 1000).toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ') !== `${+r[1]}:${r[2]} ${r[3]}`) continue;
      if (best == null || Math.abs(Ws - at) < Math.abs(best - at)) best = Ws;
    }
    if (best != null && Math.abs(best - at) < 3600) P[best] = +r[4];
  }
  return P;
}
const OPEN = {};
for (const spec of LOGS) Object.assign(OPEN, parseLog(spec));
const OUTCOME = {};
for (const [Ws, p] of Object.entries(OPEN)) { const n = OPEN[+Ws + 300]; if (n != null && n !== p) OUTCOME[Ws] = n > p ? 1 : 0; }

// ---------- recordings, with the sanity guard
const raw = {};
for (const dir of LAG_DIRS) for (const f of readdirSync(dir).filter((x) => /^lag-.*\.jsonl$/.test(x)).sort()) {
  for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
    const [, Ws, e, btc, , , bid, ask] = r;
    const w = raw[Ws] || (raw[Ws] = new Map());
    if (!w.has(e)) w.set(e, { e, S: btc, bid, ask });
  }
}
let ticksIn = 0, ticksOut = 0;
const valid = (r) => Number.isFinite(r.bid) && Number.isFinite(r.ask) && r.bid > 0 && r.ask < 1 && r.bid <= r.ask && r.ask - r.bid <= 0.10 && Number.isFinite(r.S) && r.S > 0;
const WINDOWS = [];
for (const [Ws, m] of Object.entries(raw)) {
  if (OUTCOME[Ws] == null) continue;
  const all = [...m.values()].sort((a, b) => a.e - b.e);
  ticksIn += all.length;
  let rows = all.filter(valid);
  rows = rows.filter((r, i) => {   // one-second spikes of 25¢+ that come straight back
    const p = rows[i - 1], n = rows[i + 1]; if (!p || !n) return true;
    const mid = (x) => (x.bid + x.ask) / 2;
    return !(Math.abs(mid(r) - mid(p)) >= 0.25 && Math.abs(mid(n) - mid(p)) <= 0.05);
  });
  ticksOut += all.length - rows.length;
  if (rows.length < 30) continue;
  WINDOWS.push({ Ws: +Ws, day: dayOf(+Ws), K: OPEN[Ws], won: OUTCOME[Ws], rows });
}
WINDOWS.sort((a, b) => a.Ws - b.Ws);
const DAYS = [...new Set(WINDOWS.map((w) => w.day))].sort();
const IS_DAYS = new Set(DAYS.slice(0, Math.floor(DAYS.length / 2)));

// ---------- per-window precomputation: Leg 1 candidates and what follows them
const SIDES = [
  { up: 1, ask: (r) => r.ask, mid: (r) => (r.bid + r.ask) / 2, D: (r, K) => r.S - K },
  { up: 0, ask: (r) => 1 - r.bid, mid: (r) => 1 - (r.bid + r.ask) / 2, D: (r, K) => K - r.S },
];
const DTS = [5, 10, 15, 30];
const at = (rows, i, e) => { // the reading closest to elapsed time e at or before row i (within 2 s), or null
  for (let j = i; j >= 0; j--) { if (rows[j].e <= e) return e - rows[j].e <= 2 ? rows[j] : null; }
  return null;
};
for (const w of WINDOWS) {
  w.cands = [];
  const peaked = [false, false];
  for (let i = 0; i < w.rows.length; i++) {
    const r = w.rows[i], T = 300 - r.e;
    for (let s = 0; s < 2; s++) {
      const S = SIDES[s], a = S.ask(r);
      if (peaked[s] && T <= 150 && T >= 15 && a > 0.72 && a < 0.80) {
        const v = {};
        for (const dt of DTS) {
          const p = at(w.rows, i, r.e - dt);
          v[dt] = p ? { vp: (S.mid(p) - S.mid(r)) / dt, vS: w.K != null ? (S.D(p, w.K) - S.D(r, w.K)) / dt : null } : null;
        }
        w.cands.push({ i, s, T, ask: a, mid: S.mid(r), D: w.K != null ? S.D(r, w.K) : null, v, win: (S.up === w.won) ? 1 : 0 });
      }
    }
    for (let s = 0; s < 2; s++) if (SIDES[s].mid(r) > 0.81) peaked[s] = true;   // counts for the next readings
  }
}

// ---------- filters
function passes(c, f) {
  if (f.kind === 'none') return true;
  const v = c.v[f.dt]; if (!v) return false;
  if (f.kind === 'A') {
    const x = v.vp;
    if (f.vmin === '>0' ? !(x > 0) : !(x >= 0)) return false;
    if (f.vcap != null && x > f.vcap) return false;
    return c.mid - x * c.T >= f.M;
  }
  const x = v.vS; if (x == null || c.D == null) return false;
  if (f.vmin === '>0' ? !(x > 0) : !(x >= 0)) return false;
  return c.D - x * c.T > f.B;
}
const fname = (f) => f.kind === 'none' ? 'control (no velocity filter)'
  : f.kind === 'A' ? `A odds Δt=${f.dt}s v${f.vmin} M=${Math.round(f.M * 100)}¢${f.vcap != null ? ` cap ${Math.round(f.vcap * 100)}¢/s` : ''}`
  : `B spot Δt=${f.dt}s v${f.vmin} B=$${f.B}`;

// ---------- one configuration over a set of windows
function leg(px, win) { const c = px + fee(px); return win ? 1 / c - 1 : -1; }
function run(cfg, inSample) {
  const L1 = [], L2 = [], C = [];
  let tries = 0, missed = 0, knife = 0, l2Tries = 0, l2Missed = 0;
  for (const w of WINDOWS) {
    if (IS_DAYS.has(w.day) !== inSample) continue;
    const c = w.cands.find((x) => x.T >= cfg.tmin && passes(x, cfg.f));
    if (!c) continue;
    tries++;
    const S = SIDES[c.s], next = w.rows[c.i + 1];
    const nAsk = next && next.e - w.rows[c.i].e <= 2 ? S.ask(next) : null;
    if (nAsk == null || nAsk > c.ask + cfg.tol + 1e-9) { missed++; continue; }
    if (nAsk < c.ask - 0.015) knife++;
    const r1 = leg(nAsk, c.win);
    L1.push({ px: nAsk, r: r1, win: c.win });
    let r2 = null;
    for (let k = c.i + 2; k < w.rows.length; k++) {
      const x = w.rows[k], a = S.ask(x);
      if (300 - x.e < 5) break;
      if (a >= 0.85 && a <= 0.92) {
        l2Tries++;
        const n2 = w.rows[k + 1], a2 = n2 && n2.e - x.e <= 2 ? S.ask(n2) : null;
        if (a2 == null || a2 > cfg.l2lim + 1e-9) { l2Missed++; break; }
        r2 = leg(a2, c.win); L2.push({ px: a2, r: r2, win: c.win });
        break;
      }
    }
    C.push({ stake: r2 == null ? 1 : 2, pnl: r1 + (r2 ?? 0), win: c.win });
  }
  const sum = (a) => ({ n: a.length, w: a.filter((x) => x.win).length, px: a.length ? a.reduce((s, x) => s + x.px, 0) / a.length : null, ret: a.length ? a.reduce((s, x) => s + x.r, 0) / a.length : null });
  const st = C.reduce((s, x) => s + x.stake, 0);
  return { leg1: sum(L1), leg2: sum(L2), comb: { n: C.length, w: C.filter((x) => x.win).length, ret: st ? C.reduce((s, x) => s + x.pnl, 0) / st : null, stake: st, pnl: C.reduce((s, x) => s + x.pnl, 0) },
    tries, missed, knife, l2Tries, l2Missed };
}

// ---------- the grid
const FILTERS = [{ kind: 'none' }];
for (const dt of DTS) for (const vmin of ['>0', '>=0']) {
  for (const M of [0.50, 0.55, 0.60]) for (const vcap of [null, 0.01, 0.02]) FILTERS.push({ kind: 'A', dt, vmin, M, vcap });
  for (const B of [0, 15, 25]) FILTERS.push({ kind: 'B', dt, vmin, B });
}
const CONFIGS = [];
for (const f of FILTERS) for (const tmin of [15, 30]) for (const tol of [0, 0.01, 0.02]) for (const l2lim of [0.92, 0.94]) CONFIGS.push({ f, tmin, tol, l2lim });
const results = CONFIGS.map((cfg) => ({ cfg, is: run(cfg, true), oos: run(cfg, false) }));

// ---------- report
const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const sgn = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const cents = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '¢');
const wilson = (w, n) => { if (!n) return '—'; const z = 1.96, p = w / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return `${((c - h) * 100).toFixed(0)}–${((c + h) * 100).toFixed(0)}%`; };
const breakeven = (px) => (px == null ? null : px + fee(px));
const exec = (c) => `Tmin ${c.tmin}s, +${Math.round(c.tol * 100)}¢ tol, Leg 2 limit ${Math.round(c.l2lim * 100)}¢`;
const legRows = (label, r) => [
  `| ${label} | Leg 1 | ${r.leg1.n} | ${pct(r.leg1.n ? r.leg1.w / r.leg1.n : null)} (${wilson(r.leg1.w, r.leg1.n)}) | ${cents(r.leg1.px)} | ${pct(breakeven(r.leg1.px))} | ${sgn(r.leg1.ret)} |`,
  `| ${label} | Leg 2 | ${r.leg2.n} | ${pct(r.leg2.n ? r.leg2.w / r.leg2.n : null)} (${wilson(r.leg2.w, r.leg2.n)}) | ${cents(r.leg2.px)} | ${pct(breakeven(r.leg2.px))} | ${sgn(r.leg2.ret)} |`,
  `| ${label} | Combined | ${r.comb.n} windows, $${r.comb.stake} staked | ${pct(r.comb.n ? r.comb.w / r.comb.n : null)} | — | — | ${sgn(r.comb.ret)} |`,
];
const HEAD = '| Sample | Leg | Bets | Won (95% range) | Avg fill | Break-even | Per $1 |\n|---|---|---|---|---|---|---|';
const L = [];
L.push('# Juicy Velocity backtest', '');
L.push(`Generated ${new Date().toISOString()}. Recordings: ${LAG_DIRS.join(', ')}. Outcomes: ${LOGS.join(', ')}.`, '');
L.push(`- Windows with a recording and a known outcome: **${WINDOWS.length}** over ${DAYS.length} days (${DAYS[0]} to ${DAYS[DAYS.length - 1]}).`);
L.push(`- In-sample (picks parameters): ${[...IS_DAYS][0]} to ${[...IS_DAYS].at(-1)} · out-of-sample (scored only): ${DAYS.find((d) => !IS_DAYS.has(d))} to ${DAYS.at(-1)}.`);
L.push(`- Sanity guard dropped ${ticksOut} of ${ticksIn} ticks (${(ticksOut / ticksIn * 100).toFixed(2)}%).`);
L.push(`- Windows with at least one Leg 1 setup (favorite peaked > 81¢, then ask in 72–80¢ with 15–150 s left): ${WINDOWS.filter((w) => w.cands.length).length}.`);
L.push(`- Configurations tried: ${CONFIGS.length} (${FILTERS.length} filters × 2 floors × 3 tolerances × 2 Leg 2 limits). With this many tries the best in-sample result is flattered by chance; only the out-of-sample rows count.`, '');

const ctrl = results.filter((r) => r.cfg.f.kind === 'none');
L.push('## Control: the same pullback with no velocity filter', '', '| Execution | Sample | Leg 1 tries | Missed | Falling-knife fills | Leg 1 won | Leg 1 per $1 | Leg 2 n | Leg 2 per $1 | Combined per $1 |', '|---|---|---|---|---|---|---|---|---|---|');
for (const r of ctrl) for (const [lab, x] of [['in', r.is], ['out', r.oos]]) {
  L.push(`| ${exec(r.cfg)} | ${lab} | ${x.tries} | ${x.missed} | ${x.knife} | ${pct(x.leg1.n ? x.leg1.w / x.leg1.n : null)} of ${x.leg1.n} | ${sgn(x.leg1.ret)} | ${x.leg2.n} | ${sgn(x.leg2.ret)} | ${sgn(x.comb.ret)} |`);
}
L.push('', 'Falling-knife fill: filled 2¢+ below the trigger price because the ask kept dropping. Missed: the next second\'s ask was above the limit (it bounced), or there was no next reading.', '');

function best(kind, key) {
  const pool = results.filter((r) => (kind ? r.cfg.f.kind === kind : r.cfg.f.kind !== 'none') && r.is[key].n >= MIN_TRADES && r.is[key].ret != null);
  pool.sort((a, b) => b.is[key].ret - a.is[key].ret);
  return pool;
}
function section(title, r) {
  const c = ctrl.find((x) => x.cfg.tmin === r.cfg.tmin && x.cfg.tol === r.cfg.tol && x.cfg.l2lim === r.cfg.l2lim);
  L.push(`### ${title}`, '', `Filter: **${fname(r.cfg.f)}** · ${exec(r.cfg)}`, '', HEAD);
  L.push(...legRows('in-sample', r.is), ...legRows('**out-of-sample**', r.oos), ...legRows('control, out-of-sample', c.oos), '');
  // does the filter separate reversals from safe dips? same setups, split by the filter
  for (const [lab, inS] of [['in-sample', true], ['out-of-sample', false]]) {
    let pw = 0, pn = 0, rw = 0, rn = 0;
    for (const w of WINDOWS) {
      if (IS_DAYS.has(w.day) !== inS) continue;
      const cc = w.cands.find((x) => x.T >= r.cfg.tmin); if (!cc) continue;
      const pass = w.cands.find((x) => x.T >= r.cfg.tmin && passes(x, r.cfg.f));
      if (pass) { pn++; pw += pass.win; } else { rn++; rw += cc.win; }
    }
    L.push(`- Separation, ${lab}: windows the filter let through won ${pct(pn ? pw / pn : null)} (${pw}/${pn}); windows it turned away won ${pct(rn ? rw / rn : null)} (${rw}/${rn}).`);
  }
  L.push('');
}
L.push('## Picked on in-sample, scored out-of-sample', '');
L.push(`Each pick is the in-sample best by its measure among configurations with at least ${MIN_TRADES} in-sample bets.`, '');
for (const [title, kind, key] of [['Best Mode A (odds velocity), by Leg 1', 'A', 'leg1'], ['Best Mode B (spot distance), by Leg 1', 'B', 'leg1'], ['Best of either mode, by combined (Leg 1 + Leg 2)', null, 'comb']]) {
  const p = best(kind, key);
  if (!p.length) { L.push(`### ${title}`, '', `No configuration reached ${MIN_TRADES} in-sample bets.`, ''); continue; }
  section(title, p[0]);
}
L.push('## Top 10 in-sample (Leg 1), and how each did out-of-sample', '', '| Filter | Execution | In: bets, won, per $1 | Out: bets, won, per $1 |', '|---|---|---|---|');
for (const r of best(null, 'leg1').slice(0, 10)) L.push(`| ${fname(r.cfg.f)} | ${exec(r.cfg)} | ${r.is.leg1.n}, ${pct(r.is.leg1.w / r.is.leg1.n)}, ${sgn(r.is.leg1.ret)} | ${r.oos.leg1.n}, ${pct(r.oos.leg1.n ? r.oos.leg1.w / r.oos.leg1.n : null)}, ${sgn(r.oos.leg1.ret)} |`);
L.push('', '## Notes', '',
  '- Fills use the next recorded second\'s ask. A real order arrives a fraction of a second after the trigger, so fills here are a rough stand-in.',
  '- The recorder only runs while polymarket.com prices are flowing, which stops once a window is clearly decided; windows that pull back into 72–80¢ are active, so they are recorded.',
  '- Mode B uses Coinbase spot against the window\'s open (the BRTI price to beat); the settlement index can differ from Coinbase by about $12, which the buffer B is for.',
  '- A result per $1 is the average over bets of (won ? 1/(price + fee) − 1 : −1). Combined is total P&L over total stake, counting Leg 2 as a second equal stake.');
const report = L.join('\n');
if (OUT) writeFileSync(OUT, report + '\n');
console.log(report);

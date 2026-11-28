// TV Divergence regime check (offline, diagnostic only; never touches the live bot).
//
// Replays the live TV Divergence rule (v2, as in autopilot.mjs observeTvd) over the bot's 1-second recordings and
// breaks the triggers down by BTC volatility, session and day type, then shows, day by day, how Polymarket US was
// pricing the moments when the Coinbase condition was met: the "is the gap closing?" check.
//
//   rule      30–150 s left; Coinbase spot ≥ $35 past the price to beat K on side X for 3 readings in a row; on the
//             other side of K within the 60 s before that hold began; ask for X 50–70¢; latest price not unchanged for
//             10 s (the v2 frozen-feed guard); one trigger per window. Fill: the next reading (≤ 2 s later) has X's
//             ask at most 1¢ over the trigger ask, at that next ask (the forward tracker's fill1).
//   fee       Polymarket US bills API fills at 0.0695 × p × (1 − p) per share (confirmed on the first 7 live fills).
//   outcome   from the "price to beat" log lines (tools/recordings.mjs).
//   vol       Coinbase 1-minute candles: the high-low range of the 30 minutes before the window opens, and the
//             standard deviation of 1-minute returns over the hour before it (in basis points).
//   hold event  the first reading in a window where the Coinbase part of the rule is met (hold + cross, 30–150 s
//             left), whatever Polymarket's ask was then: the denominator for the daily "already priced" check.
//
// Usage (on the Pi, where the recordings are):
//   node tvd-regime-check.mjs --lag DIR [--lag DIR] --log FILE@start=YYYY-MM-DD [--log …] --candles cb1m.json
//        [--fetch-candles] [--json out.json]
// --fetch-candles fills cb1m.json from Coinbase's public candle API for the recorded days (cached; run once).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadWindows } from './recordings.mjs';

const args = process.argv.slice(2), opt = { lag: [], log: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--lag') opt.lag.push(args[++i]); else if (a === '--log') opt.log.push(args[++i]);
  else if (a === '--candles') opt.candles = args[++i]; else if (a === '--json') opt.json = args[++i];
  else if (a === '--fetch-candles') opt.fetch = true; else if (a === '--fee') opt.fee = +args[++i];
}
const FEE = opt.fee || 0.0695, CT = 'America/Chicago';
const RULE = { minLeft: 30, maxLeft: 150, B: 35, hold: 3, look: 60, cap: 0.70, floor: 0.50, flatSec: 10, tick: 0.01 };
const HOLIDAYS = new Set(['2026-11-26', '2026-11-27']);   // Thanksgiving, Black Friday

const { windows } = loadWindows({ lagDirs: opt.lag, logs: opt.log });
const ctDay = (s) => new Date(s * 1000).toLocaleDateString('en-CA', { timeZone: CT });
const ctHour = (s) => +new Date(s * 1000).toLocaleString('en-US', { timeZone: CT, hour: 'numeric', hourCycle: 'h23' });
const ctWeekday = (s) => new Date(s * 1000).toLocaleDateString('en-US', { timeZone: CT, weekday: 'short' });

// ---------- Coinbase 1-minute candles
let candles = opt.candles && existsSync(opt.candles) ? JSON.parse(readFileSync(opt.candles, 'utf8')) : {};
if (opt.fetch) {
  const lo = Math.floor((windows[0].Ws - 7200) / 60) * 60, hi = windows[windows.length - 1].Ws + 300;
  for (let t = lo; t < hi; t += 300 * 60) {
    if (candles[t] && candles[t + 299 * 60]) continue;
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(t * 1000).toISOString()}&end=${new Date((t + 299 * 60) * 1000).toISOString()}`;
    for (let k = 0; k < 5; k++) {
      const r = await fetch(url, { headers: { 'User-Agent': 'tvd-regime-check' } });
      if (r.status === 429) { await new Promise((z) => setTimeout(z, 2000)); continue; }
      if (!r.ok) throw new Error(`candles HTTP ${r.status}`);
      for (const [ts, low, high, , close] of await r.json()) candles[ts] = [low, high, close];
      break;
    }
    await new Promise((z) => setTimeout(z, 350));
  }
  writeFileSync(opt.candles, JSON.stringify(candles));
}
function vol(Ws) {   // [30-min high-low range $, 60-min std of 1-min returns (bp)] before the window opens
  let lo = Infinity, hi = -Infinity, n30 = 0; const cl = [];
  for (let t = Ws - 3600; t < Ws; t += 60) {
    const c = candles[t]; if (!c) continue;
    if (t >= Ws - 1800) { lo = Math.min(lo, c[0]); hi = Math.max(hi, c[1]); n30++; }
    cl.push(c[2]);
  }
  const rets = []; for (let i = 1; i < cl.length; i++) rets.push(Math.log(cl[i] / cl[i - 1]) * 1e4);
  const m = rets.reduce((a, x) => a + x, 0) / (rets.length || 1);
  const sd = rets.length >= 30 ? Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1)) : null;
  return [n30 >= 20 ? hi - lo : null, sd];
}

// ---------- replay the rule
const trig = [], holds = [], perDay = {};
for (const w of windows) {
  if (w.K == null) continue;
  const day = ctDay(w.Ws), D = perDay[day] || (perDay[day] = { windows: 0, ranges: [] });
  D.windows++;
  const [range30, sd60] = vol(w.Ws); if (range30 != null) D.ranges.push(range30);
  const hist = []; let hold = 0, side = 0, hs = null, px = null, pxE = null, held = false;
  for (let i = 0; i < w.rows.length; i++) {
    const r = w.rows[i], d = r.S - w.K, T = 300 - r.e;
    if (r.S !== px) { px = r.S; pxE = r.e; }
    hist.push({ e: r.e, d }); while (hist.length && hist[0].e < r.e - 90) hist.shift();
    if (T > RULE.maxLeft) { hold = 0; side = 0; continue; }
    const s = d >= RULE.B ? 1 : d <= -RULE.B ? -1 : 0;
    if (s && s === side) hold++; else { hold = s ? 1 : 0; side = s; hs = r.e; }
    if (T < RULE.minLeft || !s || hold < RULE.hold) continue;
    if (!hist.some((h) => h.e < hs && hs - h.e <= RULE.look && (s > 0 ? h.d < 0 : h.d > 0))) continue;
    const ask = s > 0 ? r.ask : 1 - r.bid;
    if (!held) { held = true; holds.push({ Ws: w.Ws, day, ask, dist: Math.abs(d), left: T }); }
    if (!(ask <= RULE.cap + 1e-9) || ask <= 0.02) continue;
    if (ask < RULE.floor - 1e-9 || r.e - pxE >= RULE.flatSec) continue;
    const n = w.rows[i + 1], nAsk = n && n.e - r.e <= 2 ? (s > 0 ? n.ask : 1 - n.bid) : null;
    const filled = nAsk != null && nAsk <= ask + RULE.tick + 1e-9;
    trig.push({ Ws: w.Ws, day, hour: ctHour(w.Ws), wd: ctWeekday(w.Ws), ask, dist: Math.abs(d), left: T, filled, px: filled ? nAsk : null,
      won: (s > 0 ? 1 : 0) === w.won ? 1 : 0, range30, sd60 });
    break;
  }
}

// ---------- tables
const pct = (x) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(1) + '%');
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function wilson(k, n) { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - h) / d, (c + h) / d]; }
function stats(T) {
  const F = T.filter((t) => t.filled), w = F.filter((t) => t.won).length;
  const cost = (t) => t.px + FEE * t.px * (1 - t.px);
  const be = F.length ? F.reduce((a, t) => a + cost(t), 0) / F.length : null;
  const ret = F.length ? F.reduce((a, t) => a + (t.won ? 1 / cost(t) - 1 : -1), 0) / F.length : null;
  const [lo, hi] = wilson(w, F.length);
  return { n: T.length, f: F.length, fill: T.length ? F.length / T.length : null, w, win: F.length ? w / F.length : null, lo, hi, be, ret,
    winAll: T.length ? T.filter((t) => t.won).length / T.length : null };
}
const row = (label, T) => { const s = stats(T); return `| ${label} | ${s.n} | ${pct(s.fill)} | ${s.f ? `${s.w}/${s.f} = ${pct(s.win)} (${pct(s.lo)}–${pct(s.hi)})` : '—'} | ${pct(s.be)} | ${s.ret == null ? '—' : (s.ret >= 0 ? '+' : '') + (s.ret * 100).toFixed(1) + '%'} | ${pct(s.winAll)} |`; };
const HEAD = '| Bucket | Triggers | +1¢ fill rate | Won when filled (95% range) | Break-even | Return per $1 | Won, all triggers |\n|---|---|---|---|---|---|---|';
const out = [];
const days = Object.keys(perDay).sort();
out.push(`# TV Divergence regime check\n\nRecorded days ${days[0]} to ${days[days.length - 1]} (CT) · ${windows.filter((w) => w.K != null).length} windows with an outcome · ${trig.length} triggers · fee ${FEE} × p(1−p)\n`);
out.push(`## All triggers\n\n${HEAD}\n${row('All', trig)}\n`);

function tertiles(key, label, unit) {
  const T = trig.filter((t) => t[key] != null), v = T.map((t) => t[key]).sort((a, b) => a - b);
  const c1 = v[Math.floor(v.length / 3)], c2 = v[Math.floor(2 * v.length / 3)], f = (x) => unit === '$' ? '$' + Math.round(x) : x.toFixed(1) + ' bp';
  return `## By ${label}\n\nTertiles of the triggers (${T.length} with candle data). Cutoffs ${f(c1)} and ${f(c2)}.\n\n${HEAD}\n`
    + row(`Low (< ${f(c1)})`, T.filter((t) => t[key] < c1)) + '\n' + row(`Medium (${f(c1)}–${f(c2)})`, T.filter((t) => t[key] >= c1 && t[key] < c2)) + '\n'
    + row(`High (≥ ${f(c2)})`, T.filter((t) => t[key] >= c2)) + '\n';
}
out.push(tertiles('range30', 'volatility: 30-minute BTC high-low range before the window', '$'));
out.push(tertiles('sd60', 'volatility: 1-hour std of 1-minute returns before the window (check on the first)', 'bp'));
const wkend = (t) => t.wd === 'Sat' || t.wd === 'Sun' || HOLIDAYS.has(t.day);
const dayT = (t) => t.hour >= 8 && t.hour < 16;
out.push(`## By session and day type\n\nUS daytime = 8 AM–4 PM CT. Weekend/holiday = Sat, Sun, Thanksgiving (Nov 26), Black Friday (Nov 27).\n\n${HEAD}\n`
  + [row('US daytime', trig.filter(dayT)), row('Overnight', trig.filter((t) => !dayT(t))), row('Weekday', trig.filter((t) => !wkend(t))), row('Weekend/holiday', trig.filter(wkend)),
    row('Weekday daytime', trig.filter((t) => !wkend(t) && dayT(t))), row('Weekday overnight', trig.filter((t) => !wkend(t) && !dayT(t))),
    row('Weekend/holiday daytime', trig.filter((t) => wkend(t) && dayT(t))), row('Weekend/holiday overnight', trig.filter((t) => wkend(t) && !dayT(t)))].join('\n') + '\n');

const c = (x) => (x == null ? '—' : Math.round(x * 100) + '¢');
let dt = '## Day by day: is the gap closing?\n\n"Coinbase condition met" = windows where spot got $35+ past K, held 3 readings, and had crossed K in the 60 s before, with 30–150 s left. The ask is Polymarket US\'s at that first moment.\n\n'
  + '| Day (CT) | | Windows recorded | Median 30-min range | Coinbase condition met | % of windows | Ask > 70¢ | Ask 50–70¢ | Ask < 50¢ | Median ask | Median ask, $35–60 moves | Median move | Triggers | Filled | Won |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const d of days) {
  const H = holds.filter((h) => h.day === d), T = trig.filter((t) => t.day === d), F = T.filter((t) => t.filled), D = perDay[d];
  const wd = new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + (HOLIDAYS.has(d) ? '*' : '');
  const share = (f) => (H.length ? pct(H.filter(f).length / H.length) : '—');
  const mr = med(D.ranges);
  dt += `| ${d} | ${wd} | ${D.windows} | ${mr == null ? '—' : '$' + Math.round(mr)} | ${H.length} | ${pct(H.length / D.windows)} | ${share((h) => h.ask > 0.70 + 1e-9)} | ${share((h) => h.ask >= 0.50 - 1e-9 && h.ask <= 0.70 + 1e-9)} | ${share((h) => h.ask < 0.50 - 1e-9)} | ${c(med(H.map((h) => h.ask)))} | ${c(med(H.filter((h) => h.dist < 60).map((h) => h.ask)))} | $${Math.round(med(H.map((h) => h.dist)) || 0)} | ${T.length} | ${F.length} | ${F.filter((t) => t.won).length} |\n`;
}
out.push(dt + '\n* holiday\n');
const text = out.join('\n');
console.log(text);
if (opt.json) writeFileSync(opt.json, JSON.stringify({ trig, holds, perDay }, null, 0));

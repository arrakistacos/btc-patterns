// Shared loader for the offline backtests: the bot's 1-second Polymarket US recordings plus each window's outcome.
//
//   recordings  lag-YYYY-MM-DD.jsonl rows [ts, windowStart, elapsed, btc, comBid, comAsk, usBid, usAsk, latency, src]
//   outcomes    from the "price to beat <time> window: <price>" log lines: a window's open price is the previous
//               window's settlement, so Up won when the next window's price to beat is higher. A log has times of
//               day only, so each one comes with the date of its first line (FILE@start=YYYY-MM-DD) or of its last
//               (FILE@end=YYYY-MM-DD).
//   sanity      ticks with a crossed or empty book, a spread over 10¢, or a one-second jump of 25¢+ that comes
//               straight back are dropped
//
// loadWindows({ lagDirs, logs }) -> { windows: [{ Ws, day, K, won, rows: [{ e, S, bid, ask }] }], days, ticksIn, ticksOut }

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CT = 'America/Chicago';
export const fee = (p) => 0.095 * p * (1 - p);
export const dayOf = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: CT });

export function parseLog(spec) {
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
    let best = null;   // the window start whose Central-time label matches and is nearest the log time
    for (const off of [5, 6]) for (const dd of [-1, 0, 1]) {
      const Ws = day + dd * 86400 + (h + off) * 3600 + +r[2] * 60;
      if (new Date(Ws * 1000).toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ') !== `${+r[1]}:${r[2]} ${r[3]}`) continue;
      if (best == null || Math.abs(Ws - at) < Math.abs(best - at)) best = Ws;
    }
    if (best != null && Math.abs(best - at) < 3600) P[best] = +r[4];
  }
  return P;
}

export function loadWindows({ lagDirs, logs }) {
  const OPEN = {};
  for (const spec of logs) Object.assign(OPEN, parseLog(spec));
  const OUTCOME = {};
  for (const [Ws, p] of Object.entries(OPEN)) { const n = OPEN[+Ws + 300]; if (n != null && n !== p) OUTCOME[Ws] = n > p ? 1 : 0; }
  const raw = {};
  for (const dir of lagDirs) for (const f of readdirSync(dir).filter((x) => /^lag-.*\.jsonl$/.test(x)).sort()) {
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
      const [, Ws, e, btc, , , bid, ask] = r;
      const w = raw[Ws] || (raw[Ws] = new Map());
      if (!w.has(e)) w.set(e, { e, S: btc, bid, ask });
    }
  }
  let ticksIn = 0, ticksOut = 0;
  const valid = (r) => Number.isFinite(r.bid) && Number.isFinite(r.ask) && r.bid > 0 && r.ask < 1 && r.bid <= r.ask && r.ask - r.bid <= 0.10 && Number.isFinite(r.S) && r.S > 0;
  const mid = (x) => (x.bid + x.ask) / 2;
  const windows = [];
  for (const [Ws, m] of Object.entries(raw)) {
    if (OUTCOME[Ws] == null) continue;
    const all = [...m.values()].sort((a, b) => a.e - b.e);
    ticksIn += all.length;
    let rows = all.filter(valid);
    rows = rows.filter((r, i) => { const p = rows[i - 1], n = rows[i + 1]; return !p || !n || !(Math.abs(mid(r) - mid(p)) >= 0.25 && Math.abs(mid(n) - mid(p)) <= 0.05); });
    ticksOut += all.length - rows.length;
    if (rows.length < 30) continue;
    windows.push({ Ws: +Ws, day: dayOf(+Ws), K: OPEN[Ws], won: OUTCOME[Ws], rows });
  }
  windows.sort((a, b) => a.Ws - b.Ws);
  return { windows, days: [...new Set(windows.map((w) => w.day))].sort(), ticksIn, ticksOut };
}

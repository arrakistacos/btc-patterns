// Coin-flip night tables: what each night would have done with the current real-money rules, and every way a
// typical night can go. Used by autopilot.html and by Node (tests, analysis).
//
// A flip row (as the bot sends it): [Ws, q, quoted, cost, won, pat, real, bt]
//   Ws window start (s) · q model win chance for the side · quoted polymarket.com price for the side when it decided
//   cost all-in price per contract (price + fee) of its fill · won 1/0 · pat 0 none / 1 chart pattern against / 2 with
//   real 1 if it was a real-money flip · bt 1 for backtest rows (before the bot kept records)
// cfg: { favOnly, minReal (%), hours [3 booleans], antic, start, step, floor, blockReset, maxLosses, betPct, betUsd, tz }
//   (ladder off and betPct 0 = a fixed betUsd dollars per flip, like the bot)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlipStats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TZ = 'America/Chicago';
  const BLOCKS = ['12am–8am', '8am–4pm', '4pm–12am'];
  const parts = (ms, tz) => {
    const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(ms)) p[x.type] = x.value;
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, wd: p.weekday };
  };

  function defaults(c) {
    c = c || {};
    return {
      favOnly: c.favOnly !== false, minReal: c.minReal != null ? +c.minReal : 65, hours: Array.isArray(c.hours) ? c.hours : [true, false, false],
      antic: c.antic !== false, start: c.start != null ? +c.start : 15, step: c.step != null ? +c.step : 5, floor: c.floor != null ? +c.floor : 10,
      blockReset: c.blockReset !== false, maxLosses: c.maxLosses != null ? +c.maxLosses : 2, betPct: c.betPct != null ? +c.betPct : 10, betUsd: c.betUsd != null ? +c.betUsd : 10, tz: c.tz || TZ,
    };
  }
  // the same filters the bot uses before betting real money
  function qualifies(r, c) {
    const [Ws, q, quoted, cost, , pat] = r;
    if (!(cost > 0 && cost < 1)) return false;
    if (pat === 1) return false;                                   // chart pattern against the flip
    if (c.favOnly && !(quoted >= 0.5)) return false;               // model backs the underdog
    if (q * 100 < c.minReal - 1e-9) return false;                  // model below the minimum
    const blk = Math.floor(parts(Ws * 1000, c.tz).hour / 8);
    return c.hours[blk] !== false;                                  // block switched off
  }
  // one night from $100 (or bal): the ladder and the loss cap, as the bot runs them
  function ladderPct(c, since) { return !c.antic ? c.betPct : since == null ? c.floor : Math.max(c.floor, c.start - c.step * since); }
  function simulate(results, c, bal, since0) {
    let b = bal == null ? 100 : bal, since = c.blockReset ? null : since0 == null ? null : since0, losses = 0;
    const bets = [], taken = [];
    for (const [won, cost] of results) {
      if (c.maxLosses > 0 && losses >= c.maxLosses) break;           // loss cap: no more real flips this block
      const usd = !c.antic && !(c.betPct > 0), pct = ladderPct(c, since), stake = usd ? Math.min(b, c.betUsd) : b * pct / 100;
      b += won ? stake * (1 / cost - 1) : -stake;
      bets.push(usd ? '$' + c.betUsd : pct + '%'); taken.push(won);
      since = won ? (since == null ? null : since + 1) : 0;
      if (!won) losses++;
    }
    return { end: b, bets, taken, since };
  }
  // every night the rows cover (ticked blocks only), oldest first
  function nights(rows, cfg) {
    const c = defaults(cfg), groups = new Map();
    for (const r of rows.slice().sort((a, b) => a[0] - b[0])) {
      if (!qualifies(r, c)) continue;
      const p = parts(r[0] * 1000, c.tz), blk = Math.floor(p.hour / 8), key = p.day + '|' + blk;
      if (!groups.has(key)) groups.set(key, { day: p.day, wd: p.wd, blk, flips: [] });
      groups.get(key).flips.push(r);
    }
    const out = []; let since = null;
    for (const g of groups.values()) {
      const sim = simulate(g.flips.map((r) => [!!r[4], r[3]]), c, 100, since);
      since = sim.since;
      out.push({ day: g.day, wd: g.wd, blk: g.blk, block: BLOCKS[g.blk], n: g.flips.length, results: g.flips.map((r) => !!r[4]), bets: sim.bets, taken: sim.taken.length, end: sim.end,
        live: g.flips.some((r) => !r[7]), bt: g.flips.every((r) => r[7]), cost: g.flips.reduce((s, r) => s + r[3], 0) / g.flips.length });
    }
    return out;
  }
  function summary(ns) {
    const all = ns.flatMap((n) => n.results), counts = ns.map((n) => n.n), nc = ns.reduce((s, n) => s + n.cost * n.n, 0);
    return {
      flips: all.length, nights: ns.length, perNight: ns.length ? all.length / ns.length : 0,
      min: counts.length ? Math.min(...counts) : 0, max: counts.length ? Math.max(...counts) : 0,
      win: all.length ? all.filter(Boolean).length / all.length : 0, cost: all.length ? nc / all.length : 0,
    };
  }
  function avgCost(rows, cfg) {
    const c = defaults(cfg), q = rows.filter((r) => qualifies(r, c));
    return q.length ? q.reduce((s, r) => s + r[3], 0) / q.length : 0;
  }
  // every way an n-flip night can go at win chance p and cost per contract `cost`: rows with up to 2 losses
  // (after the loss cap stops a night, the flips it skips don't matter), plus the chance of anything worse
  function outcomes(n, p, cost, cfg) {
    const c = defaults(cfg), agg = new Map();
    for (let m = 0; m < (1 << n); m++) {
      const seq = []; for (let k = 0; k < n; k++) seq.push(!(m & (1 << k)));
      const sim = simulate(seq.map((w) => [w, cost]), c, 100, null);
      const key = sim.taken.map((w) => (w ? 'W' : 'L')).join('');
      const ch = seq.reduce((s, w) => s * (w ? p : 1 - p), 1);
      if (!agg.has(key)) agg.set(key, { key, taken: sim.taken, bets: sim.bets, end: sim.end, chance: 0 });
      agg.get(key).chance += ch;
    }
    let mean = 0; const rows = [];
    let worse = 0;
    for (const o of agg.values()) {
      mean += o.chance * o.end;
      const L = o.taken.reduce((s, w) => s + (w ? 0 : 1), 0);
      const pos = o.taken.map((w, i) => (w ? null : i + 1)).filter(Boolean);
      if (L <= 2) rows.push(Object.assign(o, { losses: L, pos, stopped: o.taken.length < n }));
      else worse += o.chance;
    }
    rows.sort((a, b) => a.losses - b.losses || a.pos.join() .localeCompare(b.pos.join(), undefined, { numeric: true }));
    return { n, p, cost, rows, worse, mean };
  }
  // fold rows that end at the same balance with the same number of losses ("Flip 1, 2 or 3 ... each")
  function grouped(o) {
    const g = [];
    for (const r of o.rows) {
      const last = g.find((x) => x.losses === r.losses && Math.abs(x.end - r.end) < 0.005 && Math.abs(x.chance - r.chance) < 1e-9);
      if (last) last.members.push(r); else g.push({ losses: r.losses, end: r.end, chance: r.chance, members: [r] });
    }
    return g;
  }
  const lossLabel = (pos) => (!pos.length ? 'None' : pos.length === 1 ? `Flip ${pos[0]}` : `Flips ${pos.join(' & ')}`);
  function groupLabel(g) {
    if (g.members.length === 1) return lossLabel(g.members[0].pos);
    if (g.losses === 1) { const p = g.members.map((m) => m.pos[0]); return `Flip ${p.slice(0, -1).join(', ')} or ${p[p.length - 1]}`; }
    return g.members.map((m) => m.pos.join(' & ')).reduce((s, x, i, a) => (i === 0 ? 'Flips ' + x : s + (i === a.length - 1 ? ' or ' : ', ') + x), '');
  }
  // the night sizes to show: the average night, and a busier one
  function sizes(ns) {
    const counts = ns.map((n) => n.n).sort((a, b) => a - b);
    if (!counts.length) return { typical: 3, busy: 5 };
    const avg = counts.reduce((s, x) => s + x, 0) / counts.length;
    const typical = Math.max(1, Math.round(avg));
    const p75 = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.75))];
    return { typical, busy: Math.min(7, Math.max(typical + 2, p75)) };
  }
  return { BLOCKS, defaults, qualifies, simulate, nights, summary, avgCost, outcomes, grouped, groupLabel, lossLabel, sizes, ladderPct };
});

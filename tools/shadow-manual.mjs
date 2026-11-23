#!/usr/bin/env node
// Shadow audit of manual trades: lines up each manual BTC 5-minute trade on Polymarket US against the bot's
// 1-second recordings (Coinbase spot and Polymarket US prices) at the second it was placed. Read-only: it places no
// orders, changes nothing and touches no live code.
//
//   fetch   node tools/shadow-manual.mjs fetch --env polymarket.env --out activities.json
//           Downloads the account's activity history (GET /v1/portfolio/activities, read-only, every page) with the
//           API key in the env file (PM_KEY_ID, PM_SECRET_KEY). The key is only used to sign the requests; it is
//           never printed or written anywhere.
//   audit   node tools/shadow-manual.mjs audit --activities activities.json --lag DIR[,DIR] --log FILE@start=YYYY-MM-DD
//             [--log FILE@end=YYYY-MM-DD] [--out report.md]
//           Picks the account's own BTC 5-minute buy fills, splits manual from automatic (Polymarket records which
//           one each order was), groups fills into one trade per window and side, and for each manual trade that
//           falls inside the recordings prints: the window's open (price to beat K), Coinbase spot at entry, the
//           distance toward the bet side, seconds left, the Polymarket ask at entry and whether Polymarket disagreed
//           with spot, where Polymarket's price was 5, 15 and 30 s later, the stake as % of the balance, and the result.

import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { loadWindows } from './recordings.mjs';

const [cmd, ...argv] = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const opts = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));

// ------------------------------------------------------------------ fetch
async function fetchAll() {
  const envFile = opt('--env'), out = opt('--out', 'activities.json');
  if (!envFile) throw new Error('fetch needs --env FILE');
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
  if (!env.PM_KEY_ID || !env.PM_SECRET_KEY) throw new Error('the env file has no PM_KEY_ID / PM_SECRET_KEY');
  const raw = Buffer.from(env.PM_SECRET_KEY, 'base64');
  const KEY = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const API = (env.PM_API || 'https://api.polymarket.us').replace(/\/$/, '');
  const get = async (path) => {
    const ts = String(Date.now()), sig = sign(null, Buffer.from(ts + 'GET' + path.split('?')[0]), KEY).toString('base64');
    const r = await fetch(API + path, { headers: { 'X-PM-Access-Key': env.PM_KEY_ID, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig, Accept: 'application/json' } });
    const t = await r.text(); if (!r.ok) { const e = new Error(`HTTP ${r.status} on ${path.split('?')[0]}: ${t.slice(0, 120)}`); e.status = r.status; throw e; }
    return JSON.parse(t);
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const getPolitely = async (path) => {   // the API rate-limits: pause between pages and back off on 429
    for (let k = 0; ; k++) {
      try { return await get(path); } catch (e) { if (e.status !== 429 || k >= 8) throw e; await sleep(15000 * (k + 1)); }
    }
  };
  const all = []; let cursor = '', pages = 0;
  for (;;) {
    const j = await getPolitely('/v1/portfolio/activities' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    all.push(...(j.activities || [])); pages++;
    if (pages % 10 === 0) { writeFileSync(out, JSON.stringify(all)); process.stderr.write(`${pages} pages, ${all.length} activities\n`); }
    await sleep(1200);
    if (j.eof || !j.nextCursor || j.nextCursor === cursor || pages > 2000) break;
    cursor = j.nextCursor;
  }
  writeFileSync(out, JSON.stringify(all));
  const types = {}; for (const a of all) types[a.type] = (types[a.type] || 0) + 1;
  console.log(`${all.length} activities in ${pages} pages -> ${out}`, JSON.stringify(types));
}

// ------------------------------------------------------------------ audit
const num = (x) => (x == null ? null : typeof x === 'object' ? +x.value : +x);
const BTC5 = /^cpc-btc-updown-5m-(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)z$/;
// Polymarket's 5-minute slugs name the window's start (UTC), e.g. ...-1555z is 15:55–16:00
function windowOf(slug) { const m = BTC5.exec(slug || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : null; }

// The account's own execution in a trade is the one whose order carries the account's details (intent and the
// manual/automatic flag); the other side's order comes back without them.
//   intent      BUY_LONG buy Up · SELL_LONG sell Up · BUY_SHORT buy Down · SELL_SHORT sell Down
//   lastPx      always the Up (YES) price, so a Down share is 1 - lastPx
const ownExec = (tr) => [tr.aggressorExecution, tr.passiveExecution].find((ex) => ex && ex.order && ex.order.manualOrderIndicator && ex.order.intent && ex.order.intent !== 'ORDER_INTENT_UNDEFINED');
function ownFills(activities) {
  const out = [];
  for (const a of activities) {
    if (a.type !== 'ACTIVITY_TYPE_TRADE' || !a.trade) continue;
    const ex = ownExec(a.trade); if (!ex) continue;
    const o = ex.order, m = /ORDER_INTENT_(BUY|SELL)_(LONG|SHORT)/.exec(o.intent); if (!m) continue;
    const qty = num(ex.lastShares), yes = num(ex.lastPx), up = m[2] === 'LONG';
    out.push({ Ws: windowOf(o.marketSlug), slug: o.marketSlug, orderId: o.id, manual: o.manualOrderIndicator === 'MANUAL_ORDER_INDICATOR_MANUAL',
      ts: Date.parse(ex.transactTime || o.createTime) / 1000, buy: m[1] === 'BUY', side: up ? 'UP' : 'DOWN', qty, px: up ? yes : 1 - yes, feeUsd: num(ex.commissionNotionalCollected) || 0 });
  }
  return out;
}
// Cash before each moment, walked backward from a known balance: buys cost shares x price + fee, sells return
// shares x price - fee, a resolution pays its cash value, deposits and withdrawals move the amount.
function cashWalk(activities, anchorTs, anchorBal) {
  const ev = [];
  for (const a of activities) {
    if (a.type === 'ACTIVITY_TYPE_TRADE' && a.trade) {
      const ex = ownExec(a.trade); if (!ex) continue;
      const m = /ORDER_INTENT_(BUY|SELL)_(LONG|SHORT)/.exec(ex.order.intent); if (!m) continue;
      const qty = num(ex.lastShares), yes = num(ex.lastPx), px = m[2] === 'LONG' ? yes : 1 - yes, f = num(ex.commissionNotionalCollected) || 0;
      ev.push({ ts: Date.parse(ex.transactTime) / 1000, d: (m[1] === 'BUY' ? -qty * px : qty * px) - f });
    } else if (a.type === 'ACTIVITY_TYPE_POSITION_RESOLUTION' && a.positionResolution) {
      const r = a.positionResolution, t = r.afterPosition && r.afterPosition.updateTime;
      ev.push({ ts: Date.parse(t) / 1000, d: num(r.cashValue) || 0 });
    } else if (a.accountBalanceChange) {
      const c = a.accountBalanceChange, amt = num(c.amount) || 0, sign = /WITHDRAWAL/.test(a.type) ? -1 : /DEPOSIT/.test(a.type) ? 1 : 0;
      if (sign && !/FAILED|CANCEL|REJECT/.test(c.status || '')) ev.push({ ts: Date.parse(c.createTime) / 1000, d: sign * amt });
    }
  }
  ev.sort((x, y) => x.ts - y.ts);
  // balance just after each event, from the anchor
  let after = anchorBal; const bal = new Array(ev.length);
  let k = ev.findIndex((e) => e.ts > anchorTs); if (k < 0) k = ev.length;
  for (let i = k - 1; i >= 0; i--) { bal[i] = after; after -= ev[i].d; }
  let b = anchorBal; for (let i = k; i < ev.length; i++) { b += ev[i].d; bal[i] = b; }
  return (ts) => { // cash just before time ts
    let lo = 0, hi = ev.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].ts < ts) lo = mid + 1; else hi = mid; }
    if (lo === 0) return bal.length ? bal[0] - ev[0].d : anchorBal;
    return bal[lo - 1];
  };
}

function audit() {
  const acts = JSON.parse(readFileSync(opt('--activities', 'activities.json'), 'utf8'));
  const lagDirs = (opt('--lag', '') || '').split(',').filter(Boolean), logs = opts('--log'), OUT = opt('--out', null);
  const stateFile = opt('--state', null), anchorArg = opt('--balance-at', null);   // --balance-at 2026-11-23T16:34:43Z=266.14
  const fills = ownFills(acts).filter((f) => f.Ws != null).sort((a, b) => a.ts - b.ts);
  // anchor for cash: the bot's last balance reading, or one given
  let anchor = null, botTrades = [];
  if (stateFile) { const st = JSON.parse(readFileSync(stateFile, 'utf8')); if (st.liveBal) anchor = [st.liveBal.at / 1000, st.liveBal.buyingPower]; botTrades = (st.trades || []).filter((t) => t.mode === 'live' && t.orderId && t.balBefore != null); }
  if (anchorArg) { const [t, v] = anchorArg.split('='); anchor = [Date.parse(t) / 1000, +v]; }
  const cashAt = anchor ? cashWalk(acts, anchor[0], anchor[1]) : () => null;
  // check the cash walk against the balances the bot itself read before its own orders
  const chk = botTrades.map((t) => { const c = cashAt(t.ts / 1000 - 1); return c == null ? null : Math.abs(c - t.balBefore); }).filter((x) => x != null).sort((a, b) => a - b);
  // one trade per window and side
  const T = new Map();
  for (const f of fills) {
    const k = f.Ws + f.side;
    const t = T.get(k) || T.set(k, { Ws: f.Ws, slug: f.slug, side: f.side, ts: null, bought: 0, cost: 0, sold: 0, proceeds: 0, fee: 0, manual: 0, auto: 0, buys: 0 }).get(k);
    if (f.buy) { if (t.ts == null) t.ts = f.ts; t.bought += f.qty; t.cost += f.qty * f.px; t.buys++; } else { t.sold += f.qty; t.proceeds += f.qty * f.px; }
    t.fee += f.feeUsd; if (f.manual) t.manual++; else t.auto++;
  }
  const trades = [...T.values()].filter((t) => t.ts != null).sort((a, b) => a.ts - b.ts);
  const { windows } = lagDirs.length ? loadWindows({ lagDirs, logs }) : { windows: [] };
  const W = new Map(windows.map((w) => [w.Ws, w]));
  const ct = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const c = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '¢');
  const man = trades.filter((t) => t.manual && !t.auto), mixed = trades.filter((t) => t.manual && t.auto), auto = trades.filter((t) => !t.manual);
  const rows = [];
  for (const t of man) {
    const w = W.get(t.Ws), avg = t.cost / t.bought, held = t.bought - t.sold, left = Math.round(t.Ws + 300 - t.ts);
    const before = cashAt(t.ts - 0.5), stakePct = before ? (t.cost + t.fee * (t.bought ? 1 : 0)) / before : null;
    const R = { t, avg, left, held, before, stakePct, K: null, S: null, D: null, ask: null, dis: null, p5: null, p15: null, p30: null, won: null, pnl: null, inRec: !!w };
    if (w) {
      R.K = w.K; R.won = (t.side === 'UP' ? 1 : 0) === w.won ? 1 : 0;
      const e = t.ts - t.Ws, near = (x) => w.rows.reduce((b, r) => (Math.abs(r.e - x) < Math.abs(b.e - x) ? r : b), w.rows[0]);
      const r0 = near(e), sp = (r) => (t.side === 'UP' ? r.ask : 1 - r.bid);
      if (Math.abs(r0.e - e) <= 3) {
        R.S = r0.S; R.D = R.K != null ? (t.side === 'UP' ? R.S - R.K : R.K - R.S) : null; R.ask = sp(r0);
        R.dis = R.D == null ? null : R.D > 0 && R.ask < 0.5 ? 'yes (<50¢)' : R.D > 0 && R.ask < 0.7 ? 'partly (50–70¢)' : R.D <= 0 ? 'no: spot against' : 'no: already agreed';
        for (const [dt, key] of [[5, 'p5'], [15, 'p15'], [30, 'p30']]) { const r = near(e + dt); if (Math.abs(r.e - (e + dt)) <= 3 && r.e <= 299) R[key] = sp(r); }
      }
      R.pnl = t.proceeds + held * R.won - t.cost - t.fee;
    }
    rows.push(R);
  }
  const L = [];
  L.push('# Shadow audit of manual BTC 5-minute trades', '', `Generated ${new Date().toISOString()}.`, '');
  const span = fills.length ? `${ct(fills[0].ts)} to ${ct(fills.at(-1).ts)}` : '—';
  L.push(`- Activity records read: ${acts.length}. Own BTC 5-minute fills: ${fills.length} (${fills.filter((f) => f.manual).length} manual, ${fills.filter((f) => !f.manual).length} automatic, as Polymarket flags each order), ${span} Central.`);
  L.push(`- Trades (fills grouped by window and side): **${man.length} manual**, ${auto.length} automatic (the bot's), ${mixed.length} mixed. Manual trades inside the recordings: ${rows.filter((r) => r.inRec).length}.`);
  if (chk.length) L.push(`- Balance before each trade is walked back from the bot's last reading (${anchor ? '$' + anchor[1].toFixed(2) + ' at ' + ct(anchor[0]) : ''}). Checked against the bot's own balance readings before its ${chk.length} orders: median miss $${chk[chk.length >> 1].toFixed(2)}, 90% within $${chk[Math.floor(chk.length * 0.9)].toFixed(2)}.`);
  L.push('');
  // summary
  const rec = rows.filter((r) => r.won != null), wins = rec.filter((r) => r.pnl > 0).length, tot = rec.reduce((s, r) => s + r.pnl, 0), staked = rec.reduce((s, r) => s + r.t.cost, 0);
  const q = (a, p) => { const b = a.filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : null; };
  const pr = (a, f = (x) => x.toFixed(0)) => `${f(q(a, 0.1))} / ${f(q(a, 0.5))} / ${f(q(a, 0.9))}`;
  L.push('## Summary (manual trades inside the recordings)', '');
  L.push(`- ${rec.length} trades, ${wins} made money (${rec.length ? (wins / rec.length * 100).toFixed(1) : '—'}%), net **${tot >= 0 ? '+' : '−'}$${Math.abs(tot).toFixed(2)}** on $${staked.toFixed(2)} bought (${staked ? (tot / staked * 100).toFixed(1) : '—'}% per $1). Held to the end: ${rec.filter((r) => r.t.sold < 1e-6).length}; sold some or all early: ${rec.filter((r) => r.t.sold > 1e-6).length}.`);
  L.push(`- What your entries looked like (10th / median / 90th percentile): seconds left ${pr(rec.map((r) => r.left))}; distance toward the bet, $ ${pr(rec.map((r) => r.D))}; Polymarket ask at entry ${pr(rec.map((r) => r.ask), (x) => (x * 100).toFixed(0) + '¢')}; price paid ${pr(rec.map((r) => r.avg), (x) => (x * 100).toFixed(0) + '¢')}; stake ${pr(rec.map((r) => r.stakePct), (x) => (x * 100).toFixed(1) + '%')} of cash.`);
  const grp = (lab, a) => { const n = a.length, w = a.filter((r) => r.pnl > 0).length, p = a.reduce((s, r) => s + r.pnl, 0), st = a.reduce((s, r) => s + r.t.cost, 0); return `| ${lab} | ${n} | ${n ? (w / n * 100).toFixed(0) + '%' : '—'} | ${p >= 0 ? '+' : '−'}$${Math.abs(p).toFixed(2)} | ${st ? (p / st * 100).toFixed(1) + '%' : '—'} |`; };
  L.push('', '| Group | Trades | Made money | Net P&L | Per $1 |', '|---|---|---|---|---|',
    grp('Polymarket disagreed (spot on your side, ask under 50¢)', rec.filter((r) => r.dis === 'yes (<50¢)')), grp('Partly (spot on your side, 50–70¢)', rec.filter((r) => r.dis === 'partly (50–70¢)')),
    grp('Polymarket already agreed (70¢+)', rec.filter((r) => r.dis === 'no: already agreed')), grp('Spot was against your side', rec.filter((r) => r.dis === 'no: spot against')),
    grp('Price paid under 30¢', rec.filter((r) => r.avg < 0.3)), grp('30–50¢', rec.filter((r) => r.avg >= 0.3 && r.avg < 0.5)), grp('50–70¢', rec.filter((r) => r.avg >= 0.5 && r.avg < 0.7)), grp('70¢+', rec.filter((r) => r.avg >= 0.7)),
    grp('Under 60 s left', rec.filter((r) => r.left < 60)), grp('60–150 s left', rec.filter((r) => r.left >= 60 && r.left <= 150)), grp('Over 150 s left', rec.filter((r) => r.left > 150)),
    grp('Stake under 10% of cash', rec.filter((r) => r.stakePct != null && r.stakePct < 0.1)), grp('Stake 10–25%', rec.filter((r) => r.stakePct >= 0.1 && r.stakePct < 0.25)), grp('Stake 25%+', rec.filter((r) => r.stakePct >= 0.25)),
    grp('Held to the end', rec.filter((r) => r.t.sold < 1e-6)), grp('Sold some or all early', rec.filter((r) => r.t.sold > 1e-6)));
  const cu = rec.filter((r) => r.ask != null && r.p15 != null);
  L.push('', `Catch-up: Polymarket's price for your side was 5¢+ higher 15 s after entry in ${cu.filter((r) => r.p15 - r.ask >= 0.05).length} of ${cu.length} trades, and 5¢+ lower in ${cu.filter((r) => r.ask - r.p15 >= 0.05).length}.`, '');
  // by day
  const days = {}; for (const r of rows) { const d = new Date(r.t.ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); const x = days[d] || (days[d] = { n: 0, w: 0, p: 0, out: 0 }); x.n++; if (r.pnl != null) { x.p += r.pnl; if (r.pnl > 0) x.w++; } else x.out++; }
  L.push('| Day | Manual trades | Made money | Net P&L (in recordings) |', '|---|---|---|---|');
  for (const [d, x] of Object.entries(days)) L.push(`| ${d} | ${x.n}${x.out ? ` (${x.out} outside recordings)` : ''} | ${x.w} | ${x.p >= 0 ? '+' : '−'}$${Math.abs(x.p).toFixed(2)} |`);
  L.push('', '## Every manual trade', '', '| Placed (Central) | Side | Shares bought | Avg price | Sold early | Cash before | Stake | Seconds left | Open K | Spot | Distance toward bet | Ask then | Disagreed? | +5 s | +15 s | +30 s | Result | P&L |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const t = r.t;
    L.push(`| ${ct(t.ts)} | ${t.side} | ${t.bought.toFixed(2)} | ${c(r.avg)} | ${t.sold > 1e-6 ? `${t.sold.toFixed(2)} @ ${c(t.proceeds / t.sold)}` : '—'} | ${r.before == null ? '—' : '$' + r.before.toFixed(2)} | ${r.stakePct == null ? '—' : (r.stakePct * 100).toFixed(1) + '%'} | ${r.left} | ${r.K == null ? '—' : '$' + r.K.toFixed(2)} | ${r.S == null ? '—' : '$' + r.S.toFixed(2)} | ${r.D == null ? '—' : (r.D >= 0 ? '+' : '−') + '$' + Math.abs(r.D).toFixed(0)} | ${c(r.ask)} | ${r.dis || '—'} | ${c(r.p5)} | ${c(r.p15)} | ${c(r.p30)} | ${r.won == null ? (r.inRec ? '—' : 'outside recordings') : r.won ? 'won' : 'lost'} | ${r.pnl == null ? '—' : (r.pnl >= 0 ? '+' : '−') + '$' + Math.abs(r.pnl).toFixed(2)} |`);
  }
  L.push('', '## Notes', '', '- Manual vs automatic is Polymarket\'s own flag on each order; the bot marks its orders automatic. A window with both is counted as mixed and left out.',
    '- Distance is Coinbase spot minus the window\'s price to beat (the BRTI index Polymarket settles on), signed toward the bet side. TradingView shows whichever exchange you chart, which can sit a few dollars away.',
    '- +5 s / +15 s / +30 s are Polymarket US\'s ask for the same side at those moments, from the recordings. "Made money" counts early sales too.',
    '- P&L = what early sales brought in + $1 for each share still held if the side won − what was paid − fees.');
  const report = L.join('\n'); if (OUT) writeFileSync(OUT, report + '\n'); console.log(report.split('## Every manual trade')[0]);
}

if (cmd === 'fetch') fetchAll().catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'audit') audit();
else { console.error('usage: shadow-manual.mjs fetch --env FILE --out activities.json | audit --activities FILE --lag DIRS --log FILE@start=...'); process.exit(1); }

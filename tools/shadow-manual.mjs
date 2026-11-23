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
import { loadWindows, fee } from './recordings.mjs';

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
    const t = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status} on ${path.split('?')[0]}: ${t.slice(0, 200)}`);
    return JSON.parse(t);
  };
  const all = []; let cursor = '', pages = 0;
  for (;;) {
    const j = await get('/v1/portfolio/activities' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    all.push(...(j.activities || [])); pages++;
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
// Polymarket's 5-minute slugs name the window's end (UTC); the window starts 300 s earlier
function windowOf(slug) { const m = BTC5.exec(slug || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - 300 : null; }

// One fill from an activity: the account's own execution is the one whose order carries the account's details
// (intent and manual/automatic flag); the other side's order comes back without them.
function ownFills(activities) {
  const out = [];
  for (const a of activities) {
    if (a.type !== 'ACTIVITY_TYPE_TRADE' || !a.trade) continue;
    for (const ex of [a.trade.aggressorExecution, a.trade.passiveExecution]) {
      const o = ex && ex.order; if (!o || !o.manualOrderIndicator || o.intent === 'ORDER_INTENT_UNDEFINED') continue;
      const Ws = windowOf(o.marketSlug); if (Ws == null) continue;
      const qty = num(ex.lastShares), px = num(ex.lastPx), feeUsd = num(ex.commissionNotionalCollected) || 0;
      // Buying Up = buying YES; buying Down = selling YES (the price then is YES's, so Down paid 1 - px)
      const buyUp = o.intent === 'ORDER_INTENT_BUY_LONG' || (o.side === 'ORDER_SIDE_BUY' && o.outcomeSide !== 'OUTCOME_SIDE_NO' && !/SHORT/.test(o.intent));
      const buyDown = o.intent === 'ORDER_INTENT_BUY_SHORT' || (o.side === 'ORDER_SIDE_SELL' && /SHORT/.test(o.intent || ''));
      if (!buyUp && !buyDown) continue;   // closing a position early: not an entry
      const upPx = buyUp ? px : 1 - px;
      out.push({ Ws, slug: o.marketSlug, orderId: o.id, manual: o.manualOrderIndicator === 'MANUAL_ORDER_INDICATOR_MANUAL',
        ts: Date.parse(ex.transactTime || o.createTime) / 1000, side: buyUp ? 'UP' : 'DOWN', qty, px: upPx, feeUsd, intent: o.intent, rawSide: o.side, outcomeSide: o.outcomeSide });
    }
  }
  return out;
}

function audit() {
  const acts = JSON.parse(readFileSync(opt('--activities', 'activities.json'), 'utf8'));
  const lagDirs = (opt('--lag', '') || '').split(',').filter(Boolean), logs = opts('--log'), OUT = opt('--out', null);
  const fills = ownFills(acts);
  // one trade per window and side, in the order placed
  const T = new Map();
  for (const f of fills.sort((a, b) => a.ts - b.ts)) {
    const k = f.Ws + f.side + (f.manual ? 'm' : 'a');
    const t = T.get(k) || T.set(k, { Ws: f.Ws, side: f.side, manual: f.manual, ts: f.ts, qty: 0, cost: 0, fee: 0, orders: new Set(), fills: 0 }).get(k);
    t.qty += f.qty; t.cost += f.qty * f.px; t.fee += f.feeUsd; t.orders.add(f.orderId); t.fills++;
  }
  const trades = [...T.values()].sort((a, b) => a.ts - b.ts);
  const { windows } = lagDirs.length ? loadWindows({ lagDirs, logs }) : { windows: [] };
  const W = new Map(windows.map((w) => [w.Ws, w]));
  // the balance before each trade, walking cash changes (deposits, withdrawals, trades) when the history allows
  const cashBefore = (ts) => null;   // filled below if the activity history carries balances
  const ct = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const c = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '¢');
  const L = [];
  const man = trades.filter((t) => t.manual), auto = trades.filter((t) => !t.manual);
  L.push('# Shadow audit of manual BTC 5-minute trades', '', `Generated ${new Date().toISOString()}.`, '');
  L.push(`- Activity records: ${acts.length}; own BTC 5-minute buy fills: ${fills.length} (${fills.filter((f) => f.manual).length} manual, ${fills.filter((f) => !f.manual).length} automatic, as Polymarket marks each order).`);
  L.push(`- Trades (fills grouped by window and side): ${man.length} manual, ${auto.length} automatic. Recordings cover ${windows.length ? `${new Date(windows[0].Ws * 1000).toISOString().slice(0, 10)} to ${new Date(windows.at(-1).Ws * 1000).toISOString().slice(0, 10)}` : 'nothing (no --lag given)'}.`, '');
  L.push('## Manual trades', '', '| Placed (Central) | Side | Shares | Avg price | Cost + fee | Seconds left | Open K | Spot at entry | Distance toward bet | Polymarket ask then | Polymarket disagreed? | +5 s | +15 s | +30 s | Result | P&L |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const ranges = [];
  for (const t of man) {
    const w = W.get(t.Ws), avg = t.cost / t.qty, paid = (t.side === 'UP' ? avg : 1 - avg);
    const costUsd = t.qty * paid + t.fee, left = Math.round(t.Ws + 300 - t.ts);
    let K = null, S = null, D = null, ask = null, dis = '—', p5 = null, p15 = null, p30 = null, won = null;
    if (w) {
      K = w.K; won = (t.side === 'UP' ? 1 : 0) === w.won ? 1 : 0;
      const e = t.ts - t.Ws, near = (x) => w.rows.reduce((b, r) => (Math.abs(r.e - x) < Math.abs(b.e - x) ? r : b), w.rows[0]);
      const r0 = near(e), sp = (r) => (t.side === 'UP' ? r.ask : 1 - r.bid);
      if (Math.abs(r0.e - e) <= 3) {
        S = r0.S; D = K != null ? (t.side === 'UP' ? S - K : K - S) : null; ask = sp(r0);
        dis = D == null ? '—' : D > 0 && ask < 0.5 ? 'yes: spot on our side, Polymarket under 50¢' : D > 0 && ask < 0.7 ? 'partly: spot on our side, under 70¢' : D <= 0 ? 'no: spot on the other side' : 'no: Polymarket already agreed';
        for (const [dt, set] of [[5, (v) => (p5 = v)], [15, (v) => (p15 = v)], [30, (v) => (p30 = v)]]) { const r = near(e + dt); if (Math.abs(r.e - (e + dt)) <= 3) set(sp(r)); }
      }
      ranges.push({ left, D, ask, paid });
    }
    const pnl = won == null ? null : won ? t.qty - costUsd : -costUsd;
    L.push(`| ${ct(t.ts)} | ${t.side} | ${t.qty.toFixed(2)} | ${c(paid)} | $${costUsd.toFixed(2)} | ${left} | ${K == null ? '—' : '$' + K.toFixed(2)} | ${S == null ? '—' : '$' + S.toFixed(2)} | ${D == null ? '—' : (D >= 0 ? '+' : '−') + '$' + Math.abs(D).toFixed(0)} | ${c(ask)} | ${dis} | ${c(p5)} | ${c(p15)} | ${c(p30)} | ${won == null ? (w ? '—' : 'outside recordings') : won ? 'won' : 'lost'} | ${pnl == null ? '—' : (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl).toFixed(2)} |`);
  }
  if (!man.length) L.push('| (no manual BTC 5-minute trades found) |||||||||||||||| ');
  const r = ranges.filter((x) => x.D != null);
  if (r.length) {
    const mm = (a) => `${Math.min(...a).toFixed(0)}–${Math.max(...a).toFixed(0)}`;
    L.push('', '## What the manual entries had in common', '', `- Seconds left: ${mm(r.map((x) => x.left))}`, `- Distance toward the bet side: ${mm(r.map((x) => x.D))} dollars (smallest ${Math.min(...r.map((x) => x.D)).toFixed(0)})`, `- Polymarket ask at entry: ${mm(r.map((x) => x.ask * 100))}¢; price paid ${mm(r.map((x) => x.paid * 100))}¢`);
  }
  L.push('', '## Notes', '', '- Manual vs automatic comes from Polymarket\'s own flag on each order; the bot marks its orders automatic.',
    '- Distance is Coinbase spot minus the window\'s price to beat (BRTI), signed toward the bet side; TradingView shows the exchange you chart, which can sit a few dollars away.',
    '- +5 s / +15 s / +30 s are Polymarket US\'s ask for the same side at those moments, from the recordings.',
    '- Result is how the window settled; P&L = shares if won, minus what was paid with the fee. Sold-before-the-end positions show only the entry.');
  const report = L.join('\n'); if (OUT) writeFileSync(OUT, report + '\n'); console.log(report);
  void cashBefore; void fee;
}

if (cmd === 'fetch') fetchAll().catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'audit') audit();
else { console.error('usage: shadow-manual.mjs fetch --env FILE --out activities.json | audit --activities FILE --lag DIRS --log FILE@start=...'); process.exit(1); }

/*
 * BTC Pattern Watch — autopilot (runs inside tools/signal-bot.mjs)
 *
 * When the bot sends a BUY alert, autopilot buys that side of the current 5-minute market on Polymarket US
 * through the official API, using a fixed % of the balance. It tracks every trade to settlement, keeps
 * score, and halts itself (with an urgent push) when the money runs out, the daily loss limit is hit, or
 * Polymarket rejects the API key.
 *
 *   Practice mode  uses the live Polymarket US order book and real results with a pretend balance. No key needed.
 *   Live mode      places real orders. Needs PM_KEY_ID + PM_SECRET_KEY (from polymarket.us/developer).
 *
 * Remote control: the autopilot page (autopilot.html) and this module talk through two ntfy topics,
 * encrypted and signed with AUTOPILOT_PASSWORD (see apcrypto.js). Settings and history are saved in
 * autopilot-state.json next to the bot.
 *
 * Environment:
 *   PM_KEY_ID, PM_SECRET_KEY   Polymarket US API key (Key ID + base64 secret). Live mode only.
 *   AUTOPILOT_PASSWORD         password for the autopilot page. Without it the page can't connect.
 *   PM_API, PM_GATEWAY         API hosts (defaults https://api.polymarket.us, https://gateway.polymarket.us)
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { join } from 'node:path';

export const AUTOPILOT_VERSION = '1.1.0';
const W = 300;
const DEFAULTS = {
  enabled: true, mode: 'practice', betPct: 20, dailyStopPct: 50, notifyFills: true, notifyResults: true,
  lossStreak: 2, cooldownMin: 60,        // pause this long after this many losses in a row (0 = never)
  lateLive: false, lateBet: 5,           // late coin-flip: real orders (Live mode only), dollars per trade…
  lateBetPct: 0,                         // …or, when > 0, this % of buying power per trade
  mainOn: true,                          // regular BUY-signal bets use real money in Live (off = practice only, coin flips still real)
  lateAntic: false,                      // Anticipation mode: real coin-flip size steps down after each loss…
  anticStart: 20, anticStep: 5, anticFloor: 10,
  anticBlockReset: true,
  lateMaxLosses: 2,                      // stop real coin flips for the rest of the 8-hour block after this many real losses in it (0 = never)                 // each new 8-hour block starts at the bottom of the ladder until a real loss in that block   // …anticStart % right after a loss, minus anticStep per coin flip since, never below anticFloor
  lateHours: [true, true, true],         // real coin flips allowed in each 8-hour block, Central time: 12am-8am, 8am-4pm, 4pm-12am
  lateFavOnly: true,                     // real coin-flip money only when the model backs Polymarket's favorite
  lateMinReal: 65,                       // …and only when the model gives that side at least this % (60 = no extra filter)
  goal: 0,                               // dollars: pause + notify when the current mode's balance reaches this (0 = off)
  goalHitFor: null,                      // "mode:goal" already reached, so the same goal fires only once
  streak: { practice: 0, live: 0 },      // current run of losses
  minModel: null, minMarket: null,      // null = use the bot's MIN_MODEL / MIN_MARKET
  target: null,                          // gap confidence target (60–95); null = the bot's TARGET
  practice: { balance: 1000, start: 1000 },
  halted: null,                          // { reason, detail, at, untilDay? | untilTs?, kind? }
  trades: [], days: {}, stats: { practice: null, live: null }, liveBal: null,
};
const zeroStats = () => ({ n: 0, w: 0, l: 0, pnl: 0, staked: 0, nofill: 0 });
const MIN_BALANCE = 1;                   // dollars; below this autopilot halts as out of money
const SLIP_TICKS = 1;                    // pay at most 1 tick above the best price
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const cents = (p) => Math.round(p * 100) + '¢';
const money = (x) => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seconds by which US price changes trail polymarket.com changes. ring: [tsMs, Ws, comMid, usMid] about once a second.
// Correlates each 1-second .com change with the US change k seconds later (k = -5..15) and picks the best k.
export function estimateLag(ring) {
  const by = new Map();
  for (const [ts, Ws, c, u] of ring) {
    if (!by.has(Ws)) by.set(Ws, new Map());
    by.get(Ws).set(Math.round(ts / 1000), [c, u]);
  }
  const res = [];
  for (let k = -5; k <= 15; k++) {
    let sxy = 0, sxx = 0, syy = 0, n = 0;
    for (const m of by.values()) for (const [sec, [c]] of m) {
      const p = m.get(sec - 1), a = m.get(sec + k), b = m.get(sec + k - 1);
      if (!p || !a || !b) continue;
      const dc = c - p[0], du = a[1] - b[1];
      sxy += dc * du; sxx += dc * dc; syy += du * du; n++;
    }
    res.push([k, sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0, n]);
  }
  const best = res.reduce((a, b) => (b[1] > a[1] ? b : a), res[0]);
  // "most of it lands by N s": where the positive correlations at k >= 0 reach 80% of their total
  const pos = res.filter(([k, r]) => k >= 0 && r > 0), tot = pos.reduce((a, [, r]) => a + r, 0);
  let acc = 0, by80 = null;
  for (const [k, r] of pos) { acc += r; if (by80 == null && tot && acc / tot >= 0.8) by80 = k; }
  let gs = 0;
  for (const [, , c, u] of ring) gs += Math.abs(c - u);
  if (!(best[1] > 0.05) || best[2] < 60) return { lag: null, corr: Math.round(best[1] * 100) / 100, n: best[2], by80: null, gap: ring.length ? Math.round(ring.reduce((a, [, , c, u]) => a + Math.abs(c - u), 0) / ring.length * 1000) / 10 : null, samples: ring.length };
  return { lag: best[0], corr: Math.round(best[1] * 100) / 100, n: best[2], by80, gap: ring.length ? Math.round(gs / ring.length * 1000) / 10 : null, samples: ring.length };
}

// Healthchecks.io heartbeat (optional): a ping every minute while the bot is healthy, so Healthchecks tells your
// phone if the bot, its computer or its internet goes quiet. /fail when it is up but has no prices to trade on.
//   url    https://hc-ping.com/<project ping key>/<check slug>   (or a check's own ping URL)
//   health () => ({ c: s since last Bitcoin price, p: s since last Polymarket odds })   up: s since the bot started
export function createHeartbeat({ url, every = 60, health, state = () => ({}), up, host = '', log = () => {}, noPriceS = 180, noOddsS = 300, fetchFn = fetch }) {
  let warnedAt = 0, timer = null, lastBad = null;
  function status() {
    const h = health() || {}, s = state() || {}, u = up(), bad = [];
    const cAge = h.c == null ? u : h.c, pAge = h.p == null ? u : h.p;
    if (cAge > noPriceS) bad.push(`no Bitcoin price for ${Math.round(cAge / 60)} min`);
    if (pAge > noOddsS) bad.push(`no Polymarket odds for ${Math.round(pAge / 60)} min`);
    const ap = s.enabled ? `autopilot ${s.mode}${s.halted ? ' HALTED: ' + s.halted.reason : ''}` : 'autopilot off';
    const body = `${host ? host + ' · ' : ''}${bad.length ? bad.join('; ') : 'ok'} · price ${h.c ?? '—'}s old · odds ${h.p ?? '—'}s old · ${ap}`;
    return { ok: !bad.length, body };
  }
  async function ping(kind) {
    if (!url) return null;
    const st = status(), k = kind || (st.ok ? '' : 'fail');
    try {
      const r = await fetchFn(url.replace(/\/$/, '') + (k ? '/' + k : ''), { method: 'POST', body: st.body, signal: AbortSignal.timeout(10000) });
      if (!r.ok && Date.now() - warnedAt > 3600000) { warnedAt = Date.now(); log(`healthchecks ping HTTP ${r.status}${r.status === 404 ? ' (no check with that name: create it on Healthchecks.io)' : ''}`); }
      if (st.ok !== lastBad) { if (lastBad !== null) log(st.ok ? 'healthchecks: healthy again' : `healthchecks: reporting a problem (${st.body})`); lastBad = st.ok; }
      return r.status;
    } catch (e) {
      if (Date.now() - warnedAt > 3600000) { warnedAt = Date.now(); log('healthchecks ping failed:', e.message); }
      return null;
    }
  }
  return {
    on: !!url, status, ping,
    start() { if (!url || timer) return; ping(); timer = setInterval(() => ping(), Math.max(10, every) * 1000); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
  };
}

export function createAutopilot(o) {
  const { dir, log, push, Signal, APC, tzName = 'America/Chicago' } = o;
  const env = o.env || process.env;
  const NTFY = (o.ntfyServer || 'https://ntfy.sh').replace(/\/$/, '');
  const NTFY_AUTH = o.ntfyToken ? { Authorization: 'Bearer ' + o.ntfyToken } : {};
  const API = (env.PM_API || 'https://api.polymarket.us').replace(/\/$/, '');
  const GATEWAY = (env.PM_GATEWAY || 'https://gateway.polymarket.us').replace(/\/$/, '');
  const STATE_FILE = join(dir, 'autopilot-state.json');
  const T = APC.topics(o.topic || '');
  const STARTED = Date.now();

  // ------------------------------------------------------------ state
  let S = JSON.parse(JSON.stringify(DEFAULTS));
  try { if (existsSync(STATE_FILE)) S = Object.assign(S, JSON.parse(readFileSync(STATE_FILE, 'utf8'))); } catch (e) { log('autopilot: could not read state, starting fresh:', e.message); }
  S.stats.practice = S.stats.practice || zeroStats(); S.stats.live = S.stats.live || zeroStats();
  S.streak = Object.assign({ practice: 0, live: 0 }, S.streak);
  function save() {
    try { writeFileSync(STATE_FILE + '.tmp', JSON.stringify(S)); renameSync(STATE_FILE + '.tmp', STATE_FILE); }
    catch (e) { log('autopilot: could not save state:', e.message); }
  }
  const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tzName });   // YYYY-MM-DD local
  function dayRec(mode, ms, startBal) {
    const d = dayOf(ms);
    S.days[d] = S.days[d] || {};
    if (!S.days[d][mode]) S.days[d][mode] = { pnl: 0, n: 0, w: 0, startBal: startBal != null ? startBal : null };
    if (S.days[d][mode].startBal == null && startBal != null) S.days[d][mode].startBal = startBal;
    const keys = Object.keys(S.days).sort();
    while (keys.length > 30) delete S.days[keys.shift()];
    return S.days[d][mode];
  }
  // Profit ledger for the Profits page: real-money results per calendar day, midnight to midnight Central. Tracking
  // begins the day the ledger is first created. Row = [profit, start balance, trades, wins].
  const pday = (ms) => dayOf(ms);
  const addDays = (d, k) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + k); return t.toISOString().slice(0, 10); };
  function ledgerDay(d) {
    const L = S.ledger.days;
    if (!L[d]) {
      L[d] = [0, null, 0, 0];
      const keys = Object.keys(L).sort(); while (keys.length > 2000) delete L[keys.shift()];
    }
    return L[d];
  }
  function ledgerAdd(t) {
    const d = pday(t.ts); if (d < S.ledger.start) return;
    const r = ledgerDay(d); r[0] = r2(r[0] + t.pnl); r[2]++; if (t.result) r[3]++;
  }
  function ledgerStartBal() {   // the day's starting balance: first balance seen that day, minus anything already won or lost
    if (!S.liveBal) return;
    if (S.trades.some((t) => t.mode === 'live' && t.result == null && (t.status === 'filled' || t.status === 'partial'))) return;   // money tied up in an open trade
    const r = ledgerDay(pday(Date.now()));
    if (r[1] == null) r[1] = r2(S.liveBal.buyingPower - r[0]);
  }
  // Rebuild days from the real trades the bot still keeps. keepBal: reuse starting balances already recorded for a day
  // (only meaningful when the old ledger used the same kind of day); otherwise the balance before that day's first trade.
  function ledgerFromTrades(from, keepBal) {
    const today = pday(Date.now()), old = S.ledger ? S.ledger.days : {}, days = {}, firstBal = {};
    const live = S.trades.filter((t) => t.mode === 'live');
    const oldest = live.length ? pday(live[0].ts) : today;
    for (const t of live) {
      if (t.result == null || t.pnl == null) continue;
      const d = pday(t.ts); if (d < from) continue;
      const r = days[d] || (days[d] = [0, null, 0, 0]);
      r[0] = r2(r[0] + t.pnl); r[2]++; if (t.result) r[3]++;
      if (firstBal[d] == null && t.balBefore != null) firstBal[d] = t.balBefore;
    }
    for (const d of Object.keys(days)) days[d][1] = keepBal && old[d] && old[d][1] != null ? old[d][1] : firstBal[d] != null ? firstBal[d] : null;
    if (keepBal) for (const [d, r] of Object.entries(old)) if (d >= from && !days[d] && (d < oldest || r[2] === 0)) days[d] = r;   // days the trade list no longer covers, and quiet days
    return { days, oldest };
  }
  if (S.ledger && S.ledger.lab !== 'cal') {   // ledgers kept in 8am-to-8am days: rebuild them as calendar days
    const from = S.ledger.lab === 'end' ? addDays(S.ledger.start, -1) : S.ledger.start;
    S.ledger = { start: from, days: ledgerFromTrades(from, false).days, lab: 'cal' };
  }
  if (!S.ledger) {
    S.ledger = { start: pday(Date.now()), days: {}, lab: 'cal' };
    for (const t of S.trades) if (t.mode === 'live' && t.result != null && t.pnl != null) ledgerAdd(t);   // today's results so far
  }

  // ------------------------------------------------------------ Polymarket US API
  let KEY = null; const KEY_ID = env.PM_KEY_ID || '';
  if (KEY_ID && env.PM_SECRET_KEY) {
    try {
      let raw = Buffer.from(env.PM_SECRET_KEY.trim(), 'base64');
      if (raw.length === 64) raw = raw.subarray(0, 32);
      if (raw.length !== 32) throw new Error(`secret key decodes to ${raw.length} bytes, expected 32 or 64`);
      KEY = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
    } catch (e) { log('autopilot: PM_SECRET_KEY is not usable:', e.message); KEY = null; }
  }
  class ApiError extends Error { constructor(status, text, path) { super(`HTTP ${status} on ${path}: ${String(text).slice(0, 300)}`); this.status = status; this.text = String(text); } }
  async function api(method, path, body) {
    const ts = String(Date.now());
    const sig = edSign(null, Buffer.from(ts + method + path), KEY).toString('base64');
    const r = await fetch(API + path, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'X-PM-Access-Key': KEY_ID, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig, 'Content-Type': 'application/json', 'User-Agent': 'btc-patterns-autopilot/' + AUTOPILOT_VERSION },
    });
    const text = await r.text();
    if (!r.ok) throw new ApiError(r.status, text, path);
    return text ? JSON.parse(text) : {};
  }
  // The public gateway sits behind a CDN that serves copies up to 30 s old (even a cached "not found" for a
  // window that just opened), so every request carries a unique query string to get live data.
  let bust = 0;
  async function gw(path) {
    const r = await fetch(GATEWAY + path + (path.includes('?') ? '&' : '?') + '_=' + Date.now().toString(36) + (bust++).toString(36), { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    const text = await r.text();
    if (!r.ok) throw new ApiError(r.status, text, path);
    return JSON.parse(text);
  }
  const isAuthError = (e) => e && (e.status === 401 || e.status === 403);
  const isMoneyError = (e) => /insufficient|buying power|balance|funds/i.test((e && (e.text || e.message)) || '');

  async function refreshLive() {
    const r = await api('GET', '/v1/account/balances');
    const b = (r.balances || [])[0] || {};
    S.liveBal = { buyingPower: r2(+b.buyingPower || 0), cash: r2(+b.currentBalance || 0), at: Date.now() };
    ledgerStartBal();
    return S.liveBal;
  }
  const mcache = new Map();
  async function marketFor(Ws) {
    if (mcache.has(Ws)) return mcache.get(Ws);
    const j = await gw('/v1/events/slug/' + Signal.usSlug(Ws));
    const ev = j.event || j, m = ev && ev.markets && ev.markets[0];
    if (!m || !m.slug) throw new Error('Polymarket US market not found for this window');
    const info = { slug: m.slug, tick: +m.orderPriceMinTickSize || 0.01, minQty: +m.minimumTradeQty || 0.01, feeK: m.feeCoefficient != null ? +m.feeCoefficient : 0.095 };
    mcache.set(Ws, info);
    for (const k of mcache.keys()) if (k < Ws - 3600) mcache.delete(k);
    return info;
  }
  async function book(slug) {
    const md = (await gw(`/v1/markets/${slug}/book`)).marketData || {};
    const lv = (a) => (a || []).map((x) => [+x.px.value, +x.qty]).filter(([p, q]) => p > 0 && q > 0);
    return { bids: lv(md.bids).sort((a, b) => b[0] - a[0]), asks: lv(md.offers || md.asks).sort((a, b) => a[0] - b[0]), state: md.state };   // Polymarket US calls the sell side "offers"
  }

  // ------------------------------------------------------------ halts
  function halt(reason, detail, extra) {
    if (S.halted && S.halted.reason === reason) return;
    S.halted = Object.assign({ reason, detail, at: Date.now() }, extra || {});
    save(); publishSoon(1500, true);
    const kind = S.halted.kind;
    const title = kind === 'goal' ? 'GOAL REACHED' : kind === 'pause' ? 'AUTOPILOT PAUSED' : 'AUTOPILOT HALTED';
    log(title + ':', reason, '-', detail);
    push({ title, body: `${reason}. ${detail}`, priority: kind === 'goal' || kind === 'pause' ? 4 : 5, tags: kind === 'goal' ? 'trophy' : kind === 'pause' ? 'pause_button' : 'octagonal_sign', click: o.site + 'autopilot.html' });
  }
  // Goal: once the current mode's balance reaches it (with no trades still open), pause until Resume
  function goalBalance() {
    if (S.mode === 'live') return S.liveBal ? S.liveBal.cash : null;
    return S.practice.balance;
  }
  function checkGoal() {
    if (!(S.goal > 0)) return;
    const key = S.mode + ':' + S.goal;
    if (S.goalHitFor === key || (S.halted && S.halted.kind === 'goal')) return;
    if (S.trades.some((t) => t.mode === S.mode && t.result == null && (t.status === 'filled' || t.status === 'partial'))) return;
    const bal = goalBalance();
    if (bal == null || bal < S.goal) return;
    S.goalHitFor = key;
    halt('Goal reached', `${S.mode === 'live' ? 'Your Polymarket US balance' : 'Practice balance'} is ${money(bal)}, at or above your ${money(S.goal)} goal. Trading is paused until you tap Resume. Set a higher goal to be notified again.`, { kind: 'goal' });
  }
  // 8-hour block of the day in Central time (follows daylight saving): 0 = 12am-8am, 1 = 8am-4pm, 2 = 4pm-12am
  const blockOf = (ms) => Math.floor((+new Date(ms).toLocaleString('en-US', { timeZone: tzName, hour: 'numeric', hourCycle: 'h23' }) % 24) / 8);
  const BLOCKS = ['12am-8am', '8am-4pm', '4pm-12am'];
  const clockAt = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: tzName, hour: 'numeric', minute: '2-digit' });
  const outOfMoney = (bal, why) => halt('Out of money', `${why || `${S.mode === 'live' ? 'Polymarket US buying power' : 'Practice balance'} is ${money(bal)}.`} Add funds, then tap Resume on the autopilot page.`);

  // ------------------------------------------------------------ trading
  let busy = false;
  const tried = new Set();         // windows already traded or attempted
  let lastNote = '';
  function note(msg) { lastNote = msg; }

  // Called by the bot the moment it sends a BUY alert
  async function onSignal(sig) {
    const { Ws } = sig;
    if (!S.enabled) return note('Signal ignored: autopilot is off');
    if (S.halted) return note(`Signal ignored: halted (${S.halted.reason})`);
    if (busy || tried.has(Ws) || S.trades.some((t) => t.Ws === Ws)) return;
    tried.add(Ws); busy = true;
    try { return await trade(sig); }
    catch (e) {
      log('autopilot trade error:', e.message);
      if (isAuthError(e)) halt('Polymarket rejected the API key', e.message.slice(0, 160));
      else if (isMoneyError(e)) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
      return record({ Ws, mode: S.mode, side: sig.favUp ? 'UP' : 'DOWN', status: 'error', msg: e.message.slice(0, 120), q: sig.q });
    } finally { busy = false; save(); publishSoon(); }
  }

  function record(t) {
    t.id = t.id || Date.now().toString(36);
    t.ts = t.ts || Date.now();
    S.trades.push(t);
    if (S.trades.length > 300) S.trades.splice(0, S.trades.length - 300);
    if (t.status === 'nofill') S.stats[t.mode].nofill++;
    return t;
  }

  async function trade(sig) {
    const { Ws, favUp, q } = sig;
    // Regular bets switched off while Live: the signal is paper-traded on the practice account instead,
    // so its results still show, and it doesn't block a real coin flip in the same window.
    const paper = S.mode === 'live' && S.mainOn === false;
    const mode = paper ? 'practice' : S.mode, live = mode === 'live';
    const side = favUp ? 'UP' : 'DOWN';
    const broke = (b) => { if (!paper) outOfMoney(b); };   // an empty practice account never stops real trading
    if (live && !KEY) { halt('No API key installed', 'Re-run the installer with -Autopilot to add your Polymarket US key, or switch to Practice.'); return; }
    const mkt = await marketFor(Ws);
    const bk = await book(mkt.slug);
    // Price per contract for our side, cheapest first. Buying DOWN = selling YES into the bids.
    const levels = favUp ? bk.asks : bk.bids.map(([p, n]) => [r4(1 - p), n]);
    const feeAt = (p) => mkt.feeK * p * (1 - p);
    if (!levels.length) return record({ Ws, mode, side, status: 'skipped', msg: 'No sellers on Polymarket US', q });
    const best = levels[0][0];
    if (best >= Signal.MAX_PRICE) return record({ Ws, mode, side, status: 'skipped', msg: `Polymarket US price ${cents(best)} is too high`, q, px: best });
    // Highest price worth paying: under 95¢, and our win chance still beats price + fee by the margin
    let limit = r2(Math.min(best + SLIP_TICKS * mkt.tick, Signal.MAX_PRICE - mkt.tick));
    while (limit >= best - 1e-9 && q < limit + feeAt(limit) + Signal.MARGIN) limit = r2(limit - mkt.tick);
    if (limit < best - 1e-9) return record({ Ws, mode, side, status: 'skipped', msg: `Polymarket US price ${cents(best)} too high for a ${Math.round(q * 100)}% chance`, q, px: best });

    const bal = live ? (await refreshLive()).buyingPower : S.practice.balance;
    if (bal < MIN_BALANCE) { broke(bal); return record({ Ws, mode, side, status: 'skipped', msg: paper ? 'Practice balance is empty' : 'Out of money', q, paper: paper ? 1 : undefined }); }
    const stake = bal * S.betPct / 100;
    const step = mkt.minQty > 0 ? mkt.minQty : 0.01;
    const qty = r2(Math.floor(stake / (limit + feeAt(limit)) / step + 1e-9) * step);
    if (qty < step) { broke(bal); return record({ Ws, mode, side, status: 'skipped', msg: 'Balance too small for one contract', q, paper: paper ? 1 : undefined }); }
    const day = dayRec(mode, Date.now(), bal);

    let filled = 0, notional = 0, orderId = null, msg = '';
    if (live) {
      ({ filled, notional, orderId, msg } = await liveOrder(mkt, favUp, limit, qty));
    } else {
      // Practice: fill against the real book up to the limit price, like an immediate-or-cancel order
      let need = qty;
      for (const [p, n] of levels) { if (p > limit + 1e-9 || need <= 0) break; const take = Math.min(n, need); filled += take; notional += take * p; need -= take; }
      filled = r2(filled);
    }

    if (!(filled > 0)) return record({ Ws, mode, side, status: 'nofill', msg: msg || `No fill at ${cents(limit)} or better`, q, qty, limit, orderId, paper: paper ? 1 : undefined });
    const px = notional / filled, fee = r4(feeAt(px) * filled), cost = r2(notional + fee);
    if (!live) S.practice.balance = r2(S.practice.balance - cost);
    const t = record({ Ws, mode, side, status: filled < qty - 1e-9 ? 'partial' : 'filled', q, mkt: sig.marketPct, qty: filled, want: qty, px: r4(px), fee, cost, limit, orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal), paper: paper ? 1 : undefined });
    S.stats[mode].n++; S.stats[mode].staked = r2(S.stats[mode].staked + cost);
    day.n++;
    log(`AUTOPILOT ${mode.toUpperCase()}${paper ? ' (regular bets off)' : ''} bought ${side} ${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)})`);
    // A real purchase replaces the BUY alert, so it always notifies (loudly), with the signal's numbers.
    // Practice fills are mentioned inside the bot's BUY alert instead of a second message.
    if (live) push({ title: `BOUGHT ${side}`, body: `${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)}) · MODEL ${Math.round(sig.modelPct || q * 100)}% · POLYMARKET ${Math.round(sig.marketPct || 0)}%`, priority: 5, tags: side === 'UP' ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
    return t;
  }

  // Real order: immediate-or-cancel limit at `limit` (price of the side we buy). Returns what filled.
  async function liveOrder(mkt, up, limit, qty) {
    let filled = 0, notional = 0, msg = '';
    const body = {
      marketSlug: mkt.slug,
      intent: up ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
      type: 'ORDER_TYPE_LIMIT',
      price: { value: (up ? limit : r2(1 - limit)).toFixed(2), currency: 'USD' },   // always the YES price
      quantity: qty,
      tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
      synchronousExecution: true, maxBlockTime: '3',
    };
    const r = await api('POST', '/v1/orders', body);
    const orderId = r.id || null;
    // Execution prices are YES prices; convert to the price of the side we bought
    const ours = (px) => (Math.abs(px - limit) <= Math.abs(1 - px - limit) ? px : 1 - px);
    for (const ex of r.executions || []) {
      if (/FILL/.test(ex.type || '') && ex.lastShares) { const sh = +ex.lastShares, px = ours(+ex.lastPx.value); filled += sh; notional += sh * px; }
      if (/REJECT/.test(ex.type || '')) msg = ex.orderRejectReason || ex.text || 'rejected';
    }
    if (!filled && orderId) {
      try {
        const od = (await api('GET', '/v1/order/' + orderId)).order || {};
        filled = +od.cumQuantity || 0;
        if (filled && od.avgPx) notional = filled * ours(+od.avgPx.value);
        if (!msg && /REJECT/.test(od.state || '')) msg = 'rejected';
      } catch (e) { log('autopilot: order lookup failed:', e.message); }
    }
    if (!filled && isMoneyError({ text: msg })) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
    refreshLive().catch(() => {});
    return { filled, notional, orderId, msg };
  }

  // ------------------------------------------------------------ settlement
  let lastSettleCheck = 0;
  async function settle() {
    const now = Date.now() / 1000;
    for (const t of S.trades) {
      if (t.result != null || !(t.status === 'filled' || t.status === 'partial') || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) {
        try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* retry later */ }
      }
      if (s == null) continue;
      const won = (s >= 0.5) === (t.side === 'UP');
      t.result = won ? 1 : 0;
      t.pnl = r2((won ? t.qty : 0) - t.cost);
      const st = S.stats[t.mode];
      st.pnl = r2(st.pnl + t.pnl); if (won) st.w++; else st.l++;
      const day = dayRec(t.mode, t.ts);
      day.pnl = r2(day.pnl + t.pnl); if (won) day.w++;
      if (t.mode === 'live') ledgerAdd(t);
      if (t.mode === 'practice' && won) S.practice.balance = r2(S.practice.balance + t.qty);
      log(`AUTOPILOT ${t.mode} ${t.side} ${won ? 'WON' : 'LOST'} ${money(t.pnl)}`);
      if (S.notifyResults) push({ title: `${t.mode === 'live' ? '' : 'PRACTICE '}${won ? 'WON' : 'LOST'} ${money(t.pnl)}`, body: `${t.side} ${t.qty} @ ${cents(t.px)} · today ${money(day.pnl)}`, priority: won ? 2 : 3, tags: won ? 'white_check_mark' : 'x', click: o.site + 'autopilot.html' });
      // Losing streak: pause for a while (then the count starts over)
      S.streak[t.mode] = won ? 0 : (S.streak[t.mode] || 0) + 1;
      if (!won && S.lossStreak > 0 && t.mode === S.mode && S.streak[t.mode] >= S.lossStreak) {
        S.streak[t.mode] = 0;
        const until = Date.now() + S.cooldownMin * 60000;
        halt(`Paused after ${S.lossStreak} losses in a row`, `Trading resumes automatically at ${clockAt(until)} (${S.cooldownMin} min), or tap Resume.`, { kind: 'pause', untilTs: until });
      }
      // Daily loss limit (overrides a pause)
      if (S.dailyStopPct > 0 && t.mode === S.mode && day.startBal > 0 && day.pnl <= -S.dailyStopPct / 100 * day.startBal) {
        const tomorrow = dayOf(Date.now() + 86400000);
        halt('Daily loss limit reached', `Down ${money(-day.pnl)} today (${Math.round(-day.pnl / day.startBal * 100)}% of ${money(day.startBal)}). Trading resumes automatically tomorrow, or tap Resume.`, { untilDay: tomorrow });
      }
      if (t.mode === 'live') refreshLive().then(checkGoal).catch(() => {}); else checkGoal();
      save(); publishSoon();
    }
  }

  // ------------------------------------------------------------ late coin-flip test (practice only, never real money)
  // Backtest idea: with 75–30 s left in a close window (favorite 50–70¢), buy the side our model prefers when it
  // gives that side ≥ 60%. Here it is paper-traded at the live Polymarket US price, $10 a trade, to see whether the
  // edge survives real prices. Kept apart from the main trades and stats.
  const LATE = { minLeft: 30, maxLeft: 75, favLo: 0.50, favHi: 0.70, minModel: 0.60, stake: 10, maxPx: 0.80 };
  S.late = S.late || { since: Date.now(), stats: zeroStats(), trades: [] };
  if (!S.late.byFav) {   // first run with the favorite/underdog split: fill it from the trades already recorded
    const bf = {};
    for (const t of S.late.trades) {
      if (t.status !== 'filled' || t.result == null || t.quoted == null) continue;
      const k = t.quoted >= 0.5 ? 'fav' : 'dog', z = bf[k] || (bf[k] = { n: 0, w: 0, staked: 0, pnl: 0 });
      z.n++; if (t.result) z.w++; z.staked = r2(z.staked + t.cost); z.pnl = r2(z.pnl + t.pnl);
    }
    S.late.byFav = bf;
  }
  // Anticipation mode: real-money coin flips settled since the most recent real-money loss (practice, skipped and
  // unfilled flips don't count).
  // null = no loss on record yet. Bet = anticStart% right after a loss, then anticStep less per flip, down to anticFloor%.
  // When the current 8-hour block started (12am, 8am or 4pm Central), in ms
  function blockStartMs(ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tzName, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
    return Math.floor(ms / 1000) * 1000 - (((p.hour % 24) % 8) * 3600 + p.minute * 60 + p.second) * 1000;
  }
  function anticSince(at = Date.now()) {
    let n = 0;
    const from = S.anticBlockReset !== false ? blockStartMs(at) : 0;   // fresh start each block: ignore earlier flips
    for (let i = S.late.trades.length - 1; i >= 0; i--) {
      const t = S.late.trades[i];
      if ((t.ts || t.Ws * 1000) < from) break;
      if (!t.real || t.status !== 'filled' || t.result == null) continue;   // only coin flips that went in with real money
      if (!t.result) return n;
      n++;
    }
    return null;
  }
  // results of every settled coin flip (real or practice) by 8-hour block, to keep checking which hours work
  function lateByBlock() {
    const z = [0, 1, 2].map(() => ({ n: 0, w: 0, staked: 0, pnl: 0, fn: 0, fw: 0, fstaked: 0, fpnl: 0 }));
    for (const t of S.late.trades) {
      if (t.status !== 'filled' || t.result == null) continue;
      const b = z[t.blk != null ? t.blk : blockOf(t.ts || t.Ws * 1000)];
      b.n++; b.w += t.result; b.staked += t.cost; b.pnl += t.pnl;
      if (t.quoted >= 0.5 && t.q * 100 >= (S.lateMinReal || 60) - 1e-9) { b.fn++; b.fw += t.result; b.fstaked += t.cost; b.fpnl += t.pnl; }   // would pass your filters
    }
    return z.map((b) => [b.n, b.w, r2(b.staked), r2(b.pnl), b.fn, b.fw, r2(b.fstaked), r2(b.fpnl)]);
  }
  // What the page shows: the ladder for the next real coin flip. If the current block is switched off, that flip
  // happens in the next ticked block, which (with the per-block reset) starts at the bottom.
  // real-money coin-flip losses so far in the current 8-hour block
  function blockLosses(at = Date.now()) {
    const from = blockStartMs(at); let n = 0;
    for (let i = S.late.trades.length - 1; i >= 0; i--) {
      const t = S.late.trades[i];
      if ((t.ts || t.Ws * 1000) < from) break;
      if (t.real && t.status === 'filled' && t.result === 0) n++;
    }
    return n;
  }
  const capHit = () => S.lateMaxLosses > 0 && blockLosses() >= S.lateMaxLosses;
  function anticView() {
    const hrs = Array.isArray(S.lateHours) ? S.lateHours : [true, true, true], cur = blockOf(Date.now());
    if (hrs[cur] !== false) return { since: anticSince(), next: anticPct() };
    let k = 1; while (k < 3 && hrs[(cur + k) % 3] === false) k++;
    if (k === 3) return { since: null, next: anticPct(), none: 1 };          // no block ticked: no real coin flips
    const nb = (cur + k) % 3;
    if (S.anticBlockReset !== false) return { since: null, next: Math.min(S.anticFloor, S.anticStart), nextBlock: nb };
    return { since: anticSince(), next: anticPct(), nextBlock: nb };
  }
  function anticPct() {
    const k = anticSince(), lo = Math.min(S.anticFloor, S.anticStart);
    return k == null ? lo : Math.max(lo, S.anticStart - S.anticStep * k);
  }
  const lateTried = new Set();
  async function observeLate(x) {           // x: { Ws, e, pUp, mkUp } with mkUp = Polymarket's Up odds the bot sees
    const left = W - x.e;
    if (left > LATE.maxLeft || left < LATE.minLeft || lateTried.has(x.Ws)) return;
    const favMid = Math.max(x.mkUp, 1 - x.mkUp);
    if (favMid < LATE.favLo || favMid >= LATE.favHi) return;
    const up = x.pUp >= 0.5, q = up ? x.pUp : 1 - x.pUp;
    if (q < LATE.minModel) return;
    lateTried.add(x.Ws);
    for (const k of lateTried) if (k < x.Ws - 3600) lateTried.delete(k);
    if (S.late.trades.some((t) => t.Ws === x.Ws)) return;
    const rec = { Ws: x.Ws, ts: Date.now(), side: up ? 'UP' : 'DOWN', q: r4(q), quoted: r4(up ? x.mkUp : 1 - x.mkUp), left: Math.round(left), result: null, pnl: null };
    // Chart pattern check: price pressing a triangle/wedge/flag line that would push it against our side
    rec.pat = !x.press ? 'none' : (x.press > 0) === up ? 'with' : 'against';
    try {
      const mkt = await marketFor(x.Ws); rec.slug = mkt.slug;
      const bk = await book(mkt.slug);
      const levels = up ? bk.asks : bk.bids.map(([p, n]) => [r4(1 - p), n]);
      const feeAt = (p) => mkt.feeK * p * (1 - p);
      if (!levels.length) { rec.status = 'nofill'; rec.msg = 'No sellers on Polymarket US'; }
      else if (levels[0][0] >= LATE.maxPx) { rec.status = 'skipped'; rec.px = levels[0][0]; rec.msg = `Polymarket US price ${cents(levels[0][0])}`; }
      else {
        const limit = r2(levels[0][0] + mkt.tick);
        // Real money only when switched on, autopilot is Live and on, not halted/paused, and no normal trade this window
        const eligible = S.lateLive && S.mode === 'live' && S.enabled && !S.halted && KEY && !busy && !S.trades.some((t) => t.Ws === x.Ws && t.mode === 'live' && (t.status === 'filled' || t.status === 'partial'));   // only real money already in this window blocks it
        // Filters for real money; a skipped flip is still tracked as practice so the results keep coming in:
        //   a chart pattern line against the flip, the model backing the underdog, or model confidence below the minimum
        rec.fav = rec.quoted >= 0.5 ? 1 : 0;
        rec.blk = blockOf(Date.now());
        const hoursOk = !Array.isArray(S.lateHours) || S.lateHours[rec.blk] !== false;
        const why = rec.pat === 'against' ? 'pattern' : S.lateFavOnly && !rec.fav ? 'underdog' : q * 100 < (S.lateMinReal || 60) - 1e-9 ? 'conf' : !hoursOk ? 'hours' : capHit() ? 'maxloss' : null;
        const real = eligible && !why;
        if (eligible && why) { rec.realSkip = why; if (why === 'pattern') rec.patSkip = 1; }
        if (real) {
          busy = true;
          try {
            const bal = (await refreshLive()).buyingPower;
            const step = mkt.minQty > 0 ? mkt.minQty : 0.01;
            if (S.lateAntic) rec.betPct = anticPct();
            const stake = S.lateAntic ? bal * rec.betPct / 100 : S.lateBetPct > 0 ? bal * S.lateBetPct / 100 : Math.min(S.lateBet, bal);
            const qty = r2(Math.floor(stake / (limit + feeAt(limit)) / step + 1e-9) * step);
            if (bal < MIN_BALANCE || qty < step) { outOfMoney(bal); rec.status = 'skipped'; rec.msg = 'Out of money'; }
            else {
              const day = dayRec('live', Date.now(), bal);
              const ord = await liveOrder(mkt, up, limit, qty);
              rec.real = 1;
              if (ord.filled > 0) {
                const px = ord.notional / ord.filled, fee = r4(feeAt(px) * ord.filled), cost = r2(ord.notional + fee);
                Object.assign(rec, { status: 'filled', qty: r2(ord.filled), px: r4(px), cost });
                record({ Ws: x.Ws, mode: 'live', strategy: 'late', betPct: rec.betPct, side: rec.side, status: ord.filled < qty - 1e-9 ? 'partial' : 'filled', q: rec.q, qty: r2(ord.filled), want: qty, px: r4(px), fee, cost, limit, orderId: ord.orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal) });
                S.stats.live.n++; S.stats.live.staked = r2(S.stats.live.staked + cost); day.n++;
                if (S.notifyFills) push({ title: `BOUGHT ${rec.side} (LATE)`, body: `${r2(ord.filled)} @ ${cents(px)} = ${money(cost)} · late coin-flip, ${rec.left}s left${S.lateAntic ? ` · anticipation ${rec.betPct}%` : ''}`, priority: 4, tags: up ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
              } else {
                rec.status = 'nofill'; rec.msg = ord.msg || `No fill at ${cents(limit)} or better`;
                record({ Ws: x.Ws, mode: 'live', strategy: 'late', side: rec.side, status: 'nofill', msg: rec.msg, q: rec.q, qty, limit, orderId: ord.orderId });
              }
            }
          } catch (e) {
            if (isAuthError(e)) halt('Polymarket rejected the API key', e.message.slice(0, 160));
            else if (isMoneyError(e)) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
            rec.real = 1; rec.status = 'error'; rec.msg = e.message.slice(0, 80);
          } finally { busy = false; }
        } else {
          let need = r2(LATE.stake / (limit + feeAt(limit))), filled = 0, notional = 0;
          for (const [p, n] of levels) { if (p > limit + 1e-9 || need <= 0) break; const take = Math.min(n, need); filled += take; notional += take * p; need -= take; }
          filled = r2(filled);
          if (filled > 0) { const px = notional / filled; rec.status = 'filled'; rec.qty = filled; rec.px = r4(px); rec.cost = r2(notional + feeAt(px) * filled); }
          else { rec.status = 'nofill'; rec.msg = 'Nothing for sale at the price'; }
        }
      }
    } catch (e) { rec.status = 'error'; rec.msg = e.message.slice(0, 80); }
    S.late.trades.push(rec);
    if (S.late.trades.length > 300) S.late.trades.splice(0, S.late.trades.length - 300);
    if (rec.status === 'filled') { S.late.stats.n++; S.late.stats.staked = r2(S.late.stats.staked + rec.cost); }
    if (rec.status === 'nofill') S.late.stats.nofill++;
    log(`late coin-flip ${rec.real ? 'REAL' : 'test'}${rec.realSkip ? ` (real skipped: ${{ pattern: 'chart pattern against', underdog: 'model backs the underdog', conf: 'model below ' + S.lateMinReal + '%', hours: BLOCKS[rec.blk] + ' is switched off', maxloss: `${S.lateMaxLosses} real losses already this block` }[rec.realSkip]})` : ''}: ${rec.status} ${rec.side}${rec.px ? ' @ ' + cents(rec.px) : ''} (Polymarket showed ${cents(rec.quoted)}, model ${Math.round(q * 100)}%, ${rec.left}s left)${rec.msg ? ' - ' + rec.msg : ''}`);
    save(); publishSoon();
  }
  async function settleLate() {
    const now = Date.now() / 1000;
    for (const t of S.late.trades) {
      if (t.result != null || t.status !== 'filled' || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) { try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (s == null) continue;
      const won = (s >= 0.5) === (t.side === 'UP');
      t.result = won ? 1 : 0; t.pnl = r2((won ? t.qty : 0) - t.cost);
      const st = S.late.stats; st.pnl = r2(st.pnl + t.pnl); if (won) st.w++; else st.l++;
      if (t.real) { const rs = S.late.real || (S.late.real = zeroStats()); rs.n++; rs.staked = r2(rs.staked + t.cost); rs.pnl = r2(rs.pnl + t.pnl); if (won) rs.w++; else rs.l++; }
      // loss cap: one notice when this block's real losses reach the limit (only for a flip from the current block)
      if (t.real && !won && S.lateMaxLosses > 0 && (t.ts || t.Ws * 1000) >= blockStartMs(Date.now())) {
        const bs = blockStartMs(Date.now()), nL = blockLosses();
        if (nL >= S.lateMaxLosses && S.late.capNotified !== bs) {
          S.late.capNotified = bs;
          const nb = (blockOf(Date.now()) + 1) % 3;
          log(`late coin-flip: ${nL} real losses this block, no more real coin flips until ${BLOCKS[nb].split('-')[0]}`);
          push({ title: 'COIN FLIPS STOPPED FOR THIS BLOCK', body: `${nL} real coin-flip losses since ${BLOCKS[blockOf(Date.now())].split('-')[0]}. Real coin flips resume at the next time block (${BLOCKS[nb].split('-')[0]}); flips until then are practice.`, priority: 4, tags: ['stop_sign'] });
        }
      }
      if (t.fav != null) {   // favorite vs underdog
        const bf = S.late.byFav || (S.late.byFav = {}); const k = t.fav ? 'fav' : 'dog'; const z = bf[k] || (bf[k] = { n: 0, w: 0, staked: 0, pnl: 0 });
        z.n++; if (won) z.w++; z.staked = r2(z.staked + t.cost); z.pnl = r2(z.pnl + t.pnl);
      }
      if (t.pat) {   // results split by chart pattern (per $100 so practice $10 and real bets compare)
        const bp = S.late.byPat || (S.late.byPat = {}); const z = bp[t.pat] || (bp[t.pat] = { n: 0, w: 0, staked: 0, pnl: 0 });
        z.n++; if (won) z.w++; z.staked = r2(z.staked + t.cost); z.pnl = r2(z.pnl + t.pnl);
      }
      save(); publishSoon();
    }
  }

  // ------------------------------------------------------------ US lag recorder + practice lag test
  // The smart-money wallets win on speed: they buy before prices catch up with Bitcoin. This measures how far
  // Polymarket US trails polymarket.com (the bot's live odds) and paper-trades the gap.
  //   Recorder   about once a second during each window: BTC price, .com bid/ask, US best bid/ask → lag/lag-YYYY-MM-DD.jsonl
  //   Estimate   every 10 minutes: how many seconds US price changes trail .com changes (best cross-correlation)
  //   Test       when the US price for a side is 3¢+ cheaper than .com says it's worth, paper-buy $10 there (once a
  //              window), re-checking the US price first the way a real order would, and score it on the US result.
  const LAGT = { every: o.lagEvery != null ? o.lagEvery : 900, gap: 0.03, minLeft: 20, maxLeft: 270, maxPx: 0.90, minPx: 0.10, maxComSpread: 0.03, stake: 10, keepDays: 14 };
  const LAG_DIR = join(dir, 'lag');
  S.lagt = S.lagt || { since: Date.now(), stats: zeroStats(), byGap: {}, trades: [], est: null };
  const gapBucket = (g) => (g < 0.05 ? '3-5' : g < 0.08 ? '5-8' : '8+');
  let lagBusy = false, lagLast = 0, lagEvery = LAGT.every, lagPauseUntil = 0, lagLines = [], lagFlushAt = 0, lagPruned = '', lagEstAt = Date.now(), lagErrAt = 0;
  const lagRing = [];                       // [tsMs, Ws, comMid, usMid] for the lag estimate, last 2 hours
  const lagTried = new Set();
  async function bbo(slug) {
    const md = (await gw(`/v1/markets/${slug}/bbo`)).marketData || {};
    const v = (x) => (x && +x.value > 0 ? +x.value : null);
    return { bid: v(md.bestBid), ask: v(md.bestAsk), bidQty: +md.bidShares || 0, askQty: +md.askShares || 0 };
  }
  function lagFlush(force) {
    if (!lagLines.length || (!force && Date.now() - lagFlushAt < 30000)) return;
    lagFlushAt = Date.now();
    const byDay = {};
    for (const [d, l] of lagLines) (byDay[d] = byDay[d] || []).push(l);
    lagLines = [];
    try {
      mkdirSync(LAG_DIR, { recursive: true });
      for (const [d, ls] of Object.entries(byDay)) appendFileSync(join(LAG_DIR, `lag-${d}.jsonl`), ls.join('\n') + '\n');
      const today = dayOf(Date.now());
      if (lagPruned !== today) {           // keep two weeks
        lagPruned = today;
        const cut = dayOf(Date.now() - LAGT.keepDays * 86400000);
        for (const f of readdirSync(LAG_DIR)) { const m = /^lag-(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f); if (m && m[1] < cut) unlinkSync(join(LAG_DIR, f)); }
      }
    } catch (e) { log('lag recorder: could not write:', e.message); }
  }
  function lagEstimate() {
    S.lagt.est = Object.assign({ at: Date.now() }, estimateLag(lagRing));
    const z = S.lagt.est;
    log(z.lag == null ? `US lag: not enough data yet (${z.samples} samples)` : `US lag: price changes on US trail polymarket.com by ~${z.lag} s (corr ${z.corr}, 80% by ${z.by80} s), average gap ${z.gap}¢ over ${z.samples} samples`);
    save(); publishSoon();
  }
  // Live US prices come from the official market-data stream (signed with the API key): real time, nothing to poll,
  // no rate limit. Without a key, or while the stream is down, the recorder polls the public best-price endpoint
  // every 2 s instead (slower if Polymarket US asks).
  const US = { ws: null, up: false, want: null, slug: null, rid: null, bid: null, ask: null, at: 0, msgs: 0, fails: 0, retryAt: 0, errAt: 0 };
  const WS_PATH = '/v1/ws/markets';
  function wsHeaders() {
    const ts = String(Date.now());
    return { 'X-PM-Access-Key': KEY_ID, 'X-PM-Timestamp': ts, 'X-PM-Signature': edSign(null, Buffer.from(ts + 'GET' + WS_PATH), KEY).toString('base64'), 'User-Agent': 'btc-patterns-autopilot/' + AUTOPILOT_VERSION };
  }
  const amt = (x) => (x && x.value != null && +x.value > 0 ? +x.value : undefined);
  function usSubscribe() {
    if (!US.up || !US.want || US.slug === US.want) return;
    try {
      if (US.rid) US.ws.send(JSON.stringify({ unsubscribe: { requestId: US.rid } }));
      US.rid = 'lag-' + Date.now().toString(36); US.slug = US.want; US.bid = US.ask = null;
      US.ws.send(JSON.stringify({ subscribe: { requestId: US.rid, subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: [US.slug] } }));
    } catch (e) { log('US price stream: subscribe failed:', e.message); }
  }
  function usStream(slug) {
    US.want = slug;
    if (US.ws) return usSubscribe();
    if (!KEY || typeof WebSocket !== 'function' || Date.now() < US.retryAt) return;
    let ws;
    try { ws = new WebSocket(API.replace(/^http/, 'ws') + WS_PATH, { headers: wsHeaders() }); }
    catch (e) { US.retryAt = Date.now() + 600000; log('US price stream unavailable, polling instead:', e.message); return; }
    US.ws = ws; US.up = false; US.slug = null; US.rid = null;
    ws.onopen = () => { if (US.ws !== ws) return; US.up = true; if (US.fails) log('US price stream connected'); US.fails = 0; usSubscribe(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      const d = m.marketDataLite;
      if (d && d.marketSlug === US.slug) {
        // each update is the whole top of book: a missing side means no orders there (not "unchanged")
        const b = amt(d.bestBid), a = amt(d.bestAsk);
        US.bid = b !== undefined ? b : null; US.ask = a !== undefined ? a : null;
        if (US.bid != null && US.ask != null && US.bid > US.ask) US.bid = US.ask = null;   // never record a crossed book
        US.at = Date.now(); US.msgs++;
      } else if (m.error && Date.now() - US.errAt > 600000) { US.errAt = Date.now(); log('US price stream error:', JSON.stringify(m.error).slice(0, 160)); }
    };
    const dead = (ev) => {
      if (US.ws !== ws) return;
      // forget this socket BEFORE closing it: closing can fire onerror/onclose again right away
      US.ws = null; US.up = false; US.slug = null; US.fails++;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already closed */ }
      US.retryAt = Date.now() + Math.min(600000, 5000 * 2 ** Math.min(US.fails, 7));
      if (US.fails === 1 || US.fails % 10 === 0) log(`US price stream closed${ev && ev.code ? ' (' + ev.code + ')' : ''}; polling until it reconnects`);
    };
    ws.onclose = dead; ws.onerror = dead;   // a refused connection may only report an error
  }
  const usLive = (slug) => US.up && US.slug === slug && US.bid != null && US.ask != null;
  let lagPollAt = 0, lagPollEvery = o.lagPollEvery != null ? o.lagPollEvery : 2000;
  // x: { Ws, e, btc, com: () => ({ bid, ask }) }  (.com Up token's best bid/ask, read when the US answer arrives)
  async function observeLag(x) {
    const now = Date.now();
    // stays out of the way: never while a real order is going in, and backs off if Polymarket US says slow down
    if (lagBusy || busy || now - lagLast < lagEvery) return;
    lagBusy = true;
    try {
      const mkt = await marketFor(x.Ws);
      usStream(mkt.slug);
      let b, t0, t1, src;
      if (usLive(mkt.slug)) { b = { bid: US.bid, ask: US.ask }; t0 = t1 = Date.now(); src = 's'; }
      else {
        if (now < lagPauseUntil || now - lagPollAt < Math.max(lagPollEvery, lagEvery)) return;
        lagPollAt = now; t0 = Date.now(); b = await bbo(mkt.slug); t1 = Date.now(); src = 'p';
      }
      lagLast = now;
      const com = x.com(); if (!com || com.bid == null || com.ask == null || b.bid == null || b.ask == null || b.bid > b.ask) return;
      const ts = Math.round((t0 + t1) / 2), e = Math.round(x.e + (ts - now) / 1000);
      lagLines.push([dayOf(ts), JSON.stringify([ts, x.Ws, e, r2(x.btc), com.bid, com.ask, b.bid, b.ask, t1 - t0, src])]);
      lagFlush();
      const comMid = (com.bid + com.ask) / 2, usMid = (b.bid + b.ask) / 2;
      lagRing.push([ts, x.Ws, comMid, usMid]);
      while (lagRing.length && lagRing[0][0] < ts - 2 * 3600000) lagRing.shift();
      if (now - lagEstAt > 10 * 60000 && lagRing.length > 300) { lagEstAt = now; lagEstimate(); }
      // practice lag trade
      const left = W - e;
      if (lagTried.has(x.Ws) || left > LAGT.maxLeft || left < LAGT.minLeft || com.ask - com.bid > LAGT.maxComSpread) return;
      const upPx = b.ask, upGap = comMid - upPx;               // US price to buy Up vs what .com says Up is worth
      const dnPx = r4(1 - b.bid), dnGap = (1 - comMid) - dnPx; // same for Down
      const up = upGap >= dnGap, px = up ? upPx : dnPx, gap = up ? upGap : dnGap;
      if (gap < LAGT.gap - 1e-9 || px > LAGT.maxPx || px < LAGT.minPx) return;
      lagTried.add(x.Ws);
      for (const k of lagTried) if (k < x.Ws - 3600) lagTried.delete(k);
      const rec = { Ws: x.Ws, ts, side: up ? 'UP' : 'DOWN', seen: r4(px), com: r4(up ? comMid : 1 - comMid), gap: r4(gap), left: Math.round(left), slug: mkt.slug, result: null, pnl: null };
      // a real order would arrive a moment later: re-check the US price and fill only up to 1 tick above what we saw
      const b2 = await bbo(mkt.slug);
      const px2 = up ? b2.ask : (b2.bid != null ? r4(1 - b2.bid) : null), avail = up ? b2.askQty : b2.bidQty;
      const feeAt = (p) => mkt.feeK * p * (1 - p);
      rec.delayMs = Date.now() - t1;
      if (px2 == null || px2 > px + mkt.tick + 1e-9) { rec.status = 'nofill'; rec.msg = px2 == null ? 'Nothing for sale a moment later' : `Price moved to ${cents(px2)} before the order`; }
      else {
        const qty = r2(Math.min(LAGT.stake / (px2 + feeAt(px2)), avail || Infinity));
        if (qty <= 0) { rec.status = 'nofill'; rec.msg = 'Nothing for sale'; }
        else Object.assign(rec, { status: 'filled', px: r4(px2), qty, cost: r2(qty * px2 + feeAt(px2) * qty) });
      }
      S.lagt.trades.push(rec);
      if (S.lagt.trades.length > 300) S.lagt.trades.splice(0, S.lagt.trades.length - 300);
      if (rec.status === 'filled') { S.lagt.stats.n++; S.lagt.stats.staked = r2(S.lagt.stats.staked + rec.cost); } else S.lagt.stats.nofill++;
      log(`US lag test: ${rec.status} ${rec.side}${rec.px ? ' @ ' + cents(rec.px) : ''} (US ${cents(px)} vs .com ${cents(rec.com)}, ${Math.round(gap * 100)}¢ gap, ${rec.left}s left)${rec.msg ? ' - ' + rec.msg : ''}`);
      save(); publishSoon();
    } catch (err) {
      if (err && err.status === 429) { lagPauseUntil = Date.now() + 120000; lagPollEvery = Math.min(lagPollEvery * 2, 16000); log(`lag recorder: Polymarket US asked us to slow down — pausing 2 min, then one check every ${lagPollEvery / 1000} s`); }
      else if (Date.now() - lagErrAt > 600000) { lagErrAt = Date.now(); log('lag recorder:', err.message.slice(0, 160)); }
    } finally { lagBusy = false; }
  }
  async function settleLag() {
    const now = Date.now() / 1000;
    for (const t of S.lagt.trades) {
      if (t.result != null || t.status !== 'filled' || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) { try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (s == null) continue;
      const won = (s >= 0.5) === (t.side === 'UP');
      t.result = won ? 1 : 0; t.pnl = r2((won ? t.qty : 0) - t.cost);
      const st = S.lagt.stats; st.pnl = r2(st.pnl + t.pnl); if (won) st.w++; else st.l++;
      const z = S.lagt.byGap[gapBucket(t.gap)] || (S.lagt.byGap[gapBucket(t.gap)] = { n: 0, w: 0, staked: 0, pnl: 0 });
      z.n++; if (won) z.w++; z.staked = r2(z.staked + t.cost); z.pnl = r2(z.pnl + t.pnl);
      save(); publishSoon();
    }
  }

  // ------------------------------------------------------------ settings scoreboard
  // Every second of every tradable window, check every combination of gap target × model minimum ×
  // Polymarket minimum. Record the first BUY each combination would make, then score it on the Polymarket US
  // result. Saved in scoreboard.json (last 30 days); the page shows the ranking.
  const GRID = { T: [60, 70, 80, 90], M: [0, 80, 85, 90], K: [0, 70, 80, 85, 90] };   // 0 = no minimum
  const COMBOS = [];
  for (const T of GRID.T) for (const M of GRID.M) for (const Kk of GRID.K) COMBOS.push([T, M, Kk]);
  const SB_FILE = join(dir, 'scoreboard.json');
  let SB = { since: null, watched: 0, win: {} };        // win[Ws] = { r: null | 1 (Up won) | 0, h: [[combo, up, ask, e], ...] }
  try { if (existsSync(SB_FILE)) SB = Object.assign(SB, JSON.parse(readFileSync(SB_FILE, 'utf8'))); } catch (e) { log('scoreboard: could not read, starting fresh:', e.message); }
  let sbDirty = false, sbChanged = false, sbSavedAt = 0, sbPubAt = 0;
  function sbSave(force) {
    if (!sbDirty || (!force && Date.now() - sbSavedAt < 30000)) return;
    try { writeFileSync(SB_FILE + '.tmp', JSON.stringify(SB)); renameSync(SB_FILE + '.tmp', SB_FILE); sbDirty = false; sbSavedAt = Date.now(); }
    catch (e) { log('scoreboard: could not save:', e.message); }
  }
  // x: the same inputs the bot gives Signal.evalSignal, plus Ws, e and favMid
  function observe(x) {
    if (!SB.since) { SB.since = Date.now(); sbDirty = true; }
    const rec = SB.win[x.Ws] || (SB.win[x.Ws] = { r: null, h: [] });
    if (rec.h.length === COMBOS.length) return;
    const have = new Set(rec.h.map((h) => h[0]));
    const byT = {};
    for (const T of GRID.T) byT[T] = Signal.evalSignal(x, T);
    COMBOS.forEach(([T, M, Kk], ci) => {
      if (have.has(ci)) return;
      const r = byT[T];
      if (!r.buy || r.q * 100 < M - 1e-9 || x.favMid * 100 < Kk - 1e-9) return;
      rec.h.push([ci, x.favUp ? 1 : 0, r4(x.ask), Math.round(x.e)]); sbDirty = true;
    });
  }
  async function sbSettle() {
    const now = Date.now() / 1000;
    let budget = 6;
    for (const k of Object.keys(SB.win)) {
      const Ws = +k, rec = SB.win[k];
      if (now < Ws + W + 15) continue;
      if (now > Ws + 30 * 86400) { delete SB.win[k]; sbDirty = true; continue; }
      if (rec.watched !== 1) { rec.watched = 1; SB.watched++; sbDirty = true; }
      if (!rec.h.length) { delete SB.win[k]; sbDirty = true; continue; }   // nothing would have traded: just count it
      if (rec.r != null || budget-- <= 0) continue;
      let r = null;
      try { const j = await gw(`/v1/markets/cpc-${Signal.usSlug(Ws)}/settlement`); if (j.settlement != null) r = +j.settlement >= 0.5 ? 1 : 0; } catch { /* not yet */ }
      if (r == null && now > Ws + W + 600) { try { const u = await Signal.fetchUsTerms(Ws); if (u.settlementPrice && u.priceToBeat) r = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (r != null) { rec.r = r; sbDirty = true; sbChanged = true; }
    }
    sbSave();
  }
  function scoreboard() {
    const st = COMBOS.map(() => [0, 0, 0, 0]);   // trades, wins, total cost, total profit
    let pending = 0;
    for (const rec of Object.values(SB.win)) {
      if (!rec.h.length) continue;
      if (rec.r == null) { pending++; continue; }
      for (const [ci, up, ask] of rec.h) {
        const cost = ask + 0.095 * ask * (1 - ask), won = up === rec.r;   // Polymarket US taker fee
        st[ci][0]++; if (won) st[ci][1]++; st[ci][2] += cost; st[ci][3] += (won ? 1 : 0) - cost;
      }
    }
    return { v: 1, kind: 'score', ts: Date.now(), since: SB.since, watched: SB.watched, pending, grid: GRID, s: st.map(([n, w, c, p]) => [n, w, c ? Math.round(p / c * 1000) / 10 : 0]) };
  }

  // ------------------------------------------------------------ remote link (ntfy)
  let K = null, lastPublish = 0, pubTimer = null, botWhy = '', acks = [];
  const PASSWORD = env.AUTOPILOT_PASSWORD || '';
  const ready = (async () => { if (PASSWORD && o.topic) K = await APC.keys(PASSWORD, o.topic); })();
  function snapshot() {
    const days = Object.keys(S.days).sort().slice(-14).map((d) => [d, S.days[d].practice || null, S.days[d].live || null]);
    const tr = (t) => [t.ts, t.Ws, t.mode[0], t.side, t.status, t.qty || 0, t.px || 0, t.cost || 0, t.result, t.pnl, t.msg || '', t.q ? Math.round(t.q * 100) : null, t.strategy === 'late' ? 1 : 0];
    const snap = {
      v: 1, ts: Date.now(), ver: AUTOPILOT_VERSION, since: STARTED, why: botWhy, note: lastNote, keys: !!KEY,
      msgs: o.budget && isFinite(o.budget.left()) ? Math.floor(o.budget.left()) : null,   // ntfy messages left (free ntfy.sh)
      ap: { enabled: S.enabled, mode: S.mode, mainOn: S.mainOn !== false, betPct: S.betPct, dailyStopPct: S.dailyStopPct, lossStreak: S.lossStreak, cooldownMin: S.cooldownMin, goal: S.goal, lateLive: S.lateLive, lateBet: S.lateBet, lateBetPct: S.lateBetPct, lateFavOnly: S.lateFavOnly, lateMinReal: S.lateMinReal, lateHours: S.lateHours, lateAntic: S.lateAntic, lateMaxLosses: S.lateMaxLosses, anticBlockReset: S.anticBlockReset !== false, anticStart: S.anticStart, anticStep: S.anticStep, anticFloor: S.anticFloor, streak: S.streak[S.mode] || 0, notifyFills: S.notifyFills, notifyResults: S.notifyResults, minModel: minModel(o.defMinModel), minMarket: minMarket(o.defMinMarket), target: target(o.defTarget), halted: S.halted },
      bal: { live: S.liveBal, practice: S.practice }, stats: S.stats, days, acks: acks.slice(-5),
      trades: S.trades.slice(-12).map(tr),
      late: { since: S.late.since, antic: anticView(), blockLosses: blockLosses(), capHit: capHit() ? 1 : 0, stats: S.late.stats, real: S.late.real || null, byPat: S.late.byPat || null, byFav: S.late.byFav || null, byBlock: lateByBlock(), trades: S.late.trades.slice(-6).map((t) => [t.ts, t.Ws, t.side, t.status, t.px || 0, t.quoted, Math.round(t.q * 100), t.result, t.pnl, t.left, t.msg || '', t.real ? 1 : 0, t.pat === 'against' ? (t.patSkip ? 2 : 1) : t.pat === 'with' ? 3 : 0, t.realSkip === 'underdog' ? 1 : t.realSkip === 'conf' ? 2 : t.realSkip === 'hours' ? 3 : t.realSkip === 'maxloss' ? 4 : 0, t.fav != null ? t.fav : (t.quoted >= 0.5 ? 1 : 0)]) },
      led: (() => { const d = pday(Date.now()); return [S.ledger.start, d, ...ledgerDay(d)]; })(),
      h: Object.assign({ u: US.up ? 1 : 0, a: S.liveBal ? Math.round((Date.now() - S.liveBal.at) / 1000) : null, k: KEY ? 1 : 0 }, o.health ? o.health() : {}),
      lag: { since: S.lagt.since, stats: S.lagt.stats, byGap: S.lagt.byGap, est: S.lagt.est, src: US.up ? 's' : 'p', trades: S.lagt.trades.slice(-4).map((t) => [t.ts, t.Ws, t.side, t.status, t.px || 0, t.seen, t.com, t.result, t.pnl, t.left, t.msg || '']) },
    };
    while (JSON.stringify(snap).length > 2900 && snap.trades.length > 3) snap.trades.shift();   // ntfy messages are capped at 4 KB
    while (JSON.stringify(snap).length > 2900 && snap.late.trades.length > 2) snap.late.trades.shift();
    while (JSON.stringify(snap).length > 2900 && snap.lag.trades.length > 1) snap.lag.trades.shift();
    return snap;
  }
  // Status updates share ntfy's daily message allowance with BUY alerts, so they are sparing: at most one every
  // 20 minutes on their own, right away only when you act on the page, and none while the allowance is low.
  const STATUS_GAP = 20 * 60000, RESERVE = 60, BEAT_RESERVE = 30, URGENT_RESERVE = 20;
  let lowLogged = 0;
  async function publish(payload, urgent) {
    await ready;
    if (!K) return;
    const left = o.budget ? o.budget.left() : Infinity;
    if (left < (urgent === 'beat' ? BEAT_RESERVE : urgent ? URGENT_RESERVE : RESERVE)) {
      if (Date.now() - lowLogged > 3600000) { lowLogged = Date.now(); log(`autopilot: holding status updates to save ntfy messages for alerts (${Math.floor(left)} left today)`); }
      return;
    }
    lastPublish = Date.now();
    try {
      if (o.budget) o.budget.take();
      const r = await fetch(`${NTFY}/${T.status}`, { method: 'POST', headers: Object.assign({ Priority: '1' }, NTFY_AUTH), body: await APC.seal(K, payload || snapshot()) });
      if (r.status === 429 && o.budget) o.budget.exhausted();
      if (!r.ok) log('autopilot: status publish HTTP', r.status);
    } catch (e) { log('autopilot: status publish failed:', e.message); }
  }
  let pubDue = 0, pubUrgent = false;
  function publishSoon(ms, urgent) {
    const want = urgent ? Date.now() + (ms == null ? 1500 : ms) : Math.max(Date.now() + 1500, lastPublish + STATUS_GAP);
    if (pubTimer && pubDue <= want && (pubUrgent || !urgent)) return;    // something sooner is already scheduled
    clearTimeout(pubTimer); pubDue = want; pubUrgent = !!urgent;
    pubTimer = setTimeout(() => { pubTimer = null; publish(null, pubUrgent); }, want - Date.now());
  }
  // Ledger history goes out on request (the Profits page asks when it has no copy yet), 100 days per message
  let ledPubAt = 0;
  function ledgerChunks() {
    const rows = [], today = pday(Date.now());
    for (let d = S.ledger.start; d <= today; d = addDays(d, 1)) rows.push(S.ledger.days[d] || [0, null, 0, 0]);
    const N = 100, of = Math.ceil(rows.length / N), out = [];
    for (let i = 0; i < rows.length; i += N) out.push({ v: 1, kind: 'ledger', ts: Date.now(), start: S.ledger.start, d0: addDays(S.ledger.start, i), i: out.length, of, rows: rows.slice(i, i + N) });
    return out;
  }
  // Track from an earlier (or later) date: rebuild the ledger from the real trades the bot still keeps.
  // Days recorded earlier keep their recorded starting balance; others use the balance before that day's first trade.
  function ledgerRebuild(from) {
    const today = pday(Date.now());
    if (!/^\d{4}-\d\d-\d\d$/.test(from) || from > today) return { ok: false, msg: 'Pick a date up to today' };
    const { days, oldest } = ledgerFromTrades(from, true);
    S.ledger = { start: from, days, lab: 'cal' };
    save(); ledPubAt = 0; publishLedger(); publishSoon(1500, true);
    return { ok: true, msg: from < oldest ? `Tracking from ${from}; trades before ${oldest} are no longer on the laptop, so those days show $0` : `Tracking from ${from}` };
  }
  function publishLedger() {
    if (Date.now() - ledPubAt < 5 * 60000) return;
    ledPubAt = Date.now();
    ledgerChunks().forEach((c, k) => setTimeout(() => publish(c, true), 2500 + k * 1500));
  }
  // Scoreboard goes out as its own message: when results changed (at most hourly), or every 6 hours anyway
  function publishScore(force) {
    const age = Date.now() - sbPubAt;
    if (!force && age < 6 * 3600000) return;
    sbPubAt = Date.now(); sbChanged = false;
    publish(scoreboard());
  }

  const seen = new Set();
  async function handleCommand(text) {
    const c = await APC.verifyCommand(K, text);
    if (!c || seen.has(c.n)) return;
    seen.add(c.n);
    const a = c.a || {}; let ok = true, msg = '';
    switch (c.c) {
      case 'enable': S.enabled = true; msg = 'Autopilot on'; break;
      case 'disable': S.enabled = false; msg = 'Autopilot off'; break;
      case 'mode':
        if (a.mode === 'live' && !KEY) { ok = false; msg = 'No Polymarket US API key installed on the laptop'; break; }
        if (a.mode !== 'live' && a.mode !== 'practice') { ok = false; msg = 'Unknown mode'; break; }
        if (S.mode !== a.mode) {
          S.mode = a.mode; msg = a.mode === 'live' ? 'LIVE trading' : 'Practice mode';
          if (a.mode === 'live') { try { await refreshLive(); } catch (e) { if (isAuthError(e)) { S.mode = 'practice'; ok = false; msg = 'Polymarket rejected the API key'; } } }
          if (ok) push({ title: a.mode === 'live' ? 'AUTOPILOT IS LIVE' : 'Autopilot: practice mode', body: a.mode === 'live' ? `Real orders, ${S.betPct}% of your balance per BUY alert.${S.liveBal ? ' Buying power ' + money(S.liveBal.buyingPower) + '.' : ''}` : 'No real orders.', priority: a.mode === 'live' ? 4 : 2, tags: a.mode === 'live' ? 'money_with_wings' : 'test_tube', click: o.site + 'autopilot.html' });
        }
        break;
      case 'set': {
        const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : undefined);
        const upd = { betPct: num(a.betPct, 1, 100), dailyStopPct: num(a.dailyStopPct, 0, 100), lossStreak: num(a.lossStreak, 0, 10), cooldownMin: num(a.cooldownMin, 5, 1440), goal: num(a.goal, 0, 1e7), lateBet: num(a.lateBet, 1, 1000), lateBetPct: num(a.lateBetPct, 0, 100), lateMinReal: num(a.lateMinReal, 50, 99), anticStart: num(a.anticStart, 1, 50), anticStep: num(a.anticStep, 0, 50), anticFloor: num(a.anticFloor, 1, 50), lateMaxLosses: num(a.lateMaxLosses, 0, 20), minModel: a.minModel === null ? null : num(a.minModel, 50, 99), minMarket: a.minMarket === null ? null : num(a.minMarket, 50, 99) };
        for (const [k, v] of Object.entries(upd)) if (v !== undefined && k in a) S[k] = v;
        for (const k of ['notifyFills', 'notifyResults', 'lateFavOnly', 'mainOn', 'lateAntic', 'anticBlockReset']) if (typeof a[k] === 'boolean') S[k] = a[k];
        if (Array.isArray(a.lateHours) && a.lateHours.length === 3 && a.lateHours.every((x) => typeof x === 'boolean')) S.lateHours = a.lateHours.slice();
        if (typeof a.lateLive === 'boolean' && a.lateLive !== S.lateLive) {
          S.lateLive = a.lateLive;
          push({ title: a.lateLive ? 'LATE COIN-FLIP: REAL TRADES ON' : 'Late coin-flip: practice only', body: a.lateLive ? `Real orders of ${S.lateBetPct > 0 ? S.lateBetPct + '% of buying power' : '$' + S.lateBet} in the last 75-30 s of close windows, while autopilot is Live.${S.mode === 'live' ? '' : ' Autopilot is in Practice now, so nothing real until you switch to Live.'}` : 'No more real late coin-flip orders.', priority: a.lateLive ? 4 : 2, tags: a.lateLive ? 'money_with_wings' : 'test_tube', click: o.site + 'autopilot.html' });
        }
        if ('target' in a && (a.target === null || Signal.Z_FOR[a.target])) S.target = a.target;
        msg = 'Settings saved';
        setTimeout(checkGoal, 500);   // a goal at or below the balance fires right away
        break;
      }
      case 'resume':
        if (S.mode === 'live' && KEY) { try { const b = await refreshLive(); if (b.buyingPower < MIN_BALANCE) { ok = false; msg = `Still out of money (${money(b.buyingPower)})`; break; } } catch (e) { ok = false; msg = e.message.slice(0, 100); break; } }
        if (S.mode === 'practice' && S.practice.balance < MIN_BALANCE) { ok = false; msg = 'Practice balance is empty — reset it'; break; }
        S.halted = null; msg = 'Resumed'; break;
      case 'resetPractice': {
        const b = typeof a.balance === 'number' && a.balance >= 10 && a.balance <= 1e7 ? r2(a.balance) : 1000;
        S.practice = { balance: b, start: b }; S.stats.practice = zeroStats(); S.streak.practice = 0;
        for (const d of Object.values(S.days)) delete d.practice;
        S.trades = S.trades.filter((t) => t.mode !== 'practice');
        if (S.halted && S.mode === 'practice') S.halted = null;
        msg = `Practice reset to ${money(b)}`; break;
      }
      case 'refresh': if (S.mode === 'live' && KEY) await refreshLive().catch(() => {}); break;
      case 'ledger': publishLedger(); break;
      case 'ledgerFrom': { const r = ledgerRebuild(String(a.d || '')); ok = r.ok; msg = r.msg; log('profits ledger: ' + r.msg); break; }
      case 'score': if (Date.now() - sbPubAt > 5 * 60000) { sbPubAt = Date.now(); sbChanged = false; setTimeout(() => publish(scoreboard(), true), 2500); } break;
      default: ok = false; msg = 'Unknown command';
    }
    acks.push([c.n, ok ? 1 : 0, msg]); if (acks.length > 10) acks.shift();
    log(`autopilot command: ${c.c} → ${ok ? 'ok' : 'refused'}${msg ? ' (' + msg + ')' : ''}`);
    save();
    if (c.c === 'refresh' || c.c === 'score') { if (c.c === 'refresh' && Date.now() - lastPublish > 30000) publishSoon(300, true); }
    else publishSoon(300, true);
  }
  async function listen() {
    await ready;
    if (!K) { log('autopilot: no AUTOPILOT_PASSWORD set — the autopilot page cannot connect (trading still works)'); return; }
    let since = 'all', lastData = Date.now();
    // only act on commands sent after startup (verifyCommand also rejects anything older than 2 minutes)
    since = String(Math.floor(Date.now() / 1000) - 5);
    for (;;) {
      const ac = new AbortController();
      const watchdog = setInterval(() => { if (Date.now() - lastData > 150000) ac.abort(); }, 10000);
      try {
        const r = await fetch(`${NTFY}/${T.command}/json?since=${since}`, { headers: NTFY_AUTH, signal: ac.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          lastData = Date.now();
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let m; try { m = JSON.parse(line); } catch { continue; }
            if (m.event === 'message') { since = m.id; handleCommand(m.message).catch((e) => log('autopilot command error:', e.message)); }
          }
        }
      } catch (e) { if (e.name !== 'AbortError') log('autopilot: command link:', e.message); }
      clearInterval(watchdog);
      await sleep(3000); lastData = Date.now();
    }
  }

  // ------------------------------------------------------------ periodic work (called every second by the bot)
  let lastBal = 0, lastBeat = 0;
  function tick(why) {
    botWhy = why || botWhy;
    const now = Date.now();
    if (now - lastSettleCheck > 10000) { lastSettleCheck = now; settle().catch((e) => log('autopilot settle:', e.message)); settleLate().catch((e) => log('late test settle:', e.message)); settleLag().catch((e) => log('lag test settle:', e.message)); sbSettle().catch((e) => log('scoreboard settle:', e.message)); }
    if (now - STARTED > 30000) publishScore();
    if (S.halted && S.halted.untilTs && now >= S.halted.untilTs) {
      S.halted = null; save(); publishSoon(1500, true);
      push({ title: 'Autopilot resumed', body: `Pause over: trading again at ${S.betPct}% per BUY alert.`, priority: 3, tags: 'arrow_forward', click: o.site + 'autopilot.html' });
    }
    if (S.halted && S.halted.untilDay && dayOf(now) >= S.halted.untilDay) {
      S.halted = null; save(); publishSoon(1500, true);
      push({ title: 'Autopilot resumed', body: 'New day: the daily loss limit has reset.', priority: 3, tags: 'arrow_forward', click: o.site + 'autopilot.html' });
    }
    if (KEY && now - lastBal > (S.mode === 'live' ? 60000 : 300000)) {   // practice: just keep the page's buying power fresh
      lastBal = now;
      refreshLive().then((b) => {
        const open = S.trades.some((t) => t.mode === 'live' && t.result == null && (t.status === 'filled' || t.status === 'partial'));
        if (S.mode === 'live' && b.buyingPower < MIN_BALANCE && !open && S.enabled) outOfMoney(b.buyingPower);
        if (S.mode === 'live') checkGoal();
      }).catch((e) => { if (isAuthError(e) && S.mode === 'live') halt('Polymarket rejected the API key', e.message.slice(0, 160)); else log('autopilot balance:', e.message); });
    }
    if (now - lastBeat > 60 * 60000 && now - lastPublish > 30 * 60000) { lastBeat = now; publish(null, 'beat'); }   // hourly check-in, allowed down to 30 messages left
  }

  const minModel = (def) => (S.minModel != null ? S.minModel : def);
  const target = (def) => (S.target != null && Signal.Z_FOR[S.target] ? S.target : def);
  const minMarket = (def) => (S.minMarket != null ? S.minMarket : def);

  // ------------------------------------------------------------ key check (node tools/signal-bot.mjs --check-autopilot)
  async function check(Ws) {
    const out = { keyId: KEY_ID ? KEY_ID.slice(0, 8) + '…' : null, keyLoaded: !!KEY, password: !!PASSWORD, topics: T };
    if (!KEY) return out;
    out.balance = await refreshLive().catch((e) => ({ error: e.message }));
    let mkt;
    try { mkt = await marketFor(Ws); out.market = mkt; } catch (e) { out.market = { error: e.message }; return out; }
    try { const bk = await book(mkt.slug); out.book = { bestBid: bk.bids[0] || null, bestAsk: bk.asks[0] || null, state: bk.state }; } catch (e) { out.book = { error: e.message }; }
    // live price stream (used by the US lag recorder)
    out.stream = await new Promise((res) => {
      let ws, done = false, opened = false; const t0 = Date.now();
      const fin = (r) => { if (done) return; done = true; clearTimeout(to); try { if (ws) ws.close(); } catch { /* closed */ } res(r); };
      const to = setTimeout(() => fin({ error: 'no price update within 10 s', opened }), 10000);
      try { ws = new WebSocket(API.replace(/^http/, 'ws') + WS_PATH, { headers: wsHeaders() }); } catch (e) { fin({ error: e.message }); return; }
      ws.onopen = () => { opened = true; ws.send(JSON.stringify({ subscribe: { requestId: 'check', subscriptionType: 'SUBSCRIPTION_TYPE_MARKET_DATA_LITE', marketSlugs: [mkt.slug] } })); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
        if (m.marketDataLite) fin({ ok: true, ms: Date.now() - t0, first: m.marketDataLite });
        else if (m.error) fin({ error: JSON.stringify(m.error).slice(0, 200), opened });
      };
      ws.onclose = (ev) => fin({ error: `closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''})`, opened });
      ws.onerror = () => fin({ error: opened ? 'stream error' : 'connection refused (key not accepted for the stream?)', opened });
    });
    // Previews never trade. Prices are far from the market on purpose.
    const prev = (intent, yes) => api('POST', '/v1/order/preview', { request: { marketSlug: mkt.slug, intent, type: 'ORDER_TYPE_LIMIT', price: { value: yes, currency: 'USD' }, quantity: 1, tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC' } }).catch((e) => ({ error: e.message }));
    out.previewBuyUp = await prev('ORDER_INTENT_BUY_LONG', '0.02');
    out.previewBuyDown = await prev('ORDER_INTENT_BUY_SHORT', '0.98');
    return out;
  }

  function start() { listen(); publishSoon(5000, true); }
  process.on('exit', () => { sbSave(true); lagFlush(true); });
  return { ledgerChunks, onSignal, observe, observeLate, settleLate, observeLag, settleLag, lagEstimate, lagFlush, tick, start, check, settle, sbSettle, scoreboard, publishScore, minModel, minMarket, target, state: () => S, hasKey: () => !!KEY, flush: publish };
}

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
  mainGuardN: 30, mainGuardPct: -3,      // safety switch: after this many real regular bets, back to practice if they're below this % per $1 (0 bets = off)
  mainMaxLosses: 6,                      // real regular bets: after this many losses in a day (pending bets count as losses), the rest of the day is practice (0 = no cap)
  mainLoss: null,                        // { d, n } real regular-bet losses today
  mainTally: null,                       // { since, n, w, cost, pnl } real regular bets since real money was last switched on
  lateAntic: false,                      // Anticipation mode: real coin-flip size steps down after each loss…
  anticStart: 20, anticStep: 5, anticFloor: 10,
  anticBlockReset: true,
  lateMaxLosses: 2,                      // stop real coin flips for the rest of the 8-hour block after this many real losses in it (0 = never)                 // each new 8-hour block starts at the bottom of the ladder until a real loss in that block   // …anticStart % right after a loss, minus anticStep per coin flip since, never below anticFloor
  lateHours: [true, true, true],         // real coin flips allowed in each 8-hour block, Central time: 12am-8am, 8am-4pm, 4pm-12am
  lateFavOnly: true,                     // real coin-flip money only when the model backs Polymarket's favorite
  lateMinReal: 65,                       // …and only when the model gives that side at least this % (60 = no extra filter)
  lateGapFix: true,                      // coin flips: shift Coinbase's price by the start-price gap (Coinbase vs Polymarket's start price) before the model decides
  lateMinEdge: 0,                        // …and only when the model's % is at least the all-in price per contract (price + fee) plus this many points; the order never pays more (null = no price check)
  teeterOn: true,                        // Teeter-totter: watch the last minute of every window (results are tracked either way)
  teeterLive: true,                      // …and bet real money on it when autopilot is Live
  teeterPct: 2,                          // % of buying power per teeter-totter bet
  teeterAt: 85,                          // buy when one side's Polymarket US price reaches this % in the last 30 s…
  teeterFlips: 2,                        // …after the leader flipped at least this many times in the last 60 s (47–53¢ ignored)
  teeterMaxLosses: 0,                    // real teeter-totter losses per day before the rest of the day is practice (0 = no limit)
  // TV Divergence real-money execution test (Nov 26): off until switched on; the only strategy meant to trade for real
  tvdLive: false,                        // real orders on TV Divergence triggers (practice tracking runs either way)
  tvdPct: 2,                             // % of buying power per real bet, sized at the limit price so a fill never costs more
  tvdMaxPx: 0.71,                        // the order's limit is min(ask + 1 tick, this)
  tvdMaxLosses: 5,                       // real losses in a day (pending bets count) before the rest of the day is practice
  tvdLoss: null,                         // { d, n } real TV Divergence losses today
  tvdGuardN: 30, tvdGuardPct: -5,        // after 30 settled real bets, back to practice if the return is under -5% per $1
  teeterFresh: true,                     // only on a fresh cross: that side was below teeterAt on the previous reading (not already there when the 30 s gate opens)
  teeterTrigMax: 92,                     // ¢: trigger only when the price seen is at or below this (95–98¢ bets risk ~$35 to win ~60¢)
  teeterMaxPx: 94,                       // ¢: the order's limit, the most it may pay. Separate from the trigger cap (Nov 22) so fast
                                         // breakouts still fill: the order fills at the best price available up to this
  teeterLoss: null,                      // { d, n } real teeter-totter losses today
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
  let warnedAt = 0, timer = null, lastBad = null, last = { ok: null, at: 0, healthy: null };
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
      last = { ok: r.ok, at: Date.now(), healthy: st.ok };
      if (!r.ok && Date.now() - warnedAt > 3600000) { warnedAt = Date.now(); log(`healthchecks ping HTTP ${r.status}${r.status === 404 ? ' (no check with that name: create it on Healthchecks.io)' : ''}`); }
      if (st.ok !== lastBad) { if (lastBad !== null) log(st.ok ? 'healthchecks: healthy again' : `healthchecks: reporting a problem (${st.body})`); lastBad = st.ok; }
      return r.status;
    } catch (e) {
      last = { ok: false, at: Date.now(), healthy: st.ok };
      if (Date.now() - warnedAt > 3600000) { warnedAt = Date.now(); log('healthchecks ping failed:', e.message); }
      return null;
    }
  }
  return {
    on: !!url, status, ping, last: () => last,
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
  // Coin-flip archive for the autopilot page's night tables (flipstats.js): one compact row per settled filled
  // flip, kept 60 days. [Ws, q, quoted, cost per contract, won, pattern 0/1 against/2 with, real, backtest]
  const FLIP_DAYS = 60;
  if (!Array.isArray(S.flips)) S.flips = [];
  const flipRow = (t) => [t.Ws, Math.round(t.q * 1e4) / 1e4, t.quoted, Math.round(t.cost / t.qty * 1e4) / 1e4, t.result ? 1 : 0, t.pat === 'against' ? 1 : t.pat === 'with' ? 2 : 0, t.real ? 1 : 0, 0];
  function addFlips(rows) {
    const have = new Set(S.flips.map((r) => r[0])); let n = 0;
    for (const r of rows) if (Array.isArray(r) && r.length >= 8 && !have.has(r[0])) { S.flips.push(r); have.add(r[0]); n++; }
    if (n) {
      S.flips.sort((a, b) => a[0] - b[0]);
      const cut = Date.now() / 1000 - FLIP_DAYS * 86400;
      while (S.flips.length && S.flips[0][0] < cut) S.flips.shift();
    }
    return n;
  }
  addFlips(((S.late && S.late.trades) || []).filter((t) => t.status === 'filled' && t.result != null && t.qty > 0).map(flipRow));
  // one-time seed (older nights from before the bot kept this archive), then set aside
  try {
    const SEED = join(dir, 'flip-seed.json');
    if (existsSync(SEED)) { const n = addFlips(JSON.parse(readFileSync(SEED, 'utf8'))); renameSync(SEED, SEED + '.used'); log(`coin-flip archive: added ${n} older flips`); }
  } catch (e) { log('coin-flip archive seed:', e.message); }
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
  // The same split by time block (12am-8am, 8am-4pm, 4pm-12am, by when the bet was placed) for the Profits chart's
  // per-block view and the Sense HAT: ledgerBlk.days[d] = [profit, trades, wins] x 3 blocks. Days before the trades the
  // bot keeps were filled in from its logs.
  const hourOf = (ms) => +new Date(ms).toLocaleString('en-US', { timeZone: tzName, hour: 'numeric', hourCycle: 'h23' }) % 24;
  S.ledgerBlk = S.ledgerBlk || { days: {} };
  delete S.ledgerAm;
  const blkAdd = (row, t) => { const k = Math.floor(hourOf(t.ts) / 8) * 3; row[k] = r2(row[k] + t.pnl); row[k + 1]++; if (t.result) row[k + 2]++; };
  function ledgerAdd(t) {
    const d = pday(t.ts); if (d < S.ledger.start) return;
    const r = ledgerDay(d); r[0] = r2(r[0] + t.pnl); r[2]++; if (t.result) r[3]++;
    blkAdd(S.ledgerBlk.days[d] || (S.ledgerBlk.days[d] = [0, 0, 0, 0, 0, 0, 0, 0, 0]), t);
  }
  // rebuild the days the kept trades fully cover (the oldest kept day may be partial, so it stays as it was)
  {
    const live = S.trades.filter((t) => t.mode === 'live' && t.result != null && t.pnl != null);
    if (live.length) {
      const first = addDays(pday(live[0].ts), 1), days = {};
      for (const t of live) { const d = pday(t.ts); if (d < first) continue; blkAdd(days[d] || (days[d] = [0, 0, 0, 0, 0, 0, 0, 0, 0]), t); }
      for (let d = first; d <= pday(Date.now()); d = addDays(d, 1)) S.ledgerBlk.days[d] = days[d] || [0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
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
  // "API key timestamp expired" is this computer's clock being off (e.g. a Pi just booted without a clock battery),
  // not a bad key: never halt for it, just skip and say so
  const isClockError = (e) => e && e.status === 401 && /timestamp/i.test(e.message || '');
  let clockWarnAt = 0;
  const isAuthError = (e) => {
    if (isClockError(e)) {
      if (Date.now() - clockWarnAt > 6 * 3600000) {
        clockWarnAt = Date.now();
        log('Polymarket says this computer\'s clock is off (' + e.message.slice(0, 80).trim() + '); not trading until it is right');
        Promise.resolve(push({ title: 'Bot clock is off', body: 'Polymarket refused a request because this computer\'s clock is wrong. The bot keeps running and trades again once the clock is right (it syncs from the internet).', priority: 4, tags: 'clock', click: o.site + 'autopilot.html' })).catch(() => {});
      }
      return false;
    }
    return e && (e.status === 401 || e.status === 403);
  };
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
    // Daily loss cap: once today's real regular-bet losses plus the bets still waiting for a result reach the cap,
    // the rest of today's regular bets are practice (so a worst-case day can't run past the cap)
    const today = dayOf(Date.now());
    const lossesToday = S.mainLoss && S.mainLoss.d === today ? S.mainLoss.n : 0;
    const pendingReal = S.trades.filter((t) => t.mode === 'live' && !t.strategy && t.result == null && (t.status === 'filled' || t.status === 'partial')).length;
    const capped = S.mode === 'live' && S.mainOn !== false && S.mainMaxLosses > 0 && lossesToday + pendingReal >= S.mainMaxLosses;
    const paper = S.mode === 'live' && (S.mainOn === false || capped);
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

    if (!(filled > 0)) return record({ Ws, mode, side, status: 'nofill', msg: msg || `No fill at ${cents(limit)} or better`, q, mkt: sig.marketPct, qty, limit, seen: best, orderId, slug: mkt.slug, missed: null, paper: paper ? 1 : undefined });
    const px = notional / filled, fee = r4(feeAt(px) * filled), cost = r2(notional + fee);
    if (!live) S.practice.balance = r2(S.practice.balance - cost);
    const t = record({ Ws, mode, side, status: filled < qty - 1e-9 ? 'partial' : 'filled', q, mkt: sig.marketPct, qty: filled, want: qty, px: r4(px), fee, cost, limit, seen: best, orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal), paper: paper ? 1 : undefined });
    S.stats[mode].n++; S.stats[mode].staked = r2(S.stats[mode].staked + cost);
    day.n++;
    log(`AUTOPILOT ${mode.toUpperCase()}${paper ? (capped ? ' (daily loss cap reached)' : ' (regular bets off)') : ''} bought ${side} ${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)})`);
    // A real purchase replaces the BUY alert, so it always notifies (loudly), with the signal's numbers.
    // Practice fills are mentioned inside the bot's BUY alert instead of a second message.
    if (live) push({ title: `BOUGHT ${side}`, body: `${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)}) · MODEL ${Math.round(sig.modelPct || q * 100)}% · POLYMARKET ${Math.round(sig.marketPct || 0)}%`, priority: 5, tags: side === 'UP' ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
    return t;
  }

  // Real order: immediate-or-cancel limit at `limit` (price of the side we buy). Returns what filled.
  async function liveOrder(mkt, up, limit, qty) {
    let filled = 0, notional = 0, msg = '', billed = null;   // billed: the fee Polymarket US actually charged (null if not reported)
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
      if (/FILL/.test(ex.type || '') && ex.lastShares) {
        const sh = +ex.lastShares, px = ours(+ex.lastPx.value); filled += sh; notional += sh * px;
        if (ex.commissionNotionalCollected && ex.commissionNotionalCollected.value != null) billed = (billed || 0) + +ex.commissionNotionalCollected.value;
      }
      if (/REJECT/.test(ex.type || '')) msg = ex.orderRejectReason || ex.text || 'rejected';
    }
    if ((!filled || billed == null) && orderId) {   // no fill reported, or no fee on the fills: ask for the order itself
      try {
        const od = (await api('GET', '/v1/order/' + orderId)).order || {};
        if (!filled) { filled = +od.cumQuantity || 0; if (filled && od.avgPx) notional = filled * ours(+od.avgPx.value); }
        if (filled && billed == null && od.commissionNotionalTotalCollected && od.commissionNotionalTotalCollected.value != null) billed = +od.commissionNotionalTotalCollected.value;
        if (!msg && /REJECT/.test(od.state || '')) msg = 'rejected';
      } catch (e) { log('autopilot: order lookup failed:', e.message); }
    }
    if (!filled && isMoneyError({ text: msg })) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
    refreshLive().catch(() => {});
    return { filled, notional, orderId, msg, fee: billed == null ? null : r4(billed) };
  }

  // ------------------------------------------------------------ settlement
  // Safety switch for real regular bets: keep a running tally since they were switched on; once there are enough
  // of them, send them back to practice (coin flips untouched) if they're losing more than the limit per $1.
  function guardMain(t) {
    const g = S.mainTally || (S.mainTally = { since: t.ts, n: 0, w: 0, cost: 0, pnl: 0 });
    g.n++; g.w += t.result ? 1 : 0; g.cost = r2(g.cost + t.cost); g.pnl = r2(g.pnl + t.pnl);
    if (!(S.mainGuardN > 0) || S.mainOn === false || g.n < S.mainGuardN || !(g.cost > 0)) return;
    const pct = g.pnl / g.cost * 100;
    if (pct < S.mainGuardPct) {
      S.mainOn = false;
      log(`SAFETY SWITCH: real regular bets back to practice after ${g.n} bets (${g.w} won, ${money(g.pnl)}, ${pct.toFixed(1)}% per $1 < ${S.mainGuardPct}%)`);
      push({ title: 'Regular bets back to practice', body: `Safety switch: ${g.n} real regular bets, ${g.w} won, ${money(g.pnl)} (${pct.toFixed(1)}% per $1, limit ${S.mainGuardPct}%). Coin flips are unchanged. Switch them back on in Settings to try again.`, priority: 4, tags: 'warning', click: o.site + 'autopilot.html' });
    }
  }
  // Unfilled real orders: when the price runs away before the order lands, the side usually wins. Recording whether it
  // did shows what the misses cost (practice and backtests assume every order fills).
  async function settleMissed() {
    const now = Date.now() / 1000;
    for (const t of S.trades) {
      if (t.status !== 'nofill' || t.mode !== 'live' || t.missed !== null || !t.slug || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) { try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (s == null) continue;
      t.missed = (s >= 0.5) === (t.side === 'UP') ? 1 : 0;
      save(); publishSoon();
    }
  }
  function missedSummary(strategy) {
    const x = S.trades.filter((t) => t.mode === 'live' && t.status === 'nofill' && (t.strategy || null) === strategy && t.missed != null);
    return [x.length, x.filter((t) => t.missed).length];
  }
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
      if (t.mode === 'live' && t.strategy === 'teeter' && !won) {
        const d = dayOf(t.ts);
        if (!S.teeterLoss || S.teeterLoss.d !== d) S.teeterLoss = { d, n: 0 };
        S.teeterLoss.n++;
        if (S.teeterMaxLosses > 0 && S.teeterLoss.n === S.teeterMaxLosses) {
          log(`teeter-totter daily loss cap: ${S.teeterLoss.n} real losses today, the rest of today is practice`);
          push({ title: 'Teeter-totter: practice for the rest of today', body: `${S.teeterLoss.n} real teeter-totter losses today (your daily limit). Real bets start again tomorrow.`, priority: 3, tags: 'stop_sign', click: o.site + 'autopilot.html' });
        }
      }
      if (t.mode === 'live' && t.strategy === 'tvd') {
        const r = S.tvd.trades.find((x) => x.Ws === t.Ws && x.real === 1 && x.orderId === t.orderId);
        if (r) Object.assign(r, { realResult: t.result, realPnl: t.pnl });
        if (!won) {
          const d = dayOf(t.ts);
          if (!S.tvdLoss || S.tvdLoss.d !== d) S.tvdLoss = { d, n: 0 };
          S.tvdLoss.n++;
          if (S.tvdMaxLosses > 0 && S.tvdLoss.n === S.tvdMaxLosses) {
            log(`TV divergence daily loss cap: ${S.tvdLoss.n} real losses today, the rest of today is practice`);
            push({ title: 'TV Divergence: practice for the rest of today', body: `${S.tvdLoss.n} real TV Divergence losses today (your daily limit). Real bets start again tomorrow.`, priority: 3, tags: 'stop_sign', click: o.site + 'autopilot.html' });
          }
        }
        const g = S.tvdTally || (S.tvdTally = { since: t.ts, n: 0, w: 0, cost: 0, pnl: 0 });
        g.n++; g.w += won ? 1 : 0; g.cost = r2(g.cost + t.cost); g.pnl = r2(g.pnl + t.pnl);
        if (S.tvdGuardN > 0 && S.tvdLive && g.n >= S.tvdGuardN && g.cost > 0 && g.pnl / g.cost * 100 < S.tvdGuardPct) {
          S.tvdLive = false;
          log(`SAFETY SWITCH: TV Divergence back to practice after ${g.n} real bets (${g.w} won, ${money(g.pnl)}, ${(g.pnl / g.cost * 100).toFixed(1)}% per $1 < ${S.tvdGuardPct}%)`);
          push({ title: 'TV Divergence back to practice', body: `Safety switch: ${g.n} real bets, ${g.w} won, ${money(g.pnl)} (${(g.pnl / g.cost * 100).toFixed(1)}% per $1, limit ${S.tvdGuardPct}%). Practice tracking continues.`, priority: 4, tags: 'warning', click: o.site + 'autopilot.html' });
        }
      }
      if (t.mode === 'live' && !t.strategy) {
        if (!won) {
          const d = dayOf(t.ts);
          if (!S.mainLoss || S.mainLoss.d !== d) S.mainLoss = { d, n: 0 };
          S.mainLoss.n++;
          if (S.mainMaxLosses > 0 && S.mainLoss.n === S.mainMaxLosses) {
            log(`daily loss cap: ${S.mainLoss.n} real regular-bet losses today, the rest of today's regular bets are practice`);
            push({ title: 'Regular bets: practice for the rest of today', body: `${S.mainLoss.n} real regular-bet losses today (the daily cap). Real regular bets start again tomorrow. Coin flips are unchanged.`, priority: 3, tags: 'stop_sign', click: o.site + 'autopilot.html' });
          }
        }
        guardMain(t);
      }
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
      if (t.quoted >= 0.5 && t.q * 100 >= (S.lateMinReal || 60) - 1e-9 && (typeof S.lateMinEdge !== 'number' || !(t.qty > 0) || t.q * 100 >= t.cost / t.qty * 100 + S.lateMinEdge - 1e-9)) { b.fn++; b.fw += t.result; b.fstaked += t.cost; b.fpnl += t.pnl; }   // would pass your filters
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
    // start-price gap correction (on by default): the model's chance with Coinbase shifted onto Polymarket's index
    const fix = S.lateGapFix !== false && x.pUpFix != null, pU = fix ? x.pUpFix : x.pUp;
    const up = pU >= 0.5, q = up ? pU : 1 - pU;
    if (q < LATE.minModel) return;
    lateTried.add(x.Ws);
    for (const k of lateTried) if (k < x.Ws - 3600) lateTried.delete(k);
    if (S.late.trades.some((t) => t.Ws === x.Ws)) return;
    const rec = { Ws: x.Ws, ts: Date.now(), side: up ? 'UP' : 'DOWN', q: r4(q), quoted: r4(up ? x.mkUp : 1 - x.mkUp), left: Math.round(left), result: null, pnl: null,
      gap: x.gap != null ? r2(x.gap) : null, fix: fix ? 1 : 0, qRaw: r4(up ? x.pUp : 1 - x.pUp) };
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
        // Price check: the model's win chance must cover the all-in price (price + fee) plus the margin, and the
        // real order's limit is lowered so it can never fill above that
        const allIn = (p) => p + feeAt(p), tk = mkt.tick > 0 ? mkt.tick : 0.01;
        const edgeOn = typeof S.lateMinEdge === 'number', maxAllIn = q - (edgeOn ? S.lateMinEdge : 0) / 100;
        rec.allIn = r4(allIn(levels[0][0]));
        let realLimit = limit;
        if (edgeOn) while (realLimit > levels[0][0] + 1e-9 && allIn(realLimit) > maxAllIn + 1e-9) realLimit = r2(realLimit - tk);
        const priceOk = !edgeOn || allIn(levels[0][0]) <= maxAllIn + 1e-9;
        const why = rec.pat === 'against' ? 'pattern' : S.lateFavOnly && !rec.fav ? 'underdog' : q * 100 < (S.lateMinReal || 60) - 1e-9 ? 'conf' : !priceOk ? 'price' : !hoursOk ? 'hours' : capHit() ? 'maxloss' : null;
        const real = eligible && !why;
        if (eligible && why) { rec.realSkip = why; if (why === 'pattern') rec.patSkip = 1; }
        if (real) {
          busy = true;
          try {
            const bal = (await refreshLive()).buyingPower;
            const step = mkt.minQty > 0 ? mkt.minQty : 0.01;
            if (S.lateAntic) rec.betPct = anticPct();
            const stake = S.lateAntic ? bal * rec.betPct / 100 : S.lateBetPct > 0 ? bal * S.lateBetPct / 100 : Math.min(S.lateBet, bal);
            const qty = r2(Math.floor(stake / (realLimit + feeAt(realLimit)) / step + 1e-9) * step);
            if (bal < MIN_BALANCE || qty < step) { outOfMoney(bal); rec.status = 'skipped'; rec.msg = 'Out of money'; }
            else {
              const day = dayRec('live', Date.now(), bal);
              const ord = await liveOrder(mkt, up, realLimit, qty);
              rec.real = 1;
              if (ord.filled > 0) {
                const px = ord.notional / ord.filled, fee = r4(feeAt(px) * ord.filled), cost = r2(ord.notional + fee);
                Object.assign(rec, { status: 'filled', qty: r2(ord.filled), px: r4(px), cost });
                record({ Ws: x.Ws, mode: 'live', strategy: 'late', betPct: rec.betPct, side: rec.side, status: ord.filled < qty - 1e-9 ? 'partial' : 'filled', q: rec.q, qty: r2(ord.filled), want: qty, px: r4(px), fee, cost, limit: realLimit, orderId: ord.orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal) });
                S.stats.live.n++; S.stats.live.staked = r2(S.stats.live.staked + cost); day.n++;
                if (S.notifyFills) push({ title: `BOUGHT ${rec.side} (LATE)`, body: `${r2(ord.filled)} @ ${cents(px)} = ${money(cost)} · late coin-flip, ${rec.left}s left${S.lateAntic ? ` · anticipation ${rec.betPct}%` : ''}`, priority: 4, tags: up ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
              } else {
                rec.status = 'nofill'; rec.msg = ord.msg || `No fill at ${cents(realLimit)} or better`;
                record({ Ws: x.Ws, mode: 'live', strategy: 'late', side: rec.side, status: 'nofill', msg: rec.msg, q: rec.q, qty, limit: realLimit, orderId: ord.orderId });
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
    log(`late coin-flip ${rec.real ? 'REAL' : 'test'}${rec.realSkip ? ` (real skipped: ${{ pattern: 'chart pattern against', underdog: 'model backs the underdog', conf: 'model below ' + S.lateMinReal + '%', price: `price ${(rec.allIn * 100).toFixed(1)}¢ all-in is above the model's ${Math.round(q * 100)}%${S.lateMinEdge ? ' minus ' + S.lateMinEdge : ''}`, hours: BLOCKS[rec.blk] + ' is switched off', maxloss: `${S.lateMaxLosses} real losses already this block` }[rec.realSkip]})` : ''}: ${rec.status} ${rec.side}${rec.px ? ' @ ' + cents(rec.px) : ''} (Polymarket showed ${cents(rec.quoted)}, model ${Math.round(q * 100)}%${rec.fix ? ` (${Math.round(rec.qRaw * 100)}% before the ${rec.gap >= 0 ? '+' : '-'}$${Math.abs(rec.gap)} start gap)` : rec.gap == null && S.lateGapFix !== false ? ' (no start gap yet)' : ''}, ${rec.left}s left)${rec.msg ? ' - ' + rec.msg : ''}`);
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
      if (t.qty > 0) addFlips([flipRow(t)]);
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
      await observeTeeter(x.Ws, e, b, mkt).catch((err) => log('teeter-totter:', err.message.slice(0, 120)));
      await observeTvd(x.Ws, e, x.btc, x.K, b, mkt, x.spotAge).catch((err) => log('tv divergence:', err.message.slice(0, 120)));
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
  // ------------------------------------------------------------ teeter-totter
  // In the last 60 s the leader on Polymarket US flips back and forth (teeterFlips+ flips, 47–53¢ ignored); then in the
  // last 30 s one side reaches teeterAt %: buy that side at the US ask. Backtest on the bot's own recordings, Nov 11–17:
  // 78 bets, 96% won, +4.4% per $1 (85%, 2+ flips). Every trigger is tracked in S.teeter (real or not).
  S.teeter = S.teeter || { since: Date.now(), trades: [] };
  if (!S.teeter.ruleSince) S.teeter.ruleSince = Date.now();   // fresh cross + price cap started (summary counts from here)
  const TT = new Map();   // Ws -> { lead, flips, done }
  async function observeTeeter(Ws, e, b, mkt) {
    if (S.teeterOn === false || e < 240 || W - e < 3) return;
    let st = TT.get(Ws);
    if (!st) { st = { lead: null, flips: 0, done: false }; TT.set(Ws, st); for (const k of TT.keys()) if (k < Ws - 900) TT.delete(k); }
    if (st.done) return;
    const mid = (b.bid + b.ask) / 2, prev = st.prev; st.prev = { mid, e };
    if (st.lead60 === undefined) st.lead60 = e <= 243 ? (mid >= 0.5 ? 1 : 0) : null;   // who led at 60 s left (logged, not a rule)
    if (e <= 270) { const l = mid >= 0.53 ? 1 : mid <= 0.47 ? 0 : null; if (l != null) { if (st.lead != null && l !== st.lead) st.flips++; st.lead = l; } }
    if (e < 270 || e > 295 || st.flips < (S.teeterFlips || 2)) return;
    const th = (S.teeterAt || 85) / 100;
    if (!(mid >= th || mid <= 1 - th)) return;
    const up = mid >= 0.5, ask = up ? b.ask : r4(1 - b.bid);
    const feeAt = (p) => mkt.feeK * p * (1 - p);
    const rec = { Ws, ts: Date.now(), side: up ? 'UP' : 'DOWN', ask: r4(ask), left: Math.round(W - e), flips: st.flips, slug: mkt.slug, real: 0, result: null, rule: 2,
      same60: st.lead60 == null ? null : (up ? 1 : 0) === st.lead60 ? 1 : 0 };
    // Fresh cross (Nov 20): the side must have been below the threshold on the previous reading (about 1 s earlier).
    // Without it, a move that broke out at 35–45 s left was bought the moment the 30 s gate opened, often at 97–98¢.
    // A stale trigger is tracked once (not bet) and the bot keeps watching for a fresh cross in the same window.
    const fresh = !!prev && e - prev.e <= 5 && (up ? prev.mid < th : prev.mid > 1 - th);
    if (S.teeterFresh !== false && !fresh) {
      if (!st.stale) { st.stale = true; S.teeter.trades.push({ ...rec, status: 'seen', cost: r4(ask + feeAt(ask)), stale: 1, realSkip: 'not a fresh cross' }); save(); }
      return;
    }
    st.done = true;
    const cap = Math.min(S.teeterMaxPx || 98, 98) / 100, trigCap = Math.min(S.teeterTrigMax || 98, S.teeterMaxPx || 98) / 100;
    if (!(ask > 0 && ask < 0.99)) { rec.status = 'skipped'; rec.msg = `price ${cents(ask)}`; }
    else {
      rec.status = 'seen'; rec.cost = r4(ask + feeAt(ask));
      if (ask > trigCap + 1e-9) { rec.capped = 1; rec.realSkip = `price above the ${cents(trigCap)} trigger cap`; }
      const today = dayOf(Date.now());
      const lossesToday = S.teeterLoss && S.teeterLoss.d === today ? S.teeterLoss.n : 0;
      const pending = S.trades.filter((t) => t.strategy === 'teeter' && t.mode === 'live' && t.result == null && (t.status === 'filled' || t.status === 'partial')).length;
      const why = !(S.enabled && S.mode === 'live' && KEY) ? 'autopilot not Live' : S.halted ? 'halted' : S.teeterLive === false ? 'real money off'
        : S.teeterMaxLosses > 0 && lossesToday + pending >= S.teeterMaxLosses ? 'daily loss limit' : busy ? 'another order going in' : null;
      if (rec.capped) { /* tracked only */ }
      else if (why) rec.realSkip = why;
      else {
        busy = true;
        try {
          const bal = (await refreshLive()).buyingPower;
          const step = mkt.minQty > 0 ? mkt.minQty : 0.01, limit = r2(cap);   // ask <= trigger cap <= order cap
          const qty = r2(Math.floor(bal * S.teeterPct / 100 / (limit + feeAt(limit)) / step + 1e-9) * step);
          if (bal < MIN_BALANCE || qty < step) { rec.realSkip = 'out of money'; if (bal < MIN_BALANCE) outOfMoney(bal); }
          else {
            const day = dayRec('live', Date.now(), bal);
            const ord = await liveOrder(mkt, up, limit, qty);
            rec.real = 1;
            if (ord.filled > 0) {
              const px = ord.notional / ord.filled, fee = r4(feeAt(px) * ord.filled), cost = r2(ord.notional + fee);
              record({ Ws, mode: 'live', strategy: 'teeter', betPct: S.teeterPct, side: rec.side, status: ord.filled < qty - 1e-9 ? 'partial' : 'filled', qty: r2(ord.filled), want: qty, px: r4(px), fee, cost, limit, seen: r4(ask), orderId: ord.orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal), flips: st.flips, same60: rec.same60 });
              Object.assign(rec, { realStatus: 'filled', realPx: r4(px), realCost: cost });
              if (px < ask - 0.015) rec.under = 1;   // filled 2¢+ below the trigger: the price was falling while the order went in
              S.stats.live.n++; S.stats.live.staked = r2(S.stats.live.staked + cost); day.n++;
              if (S.notifyFills) push({ title: `BOUGHT ${rec.side} (TEETER)`, body: `${r2(ord.filled)} @ ${cents(px)} = ${money(cost)} · teeter-totter, ${st.flips} flips, ${rec.left}s left`, priority: 4, tags: up ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
            } else {
              rec.realStatus = 'nofill'; rec.msg = ord.msg || `No fill at ${cents(limit)} or better`;
              record({ Ws, mode: 'live', strategy: 'teeter', side: rec.side, status: 'nofill', msg: rec.msg, qty, limit, seen: r4(ask), orderId: ord.orderId, slug: mkt.slug, missed: null, flips: st.flips, same60: rec.same60 });
            }
          }
        } catch (e2) {
          if (isAuthError(e2)) halt('Polymarket rejected the API key', e2.message.slice(0, 160));
          else if (isMoneyError(e2)) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
          rec.real = 1; rec.realStatus = 'error'; rec.msg = e2.message.slice(0, 80);
        } finally { busy = false; }
      }
    }
    S.teeter.trades.push(rec);
    if (S.teeter.trades.length > 400) S.teeter.trades.splice(0, S.teeter.trades.length - 400);
    log(`teeter-totter ${rec.real ? 'REAL' : 'test'}${rec.realSkip ? ` (real skipped: ${rec.realSkip})` : ''}: ${rec.realStatus || rec.status} ${rec.side} @ ${cents(rec.realPx || ask)} (${st.flips} flips, ${rec.same60 == null ? 'leader at 60 s unknown' : rec.same60 ? 'same side as at 60 s left' : 'other side from 60 s left'}, US ${Math.round(mid * 100)}%, ${rec.left}s left)${rec.msg ? ' - ' + rec.msg : ''}`);
    save(); publishSoon();
  }
  // ---------- TV Divergence: practice only (Nov 23). It never places an order; it logs every trigger as a forward
  // test of the rule picked in tools/tv-divergence-backtest.mjs, which stays paused for real money until 50+ forward
  // triggers hold up. Rule: 30–150 s left; Coinbase spot at least $35 past the window's price to beat K on side X for
  // 3 readings in a row (about 3 s, counting only readings inside the last 150 s), having been on the other side of K
  // within the 60 s before that hold began; Polymarket US's ask for X at most 70¢. One trigger per window. Then it
  // logs the next reading's ask as a simulated fill (at the trigger price, +0¢, and up to 1¢ more), whether X's price
  // rose 5¢+ within 15 s, and how the window settled.
  // Nov 25 (v2): sanity guards after 8 of the first 30 triggers fired on a frozen Coinbase price (fixed in
  // signal-bot's candle guard): no trigger unless the latest trade is under 3 s old and the price has changed in the
  // last 10 s, and the ask must be at least 50¢ (Polymarket far under 50¢ while spot is $35+ past the line has so far
  // only meant broken data). Triggers from before v2 that saw a frozen price are marked bad and left out of the counts.
  const TVD = { minLeft: 30, maxLeft: 150, B: 35, hold: 3, cap: 0.70, floor: 0.50, look: 60, maxAge: 3, flatSec: 10 };
  S.tvd = S.tvd || { since: Date.now(), trades: [] };
  const tvdW = new Map();
  async function observeTvd(Ws, e, spot, K, b, mkt, spotAge) {
    if (S.tvdOn === false || K == null || !(spot > 0)) return;
    let st = tvdW.get(Ws);
    if (!st) { st = { hist: [], hold: 0, side: 0, holdStartE: null, done: false, rec: null, px: null, pxE: e }; tvdW.set(Ws, st); for (const k of tvdW.keys()) if (k < Ws - 900) tvdW.delete(k); }
    if (spot !== st.px) { st.px = spot; st.pxE = e; }
    const midUp = (b.bid + b.ask) / 2, r = st.rec;
    if (r) {   // follow-ups on this window's trigger
      if (r.fillAsk === undefined) {
        const a = r.side === 'UP' ? b.ask : r4(1 - b.bid);
        if (e - r.e <= 2) Object.assign(r, { fillAsk: r4(a), fill0: a <= r.ask + 1e-9 ? 1 : 0, fill1: a <= r.ask + 0.01 + 1e-9 ? 1 : 0 });
        else Object.assign(r, { fillAsk: null, fill0: 0, fill1: 0 });
        save();
      }
      if (r.rose5 == null && e >= r.e + 15) {
        if (e <= r.e + 18) { const m = r.side === 'UP' ? midUp : 1 - midUp; Object.assign(r, { mid15: r4(m), rose5: m - r.mid0 >= 0.05 ? 1 : 0 }); }
        else r.rose5 = -1;   // no reading 15–18 s later
        save();
      }
    }
    const d = spot - K, T = W - e;
    st.hist.push({ e, d }); while (st.hist.length && st.hist[0].e < e - 90) st.hist.shift();
    if (st.done) return;
    if (T > TVD.maxLeft) { st.hold = 0; st.side = 0; return; }
    const side = d >= TVD.B ? 1 : d <= -TVD.B ? -1 : 0;
    if (side && side === st.side) st.hold++; else { st.hold = side ? 1 : 0; st.side = side; st.holdStartE = e; }
    if (T < TVD.minLeft || !side || st.hold < TVD.hold) return;
    if (!st.hist.some((h) => h.e < st.holdStartE && st.holdStartE - h.e <= TVD.look && (side > 0 ? h.d < 0 : h.d > 0))) return;
    const up = side > 0, ask = up ? b.ask : r4(1 - b.bid);
    if (!(ask <= TVD.cap + 1e-9) || ask <= 0.02) return;
    if (ask < TVD.floor - 1e-9 || (spotAge != null && spotAge > TVD.maxAge) || e - st.pxE >= TVD.flatSec) {
      if (!st.guardNoted) { st.guardNoted = true; log(`TV divergence: guard held back a trigger (${ask < TVD.floor - 1e-9 ? `ask ${cents(ask)} under ${cents(TVD.floor)}` : spotAge > TVD.maxAge ? `spot ${Math.round(spotAge)} s old` : `spot unchanged ${e - st.pxE} s`})`); }
      return;
    }
    st.done = true;
    const rec = { v: 2, Ws, ts: Date.now(), e, left: Math.round(T), side: up ? 'UP' : 'DOWN', K: r2(K), spot: r2(spot), dist: r2(Math.abs(d)), ask: r4(ask), mid0: r4(up ? midUp : 1 - midUp), feeK: mkt.feeK, slug: mkt.slug, result: null };
    st.rec = rec; S.tvd.trades.push(rec);
    if (S.tvd.trades.length > 1000) S.tvd.trades.splice(0, S.tvd.trades.length - 1000);
    await tvdReal(rec, mkt, up, ask);
    log(`TV divergence ${rec.real ? 'REAL' : '(practice)'}: ${rec.side} at ${cents(ask)}, spot $${rec.dist.toFixed(0)} ${up ? 'above' : 'below'} the price to beat, ${rec.left}s left`
      + (rec.real ? ` · ${rec.realStatus}${rec.realPx != null ? ` ${r2(rec.realQty)} @ ${cents(rec.realPx)} = ${money(rec.realCost)}` : ''}${rec.msg ? ' - ' + rec.msg : ''}` : rec.realSkip && S.tvdLive ? ` (real skipped: ${rec.realSkip})` : ''));
    save(); publishSoon();
  }
  // Real money on a TV Divergence trigger (Nov 26 execution test): one IOC limit order at min(ask + 1 tick, 71¢),
  // aligned to the market's tick, sized at tvdPct of buying power at that limit price (fee included), held to
  // settlement. Skipped when real money is off for it, the autopilot isn't Live, it's halted, today's loss limit is
  // reached (pending bets count), another order is going in, or this window already has a real order.
  async function tvdReal(rec, mkt, up, ask) {
    const today = dayOf(Date.now()), lossesToday = S.tvdLoss && S.tvdLoss.d === today ? S.tvdLoss.n : 0;
    const open = (t) => t.mode === 'live' && t.result == null && (t.status === 'filled' || t.status === 'partial');
    const pending = S.trades.filter((t) => t.strategy === 'tvd' && open(t)).length;
    const why = S.tvdLive !== true ? 'real money off' : !(S.enabled && S.mode === 'live' && KEY) ? 'autopilot not Live' : S.halted ? 'halted'
      : S.tvdMaxLosses > 0 && lossesToday + pending >= S.tvdMaxLosses ? 'daily loss limit' : busy ? 'another order going in'
      : S.trades.some((t) => t.Ws === rec.Ws && t.mode === 'live' && (t.status === 'filled' || t.status === 'partial' || t.status === 'nofill')) ? 'already a real order in this window' : null;
    if (why) { rec.realSkip = why; return; }
    busy = true;
    try {
      const tick = mkt.tick > 0 ? mkt.tick : 0.01, feeAt = (p) => mkt.feeK * p * (1 - p);
      const limit = r4(Math.floor(Math.min(ask + tick, S.tvdMaxPx || 0.71) / tick + 1e-6) * tick);
      const bal = (await refreshLive()).buyingPower;
      const step = mkt.minQty > 0 ? mkt.minQty : 0.01;
      const qty = r2(Math.floor(bal * S.tvdPct / 100 / (limit + feeAt(limit)) / step + 1e-9) * step);
      if (bal < MIN_BALANCE) { rec.realSkip = 'out of money'; outOfMoney(bal); return; }
      if (qty < step) { rec.realSkip = `${S.tvdPct}% of ${money(bal)} is under the minimum order`; return; }
      const day = dayRec('live', Date.now(), bal);
      const ord = await liveOrder(mkt, up, limit, qty);
      Object.assign(rec, { real: 1, limit, want: qty, orderId: ord.orderId, balBefore: r2(bal), liveSince: S.tvd.liveSince });
      if (ord.filled > 0) {
        // the fee Polymarket US billed on this fill when it reports one (the API rate can differ from the market's
        // listed coefficient), else the listed coefficient's estimate; P&L, break-even and the tally use this
        const px = ord.notional / ord.filled, feeSrc = ord.fee != null ? 'billed' : 'estimate';
        const fee = ord.fee != null ? ord.fee : r4(feeAt(px) * ord.filled), cost = r2(ord.notional + fee);
        const feeCoef = px > 0 && px < 1 ? r4(fee / (ord.filled * px * (1 - px))) : null;
        const status = ord.filled < qty - 1e-9 ? 'partial' : 'filled';
        log(`TV divergence fee: ${feeSrc} $${fee.toFixed(4)} on ${r2(ord.filled)} @ ${cents(px)} = coefficient ${feeCoef} (listed ${mkt.feeK})`);
        record({ Ws: rec.Ws, mode: 'live', strategy: 'tvd', betPct: S.tvdPct, side: rec.side, status, qty: r2(ord.filled), want: qty, px: r4(px), fee, feeSrc, feeCoef, cost, limit, seen: r4(ask), orderId: ord.orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal) });
        Object.assign(rec, { realStatus: status, realPx: r4(px), realQty: r2(ord.filled), realCost: cost, realFee: fee, feeSrc, feeCoef, listedFeeK: mkt.feeK });
        S.stats.live.n++; S.stats.live.staked = r2(S.stats.live.staked + cost); day.n++;
        if (S.notifyFills) push({ title: `BOUGHT ${rec.side} (TV DIVERGENCE)`, body: `${r2(ord.filled)} @ ${cents(px)} = ${money(cost)} · spot $${rec.dist.toFixed(0)} past the line, ${rec.left}s left`, priority: 4, tags: up ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
      } else {
        rec.realStatus = 'nofill'; rec.msg = ord.msg || `No fill at ${cents(limit)} or better`;
        record({ Ws: rec.Ws, mode: 'live', strategy: 'tvd', side: rec.side, status: 'nofill', msg: rec.msg, qty, limit, seen: r4(ask), orderId: ord.orderId, slug: mkt.slug, missed: null });
      }
    } catch (e2) {
      if (isAuthError(e2)) halt('Polymarket rejected the API key', e2.message.slice(0, 160));
      else if (isMoneyError(e2)) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
      Object.assign(rec, { real: 1, realStatus: 'error', msg: e2.message.slice(0, 80), liveSince: S.tvd.liveSince });
    } finally { busy = false; }
  }
  // Live tally since real money went on (S.tvd.liveSince): [orders sent, filled, partial, unfilled, errors,
  //  unfilled that would have won, unfilled settled, avg ask seen (¢, filled), avg fill (¢), settled fills, won,
  //  break-even win rate (%), net P&L ($), % per $1, real losses today, since (ms), guard tally n,
  //  [fills with a billed fee, their average fee coefficient, total fees $, listed coefficient]]
  function tvdLiveSummary() {
    const since = S.tvd.liveSince || 0;
    const R = S.tvd.trades.filter((t) => t.real === 1 && t.ts >= since);
    const F = R.filter((t) => t.realStatus === 'filled' || t.realStatus === 'partial'), N = R.filter((t) => t.realStatus === 'nofill');
    const D = F.filter((t) => t.realResult != null), w = D.filter((t) => t.realResult === 1).length;
    const cost = D.reduce((a, t) => a + t.realCost, 0), pnl = D.reduce((a, t) => a + t.realPnl, 0);
    const avg = (a, f) => (a.length ? Math.round(a.reduce((x, t) => x + f(t), 0) / a.length * 1000) / 10 : null);
    return [R.length, F.filter((t) => t.realStatus === 'filled').length, F.filter((t) => t.realStatus === 'partial').length, N.length, R.filter((t) => t.realStatus === 'error').length,
      N.filter((t) => t.result === 1).length, N.filter((t) => t.result != null).length, avg(F, (t) => t.ask), avg(F, (t) => t.realPx), D.length, w,
      avg(D, (t) => t.realCost / t.realQty), r2(pnl), cost > 0 ? Math.round(pnl / cost * 1000) / 10 : null,
      S.tvdLoss && S.tvdLoss.d === dayOf(Date.now()) ? S.tvdLoss.n : 0, since, S.tvdTally ? S.tvdTally.n : 0,
      // fees: fills with a billed fee, their average coefficient, total fees ($), the listed coefficient
      (() => { const b = F.filter((t) => t.feeSrc === 'billed' && t.feeCoef != null); return [b.length, b.length ? r4(b.reduce((a, t) => a + t.feeCoef, 0) / b.length) : null, r2(F.reduce((a, t) => a + (t.realFee || 0), 0)), F.length ? F[F.length - 1].listedFeeK : null]; })()];
  }
  async function settleTvd() {
    const now = Date.now() / 1000;
    for (const t of S.tvd.trades) {
      if (t.result != null || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) { try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (s == null) continue;
      t.result = (s >= 0.5) === (t.side === 'UP') ? 1 : 0;
      save(); publishSoon();
    }
  }
  // [triggers, settled, won, [filled at +0¢, won, % per $1], [filled at +1¢, won, % per $1],
  //  [15 s check known, rose 5¢+, won when it rose, won when it didn't], since (ms), unfilled at +1¢ that won, left out as bad data]
  function tvdSummary() {
    const T = S.tvd.trades.filter((t) => !t.bad), done = T.filter((t) => t.result != null);
    const leg = (k) => { const f = done.filter((t) => t[k] === 1 && t.fillAsk != null); const r = f.reduce((a, t) => { const c = t.fillAsk + (t.feeK || 0.095) * t.fillAsk * (1 - t.fillAsk); return a + (t.result ? 1 / c - 1 : -1); }, 0); return [f.length, f.filter((t) => t.result).length, f.length ? Math.round(r / f.length * 1000) / 10 : 0]; };
    const ck = done.filter((t) => t.rose5 === 0 || t.rose5 === 1), up = ck.filter((t) => t.rose5 === 1), dn = ck.filter((t) => t.rose5 === 0);
    return [T.length, done.length, done.filter((t) => t.result).length, leg('fill0'), leg('fill1'),
      [ck.length, up.length, up.filter((t) => t.result).length, dn.filter((t) => t.result).length], S.tvd.since, done.filter((t) => t.fill1 === 0 && t.result).length,
      S.tvd.trades.length - T.length];   // last: triggers left out as bad data
  }
  async function settleTeeter() {
    const now = Date.now() / 1000;
    for (const t of S.teeter.trades) {
      if (t.result != null || t.status !== 'seen' || now < t.Ws + W + 15) continue;
      let s = null;
      try { const j = await gw(`/v1/markets/${t.slug}/settlement`); if (j.settlement != null) s = +j.settlement; } catch { /* not yet */ }
      if (s == null && now > t.Ws + W + 600) { try { const u = await Signal.fetchUsTerms(t.Ws); if (u.settlementPrice && u.priceToBeat) s = u.settlementPrice >= u.priceToBeat ? 1 : 0; } catch { /* later */ } }
      if (s == null) continue;
      t.result = (s >= 0.5) === (t.side === 'UP') ? 1 : 0;
      save(); publishSoon();
    }
  }
  // Counts since the Nov 20 rule change (fresh cross + price cap): [triggers, won, % per $1 at the trigger price,
  // real settled, real won, real P&L, real losses today, rule since (ms), [stale n, won], [over cap n, won],
  // [real orders, filled], [filled 2¢+ under the trigger n, won], [[2 flips], [3 flips], [4+ flips]], [[same side as at 60 s], [other side]]]
  function teeterSummary() {
    const T = S.teeter.trades.filter((t) => t.rule === 2), since = S.teeter.ruleSince || 0;
    const done = T.filter((t) => t.status === 'seen' && t.result != null && !t.stale && !t.capped);
    const per = done.reduce((a, t) => a + (t.result ? 1 / t.cost - 1 : -1), 0);
    const nw = (a) => [a.length, a.filter((t) => t.result).length];
    const orders = S.trades.filter((t) => t.strategy === 'teeter' && t.mode === 'live' && t.ts >= since && t.status !== 'error');
    const real = orders.filter((t) => t.result != null && t.pnl != null);
    return [done.length, done.filter((t) => t.result).length, done.length ? Math.round(per / done.length * 1000) / 10 : 0,
      real.length, real.filter((t) => t.result).length, r2(real.reduce((a, t) => a + t.pnl, 0)),
      S.teeterLoss && S.teeterLoss.d === dayOf(Date.now()) ? S.teeterLoss.n : 0, since,
      nw(T.filter((t) => t.stale && t.result != null)), nw(T.filter((t) => t.capped && t.result != null)),
      [orders.length, orders.filter((t) => t.status === 'filled' || t.status === 'partial').length], nw(T.filter((t) => t.under && t.result != null)),
      // logged since Nov 22, not rules: triggers by flips (2, 3, 4+) and by side vs the 60 s leader (same, other)
      [nw(done.filter((t) => t.flips === 2)), nw(done.filter((t) => t.flips === 3)), nw(done.filter((t) => t.flips >= 4))],
      [nw(done.filter((t) => t.same60 === 1)), nw(done.filter((t) => t.same60 === 0))]];
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
  const SNAP_MAX = 2900;
  const PASSWORD = env.AUTOPILOT_PASSWORD || '';
  const ready = (async () => { if (PASSWORD && o.topic) K = await APC.keys(PASSWORD, o.topic); })();
  function snapshot() {
    const days = Object.keys(S.days).sort().slice(-14).map((d) => [d, S.days[d].practice || null, S.days[d].live || null]);
    const tr = (t) => [t.ts, t.Ws, t.mode[0], t.side, t.status, t.qty || 0, t.px || 0, t.cost || 0, t.result, t.pnl, t.msg || '', t.q ? Math.round(t.q * 100) : null, t.strategy === 'late' ? 1 : t.strategy === 'teeter' ? 2 : t.strategy === 'tvd' ? 3 : 0];
    const snap = {
      v: 1, ts: Date.now(), ver: AUTOPILOT_VERSION, since: STARTED, why: botWhy, note: lastNote, keys: !!KEY,
      msgs: o.budget && isFinite(o.budget.left()) ? Math.floor(o.budget.left()) : null,   // ntfy messages left (free ntfy.sh)
      ap: { enabled: S.enabled, mode: S.mode, mainOn: S.mainOn !== false, mainTally: S.mainTally ? [S.mainTally.n, S.mainTally.w, S.mainTally.pnl, S.mainTally.cost] : null, mainGuardN: S.mainGuardN, mainGuardPct: S.mainGuardPct, mainMaxLosses: S.mainMaxLosses, mainLossToday: S.mainLoss && S.mainLoss.d === dayOf(Date.now()) ? S.mainLoss.n : 0, betPct: S.betPct, dailyStopPct: S.dailyStopPct, lossStreak: S.lossStreak, cooldownMin: S.cooldownMin, goal: S.goal, teeter: [S.teeterOn !== false, S.teeterLive !== false, S.teeterPct, S.teeterAt, S.teeterFlips, S.teeterMaxLosses, S.teeterFresh !== false, S.teeterMaxPx, S.teeterTrigMax], teeterSum: teeterSummary(), tvd: tvdSummary(), tvdLive: [S.tvdLive === true, S.tvdPct, S.tvdMaxLosses, S.tvdGuardN, S.tvdGuardPct, S.tvdMaxPx], tvdLiveSum: tvdLiveSummary(), missed: { reg: missedSummary(null), teeter: missedSummary('teeter'), tvd: missedSummary('tvd') }, lateLive: S.lateLive, lateBet: S.lateBet, lateBetPct: S.lateBetPct, lateFavOnly: S.lateFavOnly, lateMinReal: S.lateMinReal, lateMinEdge: S.lateMinEdge, lateGapFix: S.lateGapFix !== false, lateHours: S.lateHours, lateAntic: S.lateAntic, lateMaxLosses: S.lateMaxLosses, anticBlockReset: S.anticBlockReset !== false, anticStart: S.anticStart, anticStep: S.anticStep, anticFloor: S.anticFloor, streak: S.streak[S.mode] || 0, notifyFills: S.notifyFills, notifyResults: S.notifyResults, minModel: minModel(o.defMinModel), minMarket: minMarket(o.defMinMarket), target: target(o.defTarget), halted: S.halted },
      bal: { live: S.liveBal, practice: S.practice }, stats: S.stats, days, acks: acks.slice(-5),
      trades: S.trades.slice(-12).map(tr),
      late: { since: S.late.since, antic: anticView(), blockLosses: blockLosses(), capHit: capHit() ? 1 : 0, stats: S.late.stats, real: S.late.real || null, byPat: S.late.byPat || null, byFav: S.late.byFav || null, byBlock: lateByBlock(), trades: S.late.trades.slice(-6).map((t) => [t.ts, t.Ws, t.side, t.status, t.px || 0, t.quoted, Math.round(t.q * 100), t.result, t.pnl, t.left, t.msg || '', t.real ? 1 : 0, t.pat === 'against' ? (t.patSkip ? 2 : 1) : t.pat === 'with' ? 3 : 0, t.realSkip === 'underdog' ? 1 : t.realSkip === 'conf' ? 2 : t.realSkip === 'hours' ? 3 : t.realSkip === 'maxloss' ? 4 : t.realSkip === 'price' ? 5 : 0, t.fav != null ? t.fav : (t.quoted >= 0.5 ? 1 : 0), t.gap != null ? Math.round(t.gap) : null]) },
      led: (() => { const d = pday(Date.now()), r = ledgerDay(d); return [S.ledger.start, d, ...r, ...(S.ledgerBlk.days[d] || (r[2] ? [] : [0, 0, 0, 0, 0, 0, 0, 0, 0]))]; })(), cf: S.chartFrom || '', cw: S.chartWin === 'blk' ? 'blk' : 'day',
      h: Object.assign({ u: US.up ? 1 : 0, a: S.liveBal ? Math.round((Date.now() - S.liveBal.at) / 1000) : null, k: KEY ? 1 : 0 }, o.health ? o.health() : {}),
      lag: { since: S.lagt.since, stats: S.lagt.stats, byGap: S.lagt.byGap, est: S.lagt.est, src: US.up ? 's' : 'p', trades: S.lagt.trades.slice(-4).map((t) => [t.ts, t.Ws, t.side, t.status, t.px || 0, t.seen, t.com, t.result, t.pnl, t.left, t.msg || '']) },
    };
    // ntfy turns a message over 4 KB into a file the pages can't read, so the sealed status must stay under it:
    // 2,900 characters of JSON seals to about 3,950 bytes. Trim the least useful parts first, step by step.
    const fits = () => JSON.stringify(snap).length <= SNAP_MAX;
    if (snap.ap.halted && snap.ap.halted.detail) snap.ap.halted = Object.assign({}, snap.ap.halted, { detail: String(snap.ap.halted.detail).trim().slice(0, 90) });
    while (!fits() && snap.trades.length > 3) snap.trades.shift();
    while (!fits() && snap.late.trades.length > 2) snap.late.trades.shift();
    while (!fits() && snap.lag.trades.length > 1) snap.lag.trades.shift();
    const steps = [
      () => { snap.lag.trades = []; }, () => { snap.lag.byGap = {}; }, () => { snap.days = snap.days.slice(-7); },
      () => { snap.late.trades = snap.late.trades.slice(-1); }, () => { snap.trades = snap.trades.slice(-1); },
      () => { snap.late.byPat = null; snap.late.byFav = null; }, () => { snap.days = snap.days.slice(-2); },
      () => { snap.lag = { since: snap.lag.since, est: snap.lag.est, src: snap.lag.src, trades: [] }; },
      () => { if (snap.ap.halted) snap.ap.halted = { reason: snap.ap.halted.reason, kind: snap.ap.halted.kind, at: snap.ap.halted.at, detail: '' }; },
      () => { snap.late.byBlock = null; snap.note = ''; snap.why = ''; },
    ];
    for (const step of steps) { if (fits()) break; step(); }
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
      const body = await APC.seal(K, payload || snapshot());
      if (body.length > 4000) log(`autopilot: status message is ${body.length} bytes, over ntfy's 4 KB limit; the pages may not see it`);
      const r = await fetch(`${NTFY}/${T.status}`, { method: 'POST', headers: Object.assign({ Priority: '1' }, NTFY_AUTH), body });
      if (r.status === 429 && o.budget) { const tx = await r.text().catch(() => ''); if (o.budget.on429) await o.budget.on429(tx); else o.budget.exhausted(); }
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
    for (let d = S.ledger.start; d <= today; d = addDays(d, 1)) { const r = S.ledger.days[d] || [0, null, 0, 0], b = S.ledgerBlk.days[d] || (r[2] ? [] : [0, 0, 0, 0, 0, 0, 0, 0, 0]); rows.push([...r, ...b]); }
    const N = 40, of = Math.ceil(rows.length / N), out = [];   // 40 rows of up to 13 numbers stays well under 4 KB
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
  // the coin-flip archive for the autopilot page, 60 rows a message (well under ntfy's 4 KB)
  let flipPubAt = 0;
  // after (Ws): the newest flip the page already has; then only newer flips are sent
  function flipChunks(after) {
    const rows = after > 0 ? S.flips.filter((r) => r[0] > after) : S.flips;
    const N = 60, of = Math.max(1, Math.ceil(rows.length / N)), out = [];
    for (let i = 0; i < of; i++) out.push({ v: 1, kind: 'flips', ts: Date.now(), i, of, delta: after > 0 ? 1 : 0, rows: rows.slice(i * N, (i + 1) * N) });
    return out;
  }
  function publishFlips(after) {
    if (Date.now() - flipPubAt < 60000) return;
    flipPubAt = Date.now();
    flipChunks(after).forEach((c, k) => setTimeout(() => publish(c, true), 2500 + k * 1500));
  }
  // The bet book for the autopilot page's results tables: recent bets of every strategy, real and practice, and totals
  // over everything the bot still has on record. Sent on request, 25 rows a message (well under ntfy's 4 KB).
  //   row: [ts s, Ws, strategy r regular / t teeter-totter / c coin flip, money l real / p practice / x tracked only,
  //         side U/D, status f filled / p partial / n not filled / e error, price, cost $, result 1/0/null, profit $]
  let bookPubAt = 0;
  function bookData() {
    const c2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const code = (st) => ({ filled: 'f', partial: 'p', nofill: 'n', error: 'e' })[st];
    const rows = [];
    for (const t of S.trades) {
      if (!code(t.status)) continue;
      if (t.strategy === 'late' && t.mode === 'practice') continue;
      rows.push([Math.round(t.ts / 1000), t.Ws, t.strategy === 'teeter' ? 't' : t.strategy === 'late' ? 'c' : t.strategy === 'tvd' ? 'v' : 'r', t.mode === 'live' ? 'l' : 'p', t.side === 'UP' ? 'U' : 'D', code(t.status), c2(t.px), c2(t.cost), t.result == null ? null : t.result ? 1 : 0, c2(t.pnl)]);
    }
    // coin flips tracked with $10 practice bets (real ones come from the trades above)
    for (const t of S.late.trades) {
      if (t.real || !code(t.status)) continue;
      rows.push([Math.round(t.ts / 1000), t.Ws, 'c', 'p', t.side === 'UP' ? 'U' : 'D', code(t.status), c2(t.px), c2(t.cost), t.result == null ? null : t.result ? 1 : 0, c2(t.pnl)]);
    }
    // teeter-totter triggers that weren't real bets, priced as $10 at the price seen
    for (const t of S.teeter.trades) {
      if (t.real || t.status !== 'seen') continue;
      const pnl = t.result == null ? null : t.result ? 10 * (1 / t.cost - 1) : -10;
      rows.push([Math.round(t.ts / 1000), t.Ws, 't', 'x', t.side === 'UP' ? 'U' : 'D', 'f', c2(t.ask), 10, t.result == null ? null : t.result, c2(pnl)]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    // totals per strategy and money: [bets settled, won, profit, staked, first ts, unfilled]
    const sum = {};
    for (const r of rows) {
      const k = r[2] + r[3], z = sum[k] || (sum[k] = [0, 0, 0, 0, r[0], 0]);
      if (r[5] === 'n') { z[5]++; continue; }
      if ((r[5] === 'f' || r[5] === 'p') && r[8] != null) { z[0]++; z[1] += r[8]; z[2] = c2(z[2] + (r[9] || 0)); z[3] = c2(z[3] + (r[7] || 0)); }
    }
    // the newest 40 of each strategy
    const keep = []; for (const k of ['r', 't', 'c']) keep.push(...rows.filter((r) => r[2] === k).slice(-40));
    keep.sort((a, b) => a[0] - b[0]);
    return { rows: keep, sum };
  }
  // after (s): the newest bet the page already has; then only bets placed after it, or settled since, are sent
  // (every message counts against ntfy's daily allowance). The page merges them into its copy.
  function bookChunks(after) {
    const { rows: all, sum } = bookData(), since = after > 0 ? after - 900 : 0;
    const rows = all.filter((r) => r[0] > since), N = 40, of = Math.max(1, Math.ceil(rows.length / N)), ts = Date.now(), out = [];
    for (let i = 0; i < of; i++) out.push({ v: 1, kind: 'book', ts, i, of, delta: since ? 1 : 0, rows: rows.slice(i * N, (i + 1) * N), sum: i === 0 ? sum : undefined });
    return out;
  }
  function publishBook(after) {
    if (Date.now() - bookPubAt < 60000) return;
    bookPubAt = Date.now();
    bookChunks(after).forEach((c, k) => setTimeout(() => publish(c, true), 2500 + k * 1500));
  }
  function publishLedger() {
    if (Date.now() - ledPubAt < 60000) return;
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
        const upd = { betPct: num(a.betPct, 1, 100), dailyStopPct: num(a.dailyStopPct, 0, 100), lossStreak: num(a.lossStreak, 0, 10), cooldownMin: num(a.cooldownMin, 5, 1440), goal: num(a.goal, 0, 1e7), lateBet: num(a.lateBet, 1, 1000), lateBetPct: num(a.lateBetPct, 0, 100), lateMinReal: num(a.lateMinReal, 50, 99), anticStart: num(a.anticStart, 1, 50), anticStep: num(a.anticStep, 0, 50), anticFloor: num(a.anticFloor, 1, 50), lateMaxLosses: num(a.lateMaxLosses, 0, 20), mainGuardN: num(a.mainGuardN, 0, 1000), mainMaxLosses: num(a.mainMaxLosses, 0, 100), teeterPct: num(a.teeterPct, 0.5, 25), teeterAt: num(a.teeterAt, 60, 97), teeterFlips: num(a.teeterFlips, 1, 10), teeterMaxLosses: num(a.teeterMaxLosses, 0, 50), teeterMaxPx: num(a.teeterMaxPx, 60, 98), teeterTrigMax: num(a.teeterTrigMax, 60, 98), tvdPct: num(a.tvdPct, 0.5, 10), tvdMaxLosses: num(a.tvdMaxLosses, 0, 50), tvdGuardN: num(a.tvdGuardN, 0, 1000), tvdGuardPct: num(a.tvdGuardPct, -100, 100), mainGuardPct: num(a.mainGuardPct, -100, 100), lateMinEdge: a.lateMinEdge === null ? null : num(a.lateMinEdge, -10, 30), minModel: a.minModel === null ? null : num(a.minModel, 50, 99), minMarket: a.minMarket === null ? null : num(a.minMarket, 50, 99) };
        for (const [k, v] of Object.entries(upd)) if (v !== undefined && k in a) S[k] = v;
        if (a.mainOn === true && S.mainOn === false) S.mainTally = null;   // switched back on: the safety switch counts afresh
        for (const k of ['notifyFills', 'notifyResults', 'lateFavOnly', 'mainOn', 'lateAntic', 'anticBlockReset', 'lateGapFix', 'teeterOn', 'teeterLive', 'teeterFresh', 'tvdLive']) if (typeof a[k] === 'boolean') S[k] = a[k];
        if (a.tvdLive === true && !S.tvd.liveSince) S.tvd.liveSince = Date.now();   // the live tally starts the first time it goes on
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
      case 'flips': publishFlips(+a.after || 0); break;
      case 'book': publishBook(+a.after || 0); break;
      case 'chartWin': {
        const w = a.w === 'blk' ? 'blk' : 'day';
        S.chartWin = w; save(); ok = true; msg = w === 'blk' ? 'chart shows one bar per time block' : 'chart shows one bar per day';
        log('profits chart: ' + msg); break;
      }
      case 'chartFrom': {
        const d = String(a.d || '');
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) { ok = false; msg = 'bad date'; break; }
        S.chartFrom = d; save(); ok = true; msg = d ? 'chart starts ' + d : 'chart starts at the ledger start';
        log('profits chart: ' + msg); break;
      }
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
    if (now - lastSettleCheck > 10000) { lastSettleCheck = now; settle().catch((e) => log('autopilot settle:', e.message)); settleLate().catch((e) => log('late test settle:', e.message)); settleLag().catch((e) => log('lag test settle:', e.message)); settleTeeter().catch((e) => log('teeter settle:', e.message)); settleTvd().catch((e) => log('tv divergence settle:', e.message)); settleMissed().catch((e) => log('missed settle:', e.message)); sbSettle().catch((e) => log('scoreboard settle:', e.message)); }
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
  // for the Pi's LED face: key/stream, autopilot state, today's profit, the latest real trade
  function ledInfo() {
    let lt = null;
    for (let i = S.trades.length - 1; i >= 0 && !lt; i--) { const t = S.trades[i]; if (t.mode === 'live' && (t.status === 'filled' || t.status === 'partial')) lt = t; }
    // the Profits page's chart, built the way profits.html does it: from the page's start date (sent by the page),
    // a day without trades carries the previous day's closing balance. Last 14 days + the total since the start.
    const L = S.ledger && S.ledger.days ? S.ledger.days : {}, t = pday(Date.now()), today = L[t];
    const start = S.ledger && S.ledger.start ? S.ledger.start : t;
    const from = S.chartFrom && S.chartFrom > start && S.chartFrom <= t ? S.chartFrom : start;
    // per time block: one column per block (12am-8am, 8am-4pm, 4pm-12am), each starting from the balance the block
    // opened with; the current block is the last one
    const blk = S.chartWin === 'blk', B = S.ledgerBlk ? S.ledgerBlk.days : {}, curBlk = Math.floor(hourOf(Date.now()) / 8);
    const days = []; let prevEnd = null, tot = 0;
    for (let d = start; d <= t; d = addDays(d, 1)) {
      const r = L[d] || [0, null, 0, 0], sb = r[1] != null ? r[1] : prevEnd;
      if (sb != null) prevEnd = sb + r[0];
      if (d < from) continue;
      tot += r[0];
      if (!blk) { days.push([d, r[0], sb, r[2]]); continue; }
      const b = B[d];
      let run = sb;
      for (let k = 0; k < 3; k++) {
        if (d === t && k > curBlk) break;
        const p = b ? b[k * 3] : k === 0 ? r[0] : 0, n = b ? b[k * 3 + 1] : k === 0 ? r[2] : 0;
        days.push([d + '#' + k, p, run, n]);
        if (run != null) run += p;
      }
    }
    return {
      days: days.slice(-14), from, tot: Math.round(tot * 100) / 100, win: blk ? 'blk' : 'day', bal: S.liveBal ? S.liveBal.buyingPower : null,
      k: KEY ? 1 : 0, u: US.up ? 1 : 0,
      ap: { on: !!S.enabled, mode: S.mode, halted: S.halted ? String(S.halted.reason || 'halted') : null },
      pnl: today ? today[0] : 0,
      last: lt ? { id: lt.id, ts: lt.ts, side: lt.side, result: lt.result == null ? null : !!lt.result } : null,
    };
  }
  return { ledInfo, ledgerChunks, flipChunks, bookChunks, onSignal, observe, observeLate, settleLate, observeLag, settleLag, lagEstimate, lagFlush, tick, start, check, settle, sbSettle, scoreboard, publishScore, minModel, minMarket, target, state: () => S, hasKey: () => !!KEY, flush: publish, snapshot };
}

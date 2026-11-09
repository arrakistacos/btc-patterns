#!/usr/bin/env node
/*
 * BTC Pattern Watch — signal bot
 * Watches the same live feeds as the web app (Coinbase price + Polymarket odds), makes the exact same
 * BUY / WAIT decision (shared signal.js + engine.js), and sends an urgent phone push through ntfy
 * (https://ntfy.sh — free iPhone/Android app) the moment BUY NOW fires. Built to run 24/7 on a Raspberry Pi.
 *
 *   NTFY_TOPIC=your-secret-topic node tools/signal-bot.mjs           # run
 *   NTFY_TOPIC=your-secret-topic node tools/signal-bot.mjs --test    # send one test push and exit
 *   node tools/signal-bot.mjs --dry                                   # run without sending (prints instead)
 *
 * Settings (environment variables):
 *   NTFY_TOPIC   required (except --dry). Pick something long and random: anyone who knows it can read it.
 *   NTFY_SERVER  default https://ntfy.sh
 *   NTFY_TOKEN   optional access token for a protected topic
 *   TARGET       confidence target, 60–95 (default 80)
 *   BANKROLL     optional; adds the exact $ amount and share count to each alert
 *   MAX_PER_WINDOW  alerts per 5-minute window (default 1)
 *   MIN_MODEL    only alert when the model's win chance for the side is at least this % (default 80)
 *   MIN_MARKET   ...and Polymarket's own odds for that side are at least this % (default 80)
 *   SITE         where to fetch tuned params.json / data/edge.json (default the GitHub Pages site)
 *   TZ_NAME      time zone for times in alerts (default America/Chicago)
 *   LOG_EVERY    seconds between status lines in the log (default 60)
 *   LOG_FILE     also append the log to this file
 *   MARKET_URL   fixed page a BUY alert opens when tapped (default: that window's market on polymarket.us)
 *
 * Autopilot (tools/autopilot.mjs) trades each BUY alert on Polymarket US: practice by default, live with an
 * API key. Its settings live in polymarket.env next to the bot (PM_KEY_ID, PM_SECRET_KEY, AUTOPILOT_PASSWORD),
 * and you control it from the autopilot page. Check the key with:  node tools/signal-bot.mjs --check-autopilot
 *
 * Requires Node 22+ (built-in fetch and WebSocket).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutopilot } from './autopilot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const req = createRequire(import.meta.url);
const E = req(resolve(ROOT, 'engine.js'));
const Signal = req(resolve(ROOT, 'signal.js'));
const APC = req(resolve(ROOT, 'apcrypto.js'));

// Secrets for autopilot live in polymarket.env next to the bot (KEY=value lines), never in the code
const ENV_FILE = process.env.AUTOPILOT_ENV || resolve(ROOT, 'polymarket.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has('--dry');
const TEST = ARGS.has('--test');
const CHECK_AP = ARGS.has('--check-autopilot');
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || '';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';
const TARGET = Signal.Z_FOR[+process.env.TARGET] ? +process.env.TARGET : 80;
const BANKROLL = +process.env.BANKROLL || 0;
const MAX_PER_WINDOW = Math.max(1, +process.env.MAX_PER_WINDOW || 1);
const MIN_MODEL = process.env.MIN_MODEL != null && process.env.MIN_MODEL !== '' ? +process.env.MIN_MODEL : 80;   // % win chance from the model
const MIN_MARKET = process.env.MIN_MARKET != null && process.env.MIN_MARKET !== '' ? +process.env.MIN_MARKET : 80; // % Polymarket odds for that side
const SITE = (process.env.SITE || 'https://arrakistacos.github.io/btc-patterns/').replace(/\/?$/, '/');
const TZ_NAME = process.env.TZ_NAME || 'America/Chicago';
// Tapping a BUY alert opens that window's market on Polymarket US, e.g.
//   https://polymarket.us/event/btc-updown-5m-2026-11-08-2050z  (window start, UTC)
// Set MARKET_URL to override with a fixed page.
const usMarketUrl = (Ws) => Signal.usMarketUrl(Ws);
const marketUrl = (Ws) => process.env.MARKET_URL || usMarketUrl(Ws);
const W = 300, HEALTH_SEC = 5;
const LOG_EVERY = Math.max(1, +process.env.LOG_EVERY || 60);   // seconds between status lines

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Date.now() / 1000;
const bucket = (t) => Math.floor(t / W) * W;
const iso = (t) => new Date(t * 1000).toISOString();
const clock = (t) => new Date(t * 1000).toLocaleTimeString('en-US', { timeZone: TZ_NAME, hour: 'numeric', minute: '2-digit' });
const fmtLeft = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Optional log file (used by the Windows installer); also record crashes so the restart loop leaves a trace
if (process.env.LOG_FILE) {
  const { appendFileSync } = await import('node:fs');
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { orig(...a); try { appendFileSync(process.env.LOG_FILE, a.map((x) => (x && x.stack) || String(x)).join(' ') + '\n'); } catch { /* disk full / locked */ } };
  }
}
process.on('uncaughtException', (e) => { console.error(new Date().toISOString(), 'fatal:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(new Date().toISOString(), 'unhandled:', (e && e.stack) || e); });

if (!DRY && !CHECK_AP && !NTFY_TOPIC) { console.error('Set NTFY_TOPIC (or use --dry). See the comments at the top of this file.'); process.exit(1); }

// ---------------------------------------------------------------- push
async function push({ title, body, priority = 5, tags = 'rotating_light', click }) {
  if (DRY) { log(`[dry] PUSH p${priority}: ${title} — ${body}`); return true; }
  const headers = { Title: title, Priority: String(priority), Tags: tags };
  if (click) headers.Click = click;
  if (NTFY_TOKEN) headers.Authorization = 'Bearer ' + NTFY_TOKEN;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, { method: 'POST', headers, body });
      if (r.ok) return true;
      log('push failed: HTTP', r.status);
    } catch (e) { log('push failed:', e.message); }
    await sleep(1000 * (a + 1));
  }
  return false;
}

if (TEST) {
  const ok = await push({ title: 'BTC Pattern Watch test', body: `If you can hear this, alerts work. Target ${TARGET}%.`, click: SITE });
  console.log(ok ? 'Test push sent.' : 'Test push FAILED — check NTFY_TOPIC / network.');
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- one copy only
// Two copies would send double alerts and place double trades. Each running bot refreshes bot.lock every
// 20 s; a new copy that finds a fresh lock from another process waits and exits instead of trading.
if (!DRY && !CHECK_AP) {
  const { writeFileSync } = await import('node:fs');
  const LOCK = resolve(ROOT, 'bot.lock');
  const readLock = () => { try { return JSON.parse(readFileSync(LOCK, 'utf8')); } catch { return null; } };
  const other = readLock();
  if (other && other.pid !== process.pid && Date.now() - other.at < 60000) {
    log(`another copy of the bot is already running (pid ${other.pid}, topic ${String(other.topic || '').slice(0, 4)}…); this copy will exit. If you just reinstalled, restart the laptop to clear the old one.`);
    await sleep(60000);   // keeps a restart loop from spinning
    process.exit(0);
  }
  const started = Date.now();
  const touch = () => { try { writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now(), started, topic: NTFY_TOPIC })); } catch { /* ignore */ } };
  touch(); setInterval(() => {
    // if two started at once, the older one keeps running
    const l = readLock();
    if (l && l.pid !== process.pid && Date.now() - l.at < 60000 && (l.started || 0) <= started) { log(`another copy is running (pid ${l.pid}); exiting`); process.exit(0); }
    touch();
  }, 20000);
}

// ---------------------------------------------------------------- autopilot
const AP = createAutopilot({ dir: ROOT, log, push, Signal, APC, topic: NTFY_TOPIC, ntfyServer: NTFY_SERVER, ntfyToken: NTFY_TOKEN, site: SITE, tzName: TZ_NAME, defMinModel: MIN_MODEL, defMinMarket: MIN_MARKET, defTarget: TARGET });
if (CHECK_AP) {
  const r = await AP.check(Math.floor(Date.now() / 1000 / 300) * 300);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.keyLoaded ? (r.balance && r.balance.error ? 'Key loaded but Polymarket refused it — see balance.error above.' : 'Key works.') : 'No Polymarket US key found (PM_KEY_ID / PM_SECRET_KEY in polymarket.env).');
  process.exit(0);
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

// ---------------------------------------------------------------- tuned params + history table
let params = Object.assign({}, E.DEFAULT_WINDOW_PARAMS), edge = null, tunedAt = null;
async function loadTuning() {
  try {
    const p = await getJSON(SITE + 'params.json?ts=' + Date.now());
    if (p && p.window) { params = Object.assign({}, E.DEFAULT_WINDOW_PARAMS, p.window); tunedAt = p.generated; }
  } catch (e) { log('params.json:', e.message); }
  try { edge = await getJSON(SITE + 'data/edge.json?ts=' + Date.now()); } catch (e) { log('edge.json:', e.message); }
}

// ---------------------------------------------------------------- Coinbase candles + live trades
const C = [];          // 5m candles {t,o,h,l,c,v}
const ticks = [];      // [ts, price] last ~6 min, for time-weighted averages and momentum
let lastTrade = 0, lastCbMsg = 0, cbWs = null;
function upsert(k) {
  const last = C[C.length - 1];
  if (!last || k.t > last.t) C.push(k);
  else { const i = C.findIndex((x) => x.t === k.t); if (i >= 0) C[i] = k; }
  if (C.length > 1500) C.splice(0, C.length - 1500);
}
async function loadCandles(count) {
  let end = bucket(nowS()) + W;
  const rows = [];
  for (let got = 0; got < count; got += 290) {
    const start = end - 290 * W;
    const r = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${iso(start)}&end=${iso(end)}`);
    for (const x of r) rows.push({ t: x[0], l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] });
    if (!r.length) break;
    end = start;
    await sleep(150);
  }
  rows.sort((a, b) => a.t - b.t);
  for (const k of rows) upsert(k);
}
function onTrade(price, size, ts) {
  lastTrade = nowS();
  ticks.push([ts, price]);
  while (ticks.length && ticks[0][0] < ts - 400) ticks.shift();
  const t = bucket(ts), last = C[C.length - 1];
  if (!last || t > last.t) upsert({ t, o: last ? last.c : price, h: Math.max(price, last ? last.c : price), l: Math.min(price, last ? last.c : price), c: price, v: size });
  else if (t === last.t) { last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += size; }
}
function connectCoinbase() {
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  cbWs = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] })); log('coinbase connected'); };
  ws.onmessage = (e) => {
    lastCbMsg = nowS();
    const m = JSON.parse(e.data);
    if (m.type === 'ticker' && m.price) onTrade(+m.price, +(m.last_size || 0), m.time ? Date.parse(m.time) / 1000 : nowS());
  };
  ws.onclose = () => { if (cbWs === ws) { log('coinbase closed — reconnecting'); setTimeout(connectCoinbase, 2000); } };
  ws.onerror = () => {};
}
function twAvg(from, to) {
  let sum = 0, dur = 0, prev = null;
  for (const [t, p] of ticks) {
    if (prev && t > from) { const a = Math.max(prev[0], from), b = Math.min(t, to); if (b > a) { sum += prev[1] * (b - a); dur += b - a; } }
    prev = [t, p];
  }
  if (prev && to > Math.max(prev[0], from)) { const a = Math.max(prev[0], from); sum += prev[1] * (to - a); dur += to - a; }
  return dur > 0 ? sum / dur : null;
}
function priceAgo(sec) {
  const target = nowS() - sec;
  let best = null;
  for (const [t, p] of ticks) { if (t <= target) best = p; else break; }
  return best;
}

// ---------------------------------------------------------------- Polymarket odds for the current window
const pm = { t: null, token: null, ws: null, bid: null, ask: null, last: null, lastMsg: 0, ping: null };
async function pmRoll(t) {
  if (pm.t === t) return;
  pm.t = t; pm.token = null; pm.bid = pm.ask = pm.last = null; pm.lastMsg = 0;
  if (pm.ws) { pm.ws.onclose = null; try { pm.ws.close(); } catch { /* ignore */ } }
  clearInterval(pm.ping);
  for (let a = 0; a < 10 && pm.t === t; a++) {
    try {
      const m = (await getJSON(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${t}`))[0];
      if (m) { pm.token = JSON.parse(m.clobTokenIds)[JSON.parse(m.outcomes).indexOf('Up')]; break; }
    } catch { /* retry */ }
    await sleep(3000);
  }
  if (pm.t === t && pm.token) pmConnect(pm.token, t);
}
function pmConnect(token, t) {
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  pm.ws = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ assets_ids: [token], type: 'market', custom_feature_enabled: true })); pm.ping = setInterval(() => { try { ws.send('PING'); } catch { /* closed */ } }, 9000); };
  ws.onmessage = (e) => {
    if (e.data === 'PONG' || pm.token !== token) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    for (const x of Array.isArray(d) ? d : [d]) {
      if (x.event_type === 'best_bid_ask' && x.asset_id === token) { pm.bid = +x.best_bid; pm.ask = +x.best_ask; pm.lastMsg = nowS(); }
      else if (x.price_changes) { for (const c of x.price_changes) if (c.asset_id === token && c.best_bid != null) { pm.bid = +c.best_bid; pm.ask = +c.best_ask; pm.lastMsg = nowS(); } }
      else if (x.event_type === 'last_trade_price' && x.asset_id === token) { pm.last = +x.price; pm.lastMsg = nowS(); }
      else if (x.event_type === 'book' && x.asset_id === token) {
        const b = (x.bids || []).map((q) => +q.price), a = (x.asks || []).map((q) => +q.price);
        if (b.length) pm.bid = Math.max(...b); if (a.length) pm.ask = Math.min(...a); pm.lastMsg = nowS();
      }
    }
  };
  ws.onclose = () => { clearInterval(pm.ping); if (pm.t === t) setTimeout(() => { if (pm.t === t) pmConnect(token, t); }, 2000); };
  ws.onerror = () => {};
}
function pmMid() {
  if (pm.bid == null || pm.ask == null) return pm.last;
  if (pm.ask - pm.bid > 0.1 && pm.last != null) return pm.last;
  return (pm.bid + pm.ask) / 2;
}

// ---------------------------------------------------------------- pattern lean (refreshed once per candle)
let patternFor = null, patternZ = 0;
function closedCandles() { const t = nowS(); let end = C.length; while (end > 0 && C[end - 1].t + W > t) end--; return C.slice(0, end); }
function refreshPattern(closed) {
  const last = closed[closed.length - 1];
  if (!last || patternFor === last.t) return;
  try {
    const R = E.analyze(closed.slice(-1200), { interval: W });
    patternZ = R.prediction ? R.prediction.z : 0;
  } catch { patternZ = 0; }
  patternFor = last.t;
}

// ---------------------------------------------------------------- official price to beat (Polymarket US)
const ptb = { Ws: null, K: null, lastTry: 0, err: null };
function ensurePtb(Ws) {
  if (ptb.Ws !== Ws) Object.assign(ptb, { Ws, K: null, lastTry: 0, err: null });
  if (ptb.K != null || Date.now() - ptb.lastTry < 3000) return;
  ptb.lastTry = Date.now();
  Signal.fetchUsTerms(Ws).then((r) => {
    if (ptb.Ws === Ws && r.priceToBeat) { ptb.K = r.priceToBeat; ptb.err = null; log(`price to beat ${clock(Ws)} window: ${ptb.K.toFixed(2)} (Polymarket US, ${r.index || 'BRTI'})`); }
  }).catch((e) => { if (ptb.Ws === Ws) ptb.err = e.message; });
}

// ---------------------------------------------------------------- the decision, once per second
let sent = { Ws: null, n: 0 }, wasBuy = false, feedDownSince = null, feedDownWarned = false, lastStatus = 0, lastWhy = '';
function evaluate() {
  const t = nowS(), Ws = bucket(t), e = t - Ws, left = W - e;
  pmRoll(Ws);
  ensurePtb(Ws);
  if (sent.Ws !== Ws) { sent = { Ws, n: 0 }; wasBuy = false; }

  // health: both feeds must have fresh data
  const cbAge = t - (lastTrade || 0), pmAge = pm.lastMsg ? t - pm.lastMsg : Infinity;
  const healthy = cbAge < HEALTH_SEC && pmAge < HEALTH_SEC;
  if (cbAge > 120) {
    if (!feedDownSince) feedDownSince = t;
    if (!feedDownWarned && t - feedDownSince > 60) {
      feedDownWarned = true;
      push({ title: 'Signal bot: no price data', body: `No Coinbase trades for ${Math.round(cbAge)}s. Alerts are paused until it recovers.`, priority: 4, tags: 'warning' });
    }
  } else if (feedDownSince) {
    if (feedDownWarned) push({ title: 'Signal bot: back online', body: 'Price data is flowing again.', priority: 2, tags: 'white_check_mark' });
    feedDownSince = null; feedDownWarned = false;
  }

  let why;
  const closed = closedCandles();
  const mk = pmMid();
  if (closed.length < 60 || !C.length) why = 'loading candles';
  else if (!healthy) why = `feeds stale (coinbase ${cbAge.toFixed(1)}s, polymarket ${isFinite(pmAge) ? pmAge.toFixed(1) + 's' : '—'})`;
  else if (mk == null || pm.bid == null || pm.ask == null) why = 'waiting for odds';
  else if (e < Signal.START_SEC || e > Signal.END_SEC) why = e < Signal.START_SEC ? 'too early' : 'too late';
  else if (ptb.Ws !== Ws || ptb.K == null) why = 'waiting for the official price to beat' + (ptb.err ? ` (${ptb.err})` : '');
  else {
    refreshPattern(closed);
    const cur = C[C.length - 1];
    const K = ptb.K;   // official price to beat (Polymarket US)
    const S = cur.c, i = closed.length - 1;
    const sig0 = E.parkinsonSigma(closed, i, params.volBars, W);
    const pVol = E.windowUpProb({ S, K, sigma: sig0 * params.volScale, elapsed: e, mode: Signal.US_SETTLEMENT_MODE, W, avgSoFar: twAvg(Ws, t), avgLast60: twAvg(Ws + W - 60, t) });
    const vel = E.velocity(closed, i, params.velBars, sig0, W);
    const pUp = E.combineWindow(pVol, patternFor === closed[i].t ? patternZ : 0, vel, params);
    const favUp = mk >= 0.5, sign = favUp ? 1 : -1, favMid = favUp ? mk : 1 - mk;
    const ask = favUp ? pm.ask : 1 - pm.bid, cost = ask + Signal.fee(ask);
    const oursFav = favUp ? pUp : 1 - pUp;
    const p60 = priceAgo(60), mom = p60 != null ? Math.sign(S - p60) : null;
    const agree = oursFav >= favMid && mom === sign && Math.sign(vel) === sign;
    const hist = Signal.histCell(edge, e, favMid, agree);
    const w = { S, K, sigma: sig0 * params.volScale, left, e, Ws };
    const r = Signal.evalSignal({ w, favUp, ask, cost, oursFav, hist }, AP.target(TARGET));   // the autopilot page can change the target
    AP.observe({ Ws, e, w, favUp, ask, cost, oursFav, hist, favMid });   // settings scoreboard: every combination, every window
    // Alert filter: both the model's win chance and Polymarket's own odds for that side must reach the minimums
    const modelPct = r.buy ? r.q * 100 : 0, marketPct = favMid * 100;
    const minM = AP.minModel(MIN_MODEL), minK = AP.minMarket(MIN_MARKET);   // the autopilot page can change these
    const alertable = r.buy && modelPct >= minM - 1e-9 && marketPct >= minK - 1e-9;
    if (alertable) {
      if (!wasBuy && sent.n < MAX_PER_WINDOW) {
        sent.n++;
        const side = favUp ? 'UP' : 'DOWN';
        const title = `BUY ${side}`;
        const body = `MODEL ${Math.round(modelPct)}% · POLYMARKET ${Math.round(marketPct)}%`;
        log('ALERT →', side === 'UP' ? '[green]' : '[red]', title, '|', body, `| ask ${Math.round(ask * 100)}c, ${fmtLeft(left)} left`);
        push({ title, body, priority: 5, tags: side === 'UP' ? 'green_circle' : 'red_circle', click: marketUrl(Ws) });
        AP.onSignal({ Ws, favUp, q: r.q, modelPct, marketPct, left });
      }
      wasBuy = true;
      why = 'BUY';
    } else {
      wasBuy = false;
      why = r.buy ? `BUY, below alert minimums (model ${Math.round(modelPct)}%, polymarket ${Math.round(marketPct)}%)` : r.why;
    }
  }
  if (t - lastStatus >= LOG_EVERY - 0.05 || (why === 'BUY') !== (lastWhy === 'BUY')) {
    lastStatus = t;
    log(`[${fmtLeft(left)} left] ${why} · price ${C.length ? C[C.length - 1].c.toFixed(2) : '—'} · Up odds ${mk != null ? (mk * 100).toFixed(1) + '%' : '—'} · alerts this window ${sent.n}`);
  }
  lastWhy = why;
  AP.tick(why);
}

// ---------------------------------------------------------------- start
log(`Signal bot starting · target ${TARGET}% · alerts when model ≥ ${MIN_MODEL}% and polymarket ≥ ${MIN_MARKET}% · ${BANKROLL ? 'bankroll $' + BANKROLL : 'no bankroll set'} · ${DRY ? 'DRY RUN (no pushes)' : 'pushing to ' + NTFY_SERVER + '/' + NTFY_TOPIC.slice(0, 4) + '…'}`);
await loadTuning();
log('tuning:', JSON.stringify(params), tunedAt ? `(from ${tunedAt})` : '(defaults)', edge ? '· history loaded' : '· NO history (alerts need it)');
await loadCandles(1200);
log('candles loaded:', C.length);
connectCoinbase();
AP.start();
{ const s = AP.state(); log(`autopilot: ${s.enabled ? 'ON' : 'off'} · ${s.mode} · ${s.betPct}% per BUY · ${AP.hasKey() ? 'Polymarket US key loaded' : 'no Polymarket US key (practice only)'}${s.halted ? ' · HALTED: ' + s.halted.reason : ''}`); }
setInterval(evaluate, 1000);
setInterval(async () => { try { const rows = []; const end = bucket(nowS()) + W; const r = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${iso(end - 36 * W)}&end=${iso(end)}`); for (const x of r) rows.push({ t: x[0], l: +x[1], h: +x[2], o: +x[3], c: +x[4], v: +x[5] }); rows.sort((a, b) => a.t - b.t); for (const k of rows) { const cur = C.find((c) => c.t === k.t); if (!cur || k.t + W <= nowS()) upsert(k); } } catch (e) { log('resync:', e.message); } }, 60000);
setInterval(loadTuning, 30 * 60 * 1000);
setInterval(() => { if (nowS() - lastCbMsg > 20 && cbWs) { log('coinbase silent — reconnecting'); try { cbWs.close(); } catch { /* ignore */ } } }, 5000);
if (!DRY && !ARGS.has('--quiet-start')) push({ title: 'Signal bot running', body: `Alerts when BUY fires with MODEL >= ${MIN_MODEL}% and POLYMARKET >= ${MIN_MARKET}%.`, priority: 2, tags: 'robot', click: SITE });

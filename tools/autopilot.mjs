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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { join } from 'node:path';

export const AUTOPILOT_VERSION = '1.0.0';
const W = 300;
const DEFAULTS = {
  enabled: true, mode: 'practice', betPct: 20, dailyStopPct: 50, notifyFills: true, notifyResults: true,
  minModel: null, minMarket: null,      // null = use the bot's MIN_MODEL / MIN_MARKET
  practice: { balance: 1000, start: 1000 },
  halted: null,                          // { reason, detail, at, untilDay? }
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
  async function gw(path) {
    const r = await fetch(GATEWAY + path, { headers: { Accept: 'application/json' } });
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
    return { bids: lv(md.bids).sort((a, b) => b[0] - a[0]), asks: lv(md.asks).sort((a, b) => a[0] - b[0]), state: md.state };
  }

  // ------------------------------------------------------------ halts
  function halt(reason, detail, extra) {
    if (S.halted && S.halted.reason === reason) return;
    S.halted = Object.assign({ reason, detail, at: Date.now() }, extra || {});
    save(); publishSoon();
    log('AUTOPILOT HALTED:', reason, '-', detail);
    push({ title: 'AUTOPILOT HALTED', body: `${reason}. ${detail}`, priority: 5, tags: 'octagonal_sign', click: o.site + 'autopilot.html' });
  }
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
    try { await trade(sig); }
    catch (e) {
      log('autopilot trade error:', e.message);
      if (isAuthError(e)) halt('Polymarket rejected the API key', e.message.slice(0, 160));
      else if (isMoneyError(e)) outOfMoney(0, 'Polymarket US refused the order: not enough funds.');
      record({ Ws, mode: S.mode, side: sig.favUp ? 'UP' : 'DOWN', status: 'error', msg: e.message.slice(0, 120), q: sig.q });
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
    const mode = S.mode, live = mode === 'live';
    const side = favUp ? 'UP' : 'DOWN';
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
    if (bal < MIN_BALANCE) { outOfMoney(bal); return record({ Ws, mode, side, status: 'skipped', msg: 'Out of money', q }); }
    const stake = bal * S.betPct / 100;
    const step = mkt.minQty > 0 ? mkt.minQty : 0.01;
    const qty = r2(Math.floor(stake / (limit + feeAt(limit)) / step + 1e-9) * step);
    if (qty < step) { outOfMoney(bal); return record({ Ws, mode, side, status: 'skipped', msg: 'Balance too small for one contract', q }); }
    const day = dayRec(mode, Date.now(), bal);

    let filled = 0, notional = 0, orderId = null, msg = '';
    if (live) {
      const body = {
        marketSlug: mkt.slug,
        intent: favUp ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_BUY_SHORT',
        type: 'ORDER_TYPE_LIMIT',
        price: { value: (favUp ? limit : r2(1 - limit)).toFixed(2), currency: 'USD' },   // always the YES price
        quantity: qty,
        tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
        manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
        synchronousExecution: true, maxBlockTime: '3',
      };
      const r = await api('POST', '/v1/orders', body);
      orderId = r.id || null;
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
    } else {
      // Practice: fill against the real book up to the limit price, like an immediate-or-cancel order
      let need = qty;
      for (const [p, n] of levels) { if (p > limit + 1e-9 || need <= 0) break; const take = Math.min(n, need); filled += take; notional += take * p; need -= take; }
      filled = r2(filled);
    }

    if (!(filled > 0)) return record({ Ws, mode, side, status: 'nofill', msg: msg || `No fill at ${cents(limit)} or better`, q, qty, limit, orderId });
    const px = notional / filled, fee = r4(feeAt(px) * filled), cost = r2(notional + fee);
    if (!live) S.practice.balance = r2(S.practice.balance - cost);
    const t = record({ Ws, mode, side, status: filled < qty - 1e-9 ? 'partial' : 'filled', q, mkt: sig.marketPct, qty: filled, want: qty, px: r4(px), fee, cost, limit, orderId, slug: mkt.slug, result: null, pnl: null, balBefore: r2(bal) });
    S.stats[mode].n++; S.stats[mode].staked = r2(S.stats[mode].staked + cost);
    day.n++;
    log(`AUTOPILOT ${mode.toUpperCase()} bought ${side} ${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)})`);
    if (S.notifyFills) push({ title: `${live ? '' : 'PRACTICE '}BOUGHT ${side}`, body: `${filled} @ ${cents(px)} = ${money(cost)} (${S.betPct}% of ${money(bal)})`, priority: live ? 4 : 2, tags: side === 'UP' ? 'green_circle' : 'red_circle', click: o.site + 'autopilot.html' });
    return t;
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
      if (t.mode === 'practice' && won) S.practice.balance = r2(S.practice.balance + t.qty);
      log(`AUTOPILOT ${t.mode} ${t.side} ${won ? 'WON' : 'LOST'} ${money(t.pnl)}`);
      if (S.notifyResults) push({ title: `${t.mode === 'live' ? '' : 'PRACTICE '}${won ? 'WON' : 'LOST'} ${money(t.pnl)}`, body: `${t.side} ${t.qty} @ ${cents(t.px)} · today ${money(day.pnl)}`, priority: won ? 2 : 3, tags: won ? 'white_check_mark' : 'x', click: o.site + 'autopilot.html' });
      // Daily loss limit
      if (S.dailyStopPct > 0 && t.mode === S.mode && day.startBal > 0 && day.pnl <= -S.dailyStopPct / 100 * day.startBal) {
        const tomorrow = dayOf(Date.now() + 86400000);
        halt('Daily loss limit reached', `Down ${money(-day.pnl)} today (${Math.round(-day.pnl / day.startBal * 100)}% of ${money(day.startBal)}). Trading resumes automatically tomorrow, or tap Resume.`, { untilDay: tomorrow });
      }
      if (t.mode === 'live') refreshLive().catch(() => {});
      save(); publishSoon();
    }
  }

  // ------------------------------------------------------------ remote link (ntfy)
  let K = null, publishedToday = { day: null, n: 0 }, lastPublish = 0, pubTimer = null, botWhy = '', acks = [];
  const PASSWORD = env.AUTOPILOT_PASSWORD || '';
  const ready = (async () => { if (PASSWORD && o.topic) K = await APC.keys(PASSWORD, o.topic); })();
  function snapshot() {
    const days = Object.keys(S.days).sort().slice(-14).map((d) => [d, S.days[d].practice || null, S.days[d].live || null]);
    const tr = (t) => [t.ts, t.Ws, t.mode[0], t.side, t.status, t.qty || 0, t.px || 0, t.cost || 0, t.result, t.pnl, t.msg || '', t.q ? Math.round(t.q * 100) : null];
    const snap = {
      v: 1, ts: Date.now(), ver: AUTOPILOT_VERSION, since: STARTED, why: botWhy, note: lastNote, keys: !!KEY,
      ap: { enabled: S.enabled, mode: S.mode, betPct: S.betPct, dailyStopPct: S.dailyStopPct, notifyFills: S.notifyFills, notifyResults: S.notifyResults, minModel: minModel(o.defMinModel), minMarket: minMarket(o.defMinMarket), halted: S.halted },
      bal: { live: S.liveBal, practice: S.practice }, stats: S.stats, days, acks: acks.slice(-5),
      trades: S.trades.slice(-12).map(tr),
    };
    while (JSON.stringify(snap).length > 2900 && snap.trades.length > 3) snap.trades.shift();   // ntfy messages are capped at 4 KB
    return snap;
  }
  async function publish() {
    await ready;
    if (!K) return;
    const d = dayOf(Date.now());
    if (publishedToday.day !== d) publishedToday = { day: d, n: 0 };
    if (publishedToday.n >= 150) return;    // stay well inside ntfy.sh's 250 messages/day
    publishedToday.n++; lastPublish = Date.now();
    try {
      const r = await fetch(`${NTFY}/${T.status}`, { method: 'POST', headers: Object.assign({ Priority: '1' }, NTFY_AUTH), body: await APC.seal(K, snapshot()) });
      if (!r.ok) log('autopilot: status publish HTTP', r.status);
    } catch (e) { log('autopilot: status publish failed:', e.message); }
  }
  function publishSoon(ms) { clearTimeout(pubTimer); pubTimer = setTimeout(publish, ms == null ? 1500 : ms); }

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
        const upd = { betPct: num(a.betPct, 1, 100), dailyStopPct: num(a.dailyStopPct, 0, 100), minModel: a.minModel === null ? null : num(a.minModel, 50, 99), minMarket: a.minMarket === null ? null : num(a.minMarket, 50, 99) };
        for (const [k, v] of Object.entries(upd)) if (v !== undefined && k in a) S[k] = v;
        for (const k of ['notifyFills', 'notifyResults']) if (typeof a[k] === 'boolean') S[k] = a[k];
        msg = 'Settings saved'; break;
      }
      case 'resume':
        if (S.mode === 'live' && KEY) { try { const b = await refreshLive(); if (b.buyingPower < MIN_BALANCE) { ok = false; msg = `Still out of money (${money(b.buyingPower)})`; break; } } catch (e) { ok = false; msg = e.message.slice(0, 100); break; } }
        if (S.mode === 'practice' && S.practice.balance < MIN_BALANCE) { ok = false; msg = 'Practice balance is empty — reset it'; break; }
        S.halted = null; msg = 'Resumed'; break;
      case 'resetPractice': {
        const b = typeof a.balance === 'number' && a.balance >= 10 && a.balance <= 1e7 ? r2(a.balance) : 1000;
        S.practice = { balance: b, start: b }; S.stats.practice = zeroStats();
        for (const d of Object.values(S.days)) delete d.practice;
        S.trades = S.trades.filter((t) => t.mode !== 'practice');
        if (S.halted && S.mode === 'practice') S.halted = null;
        msg = `Practice reset to ${money(b)}`; break;
      }
      case 'refresh': if (S.mode === 'live' && KEY) await refreshLive().catch(() => {}); break;
      default: ok = false; msg = 'Unknown command';
    }
    acks.push([c.n, ok ? 1 : 0, msg]); if (acks.length > 10) acks.shift();
    log(`autopilot command: ${c.c} → ${ok ? 'ok' : 'refused'}${msg ? ' (' + msg + ')' : ''}`);
    save();
    publishSoon(c.c === 'refresh' && Date.now() - lastPublish < 10000 ? 10000 - (Date.now() - lastPublish) : 300);
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
    if (now - lastSettleCheck > 10000) { lastSettleCheck = now; settle().catch((e) => log('autopilot settle:', e.message)); }
    if (S.halted && S.halted.untilDay && dayOf(now) >= S.halted.untilDay) {
      S.halted = null; save(); publishSoon();
      push({ title: 'Autopilot resumed', body: 'New day: the daily loss limit has reset.', priority: 3, tags: 'arrow_forward', click: o.site + 'autopilot.html' });
    }
    if (KEY && now - lastBal > (S.mode === 'live' ? 60000 : 300000)) {   // practice: just keep the page's buying power fresh
      lastBal = now;
      refreshLive().then((b) => {
        const open = S.trades.some((t) => t.mode === 'live' && t.result == null && (t.status === 'filled' || t.status === 'partial'));
        if (S.mode === 'live' && b.buyingPower < MIN_BALANCE && !open && S.enabled) outOfMoney(b.buyingPower);
      }).catch((e) => { if (isAuthError(e) && S.mode === 'live') halt('Polymarket rejected the API key', e.message.slice(0, 160)); else log('autopilot balance:', e.message); });
    }
    if (now - lastBeat > 20 * 60000) { lastBeat = now; publishSoon(0); }
  }

  const minModel = (def) => (S.minModel != null ? S.minModel : def);
  const minMarket = (def) => (S.minMarket != null ? S.minMarket : def);

  // ------------------------------------------------------------ key check (node tools/signal-bot.mjs --check-autopilot)
  async function check(Ws) {
    const out = { keyId: KEY_ID ? KEY_ID.slice(0, 8) + '…' : null, keyLoaded: !!KEY, password: !!PASSWORD, topics: T };
    if (!KEY) return out;
    out.balance = await refreshLive().catch((e) => ({ error: e.message }));
    const mkt = await marketFor(Ws);
    out.market = mkt;
    const bk = await book(mkt.slug);
    out.book = { bestBid: bk.bids[0] || null, bestAsk: bk.asks[0] || null };
    // Previews never trade. Prices are far from the market on purpose.
    const prev = (intent, yes) => api('POST', '/v1/order/preview', { request: { marketSlug: mkt.slug, intent, type: 'ORDER_TYPE_LIMIT', price: { value: yes, currency: 'USD' }, quantity: 1, tif: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL', manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC' } }).catch((e) => ({ error: e.message }));
    out.previewBuyUp = await prev('ORDER_INTENT_BUY_LONG', '0.02');
    out.previewBuyDown = await prev('ORDER_INTENT_BUY_SHORT', '0.98');
    return out;
  }

  function start() { listen(); publishSoon(3000); }
  return { onSignal, tick, start, check, settle, minModel, minMarket, state: () => S, hasKey: () => !!KEY, flush: publish };
}

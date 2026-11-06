#!/usr/bin/env node
/*
 * Live recorder: once per second, logs the Coinbase BTC price and Polymarket's live "Up" odds
 * for the current 5-minute window. Meant to run 24/7 (e.g. on a Raspberry Pi) to build
 * second-level data the minute-resolution backfill can't provide.
 *
 *   node tools/record.mjs [outDir=data/recordings]
 *
 * Output: one JSON line per second in <outDir>/YYYY-MM-DD.jsonl (UTC date)
 *   { ts, w (window start), btc, k (window start price), bid, ask, mid, last }
 * Requires Node 22+ (built-in fetch and WebSocket). No API keys.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] || resolve(HERE, '../data/recordings'));
mkdirSync(OUT, { recursive: true });
const W = 300;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let btc = null, btcTs = 0;
let win = null; // { t, token, k, bid, ask, last }

// ---- Coinbase price feed (auto-reconnect) ----
function coinbase() {
  const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
  let lastMsg = Date.now();
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] })); log('coinbase connected'); };
  ws.onmessage = (e) => {
    lastMsg = Date.now();
    const m = JSON.parse(e.data);
    if (m.type === 'ticker') { btc = +m.price; btcTs = Date.parse(m.time) / 1000; if (win && win.k == null && btcTs >= win.t && btcTs < win.t + 5) win.k = btc; } // k = true start-of-window price only
  };
  const watchdog = setInterval(() => { if (Date.now() - lastMsg > 20000) ws.close(); }, 5000);
  ws.onclose = () => { clearInterval(watchdog); log('coinbase closed, reconnecting'); setTimeout(coinbase, 2000); };
  ws.onerror = () => {};
}

// ---- Polymarket odds feed for the current window ----
let pws = null, pingTimer = null;
async function findToken(t) {
  for (let a = 0; a < 20; a++) {
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${t}`);
      const m = (await r.json())[0];
      if (m) return JSON.parse(m.clobTokenIds)[JSON.parse(m.outcomes).indexOf('Up')];
    } catch { /* retry */ }
    await sleep(3000);
  }
  return null;
}
function polymarket(token) {
  if (pws) { pws.onclose = null; try { pws.close(); } catch { /* ignore */ } }
  clearInterval(pingTimer);
  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  pws = ws;
  ws.onopen = () => { ws.send(JSON.stringify({ assets_ids: [token], type: 'market', custom_feature_enabled: true })); pingTimer = setInterval(() => ws.send('PING'), 9000); };
  ws.onmessage = (e) => {
    if (e.data === 'PONG' || !win || win.token !== token) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    for (const x of Array.isArray(d) ? d : [d]) {
      if (x.event_type === 'best_bid_ask' && x.asset_id === token) { win.bid = +x.best_bid; win.ask = +x.best_ask; }
      else if (x.price_changes) for (const c of x.price_changes) { if (c.asset_id === token && c.best_bid != null) { win.bid = +c.best_bid; win.ask = +c.best_ask; } }
      else if (x.event_type === 'last_trade_price' && x.asset_id === token) win.last = +x.price;
      else if (x.event_type === 'book' && x.asset_id === token) {
        const bids = (x.bids || []).map((b) => +b.price), asks = (x.asks || []).map((b) => +b.price);
        if (bids.length) win.bid = Math.max(...bids);
        if (asks.length) win.ask = Math.min(...asks);
      }
    }
  };
  ws.onclose = () => { clearInterval(pingTimer); if (win && win.token === token) setTimeout(() => polymarket(token), 2000); };
  ws.onerror = () => {};
}

async function rollWindow() {
  const t = Math.floor(Date.now() / 1000 / W) * W;
  if (win && win.t === t) return;
  win = { t, token: null, k: btc != null && btcTs >= t && btcTs < t + 5 ? btc : null, bid: null, ask: null, last: null };
  const token = await findToken(t);
  if (!token || !win || win.t !== t) { log('no market found for window', t); return; }
  win.token = token;
  polymarket(token);
  log('window', new Date(t * 1000).toISOString(), 'token', token.slice(0, 10) + '…');
}

function writeLine() {
  const ts = Math.floor(Date.now() / 1000);
  if (!win || btc == null) return;
  const mid = win.bid != null && win.ask != null ? +((win.bid + win.ask) / 2).toFixed(4) : null;
  const line = { ts, w: win.t, btc, k: win.k, bid: win.bid, ask: win.ask, mid, last: win.last };
  appendFileSync(resolve(OUT, new Date(ts * 1000).toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(line) + '\n');
}

coinbase();
await rollWindow();
setInterval(() => { rollWindow(); writeLine(); }, 1000);
log('recording to', OUT);

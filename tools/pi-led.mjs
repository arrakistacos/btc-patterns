#!/usr/bin/env node
// BTC bot face: draws the bot's chart and health on the Sense HAT's 8x8 LED matrix (the robot's mouth).
//
//   top row      8 health lights, a steady dim line when all is well (it also marks the top of the chart)
//                1 bot  2 Bitcoin price  3 Polymarket odds  4 Polymarket US  5 autopilot  6 phone alerts
//                7 Healthchecks  8 the Pi itself (temperature, power)
//   rows 2-8     the Profits page chart, one column per day (midnight to midnight, Central), today on the right
//                and gently pulsing. Balance view: a blue bar from $0 up to the balance, the day's profit
//                stacked on top in green or the part lost in red. Profit view: green bars up, red bars down.
//   every 5 min  the balance (white) and the total profit since the chart's start date (green/red) scroll by
//   joystick     press: the same scroll now · up/down: brightness · left/right: balance / profit view
//
// It reads what the bot writes every second (LED_FILE, in the bot's private run folder: memory, not the SD card)
// and asks the bot's launcher whether it is running or locked, so it still shows "locked" or "down" when the bot
// isn't running. No secrets are involved. Needs only Node.js and the Sense HAT kernel driver (no Python library).
import fs from 'node:fs';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- colours
export const C = {
  off: [0, 0, 0], green: [0, 255, 40], red: [255, 16, 8], amber: [255, 120, 0], blue: [24, 64, 255],
  purple: [170, 40, 255], cyan: [0, 190, 255], white: [255, 255, 255], gold: [255, 190, 0], grey: [110, 110, 110],
  bal: [20, 70, 235],   // the Profits page's balance blue
};
const mul = (c, k) => c.map((v) => v * k);

// ---------------------------------------------------------------- health lights
// Each light: [colour, problem?]. Healthy lights are drawn dim (a quiet line); problems bright, red ones blink.
export function healthLights(st) {
  const L = [];
  const run = st.bot === 'running', fresh = run && st.data && st.now - st.data.ts < 15000, d = st.data || {};
  // 1 bot
  L.push(st.bot === 'running' ? (fresh ? [C.green, 0] : [C.amber, 1]) : st.bot === 'locked' ? [C.blue, 1] : st.bot === 'parked' ? [C.purple, 0] : [C.red, 1]);
  if (!fresh) { for (let i = 0; i < 6; i++) L.push([C.off, 0]); }
  else {
    const h = d.h || {};
    // 2 Bitcoin price (Coinbase): live stream / slower backup polling / nothing
    L.push(h.c == null ? [C.red, 1] : h.c < 6 && h.w ? [C.green, 0] : h.c < 30 ? [C.amber, 1] : [C.red, 1]);
    // 3 Polymarket odds
    L.push(h.p == null ? [C.amber, 1] : h.p < 15 ? [C.green, 0] : h.p < 60 ? [C.amber, 1] : [C.red, 1]);
    // 4 Polymarket US: key loaded and its live price stream up
    const us = d.us || {};
    L.push(!us.k || (d.ap && d.ap.halted && /key/i.test(d.ap.halted)) ? [C.red, 1] : us.u ? [C.green, 0] : [C.amber, 1]);
    // 5 autopilot: live / practice / off / halted
    const ap = d.ap || {};
    L.push(ap.halted ? [C.red, 1] : !ap.on ? [C.grey, 0] : ap.mode === 'live' ? [C.green, 0] : [C.cyan, 0]);
    // 6 phone alerts (ntfy): last push worked and messages are left today
    const n = d.ntfy || {};
    L.push(n.ok === false ? [C.red, 1] : n.left != null && n.left < 25 ? [C.amber, 1] : [C.green, 0]);
    // 7 Healthchecks.io heartbeat
    const hc = d.hc || {};
    L.push(!hc.on ? [C.grey, 0] : hc.ok == null ? [C.amber, 0] : hc.ok ? [C.green, 0] : [C.red, 1]);
  }
  // 8 the Pi: temperature and power
  const t = st.tempC, th = st.throttled || 0;
  L.push(th & 0x5 || t >= 80 ? [C.red, 1] : t >= 70 || th & 0xA ? [C.amber, 1] : t == null ? [C.grey, 0] : [C.green, 0]);
  return L;
}

// ---------------------------------------------------------------- profits chart
// days: [[date, pnl, startBalance|null, trades], ...] oldest first, today last (the bot's daily ledger).
// Returns 8 columns (or fewer, right-aligned), each a list of [row, colour] with row 0 = top of the 7 chart rows,
// drawn like the Profits page. Every profit or loss shows as at least one pixel, so a small day is still visible.
export function profitGrid(days, view = 'bal') {
  const D = (days || []).slice(-8), R = 7, out = [];
  const off = 8 - D.length;
  if (view === 'bal') {
    let hi = 0;
    for (const [, pnl, sb] of D) if (sb != null) hi = Math.max(hi, sb, sb + pnl);
    if (!(hi > 0)) return out;
    D.forEach(([, pnl, sb], i) => {
      if (sb == null) return;
      const top = Math.max(sb, sb + pnl);
      const H = Math.max(1, Math.min(R, Math.round(top / hi * R)));
      const cap = pnl ? Math.max(1, Math.min(H, Math.round(Math.abs(pnl) / hi * R))) : 0;
      const px = [];
      for (let k = 0; k < H; k++) px.push([R - 1 - k, k >= H - cap ? (pnl > 0 ? C.green : C.red) : C.bal]);
      out.push({ col: off + i, px, today: i === D.length - 1 });
    });
    return out;
  }
  // profit view: bars up from a zero line for profit, down for loss
  let hi = 0, lo = 0;
  for (const [, pnl, , n] of D) if (n) { hi = Math.max(hi, pnl); lo = Math.min(lo, pnl); }
  if (hi === 0 && lo === 0) hi = 1;
  let z = Math.round(hi / (hi - lo) * R);                       // rows above the zero line
  if (hi > 0) z = Math.max(1, z); if (lo < 0) z = Math.min(R - 1, z);
  D.forEach(([, pnl, , n], i) => {
    const px = [];
    if (!n || !pnl) { if (n) px.push([Math.min(R - 1, z), C.grey]); }
    else if (pnl > 0) { const h = Math.max(1, Math.min(z, Math.round(pnl / (hi - lo) * R))); for (let k = 0; k < h; k++) px.push([z - 1 - k, C.green]); }
    else { const h = Math.max(1, Math.min(R - z, Math.round(-pnl / (hi - lo) * R))); for (let k = 0; k < h; k++) px.push([z + k, C.red]); }
    out.push({ col: off + i, px, today: i === D.length - 1 });
  });
  return out;
}

// ---------------------------------------------------------------- tiny font (3x5) for the scrolling text
const F = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111', '3': '111001111001111', '4': '101101111001001',
  '5': '111100111001111', '6': '111100111101111', '7': '111001010010010', '8': '111101111101111', '9': '111101111001111',
  '$': '011110010011110', '+': '000010111010000', '-': '000000111000000', '.': '000000000000010', ',': '000000000010100',
  ' ': '000000000000000', 'k': '100101110101101', '%': '101001010100101', '?': '111001011000010', ':': '000010000010000',
  'L': '100100100100111', 'O': '111101101101111', 'C': '111100100100111', 'K': '101101110101101', 'E': '111100111100111',
  'D': '110101101101110', 'W': '101101101111101', 'N': '111101101101101', 'P': '111101111100100', 'A': '010101111101101',
  'R': '110101110101101', 'B': '110101110101110', 'T': '111010010010010',
};
// text -> array of 5-pixel columns (with one blank column between characters)
export function textColumns(s) {
  const cols = [];
  for (const ch of String(s)) {
    const g = F[ch] || F['?'];
    for (let x = 0; x < 3; x++) cols.push([0, 1, 2, 3, 4].map((y) => g[y * 3 + x] === '1'));
    cols.push([false, false, false, false, false]);
  }
  return cols;
}
// several coloured pieces of text -> [{px: 5 booleans, c: colour}, ...] with 3 blank columns before and after
export function textStrip(parts) {
  const blank = { px: [false, false, false, false, false], c: C.off }, out = [blank, blank, blank, blank, blank, blank, blank, blank];
  for (const [str, c] of parts) for (const px of textColumns(str)) out.push({ px, c });
  for (let i = 0; i < 8; i++) out.push(blank);
  return out;
}
// what scrolls every 5 minutes: the balance, then the total profit since the chart's start date
export function summaryParts(d) {
  if (!d) return [['?', C.white]];
  const parts = [];
  if (d.bal != null) parts.push(['$' + d.bal.toFixed(2) + '  ', C.white]);
  const t = d.tot != null ? d.tot : d.pnl || 0;
  parts.push([money(t), t < 0 ? C.red : C.green]);
  return parts;
}
export const money = (v) => (v < 0 ? '-' : '+') + '$' + Math.abs(v).toFixed(2);
export const priceText = (p) => (p == null ? '?' : Math.round(p).toLocaleString('en-US'));

// ---------------------------------------------------------------- icons for when the bot isn't running
const ICON = {
  // 7 rows x 8 columns
  locked: ['00111100', '01000010', '01000010', '11111111', '11100111', '11100111', '11111111'],
  down:   ['10000001', '01000010', '00100100', '00011000', '00100100', '01000010', '10000001'],
  parked: ['11110000', '00100000', '01000000', '11110000', '00000111', '00000010', '00000111'],
};

// ---------------------------------------------------------------- whole frame
// st: { now, bot, data, tempC, throttled }   ui: { view: 'bal'|'pnl', text: {strip, x0}, flash: {colour, k} }
// returns 64 [r,g,b] in screen order (row 0 at the top, left to right), before brightness
export function frame(st, ui = {}) {
  const px = Array.from({ length: 64 }, () => [0, 0, 0]);
  const set = (x, y, c) => { if (x >= 0 && x < 8 && y >= 0 && y < 8) px[y * 8 + x] = c; };
  const blinkOn = Math.floor(st.now / 500) % 2 === 0;
  healthLights(st).forEach(([c, bad], x) => set(x, 0, bad ? (c === C.red && !blinkOn ? mul(c, 0.25) : c) : mul(c, 0.35)));

  if (ui.text) {
    const { strip, x0 } = ui.text;
    for (let x = 0; x < 8; x++) { const col = strip[x + x0]; if (col) col.px.forEach((on, y) => { if (on) set(x, 2 + y, col.c); }); }
    return px;
  }
  const d = st.data;
  const fresh = st.bot === 'running' && d && st.now - d.ts < 15000;
  if (!fresh) {
    const ic = ICON[st.bot === 'locked' ? 'locked' : st.bot === 'parked' ? 'parked' : 'down'];
    const col = st.bot === 'locked' ? C.blue : st.bot === 'parked' ? mul(C.purple, 0.5) : st.bot === 'running' ? C.amber : C.red;
    ic.forEach((r, y) => [...r].forEach((b, x) => { if (b === '1') set(x, y + 1, col); }));
    return px;
  }
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(st.now / 1000 * Math.PI));   // today: still in progress
  for (const g of profitGrid(d.days, ui.view || 'bal')) for (const [y, c] of g.px) set(g.col, y + 1, g.today ? mul(c, pulse) : c);
  if (ui.flash && ui.flash.k > 0) for (let y = 1; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = px[y * 8 + x], f = ui.flash.k;
    px[y * 8 + x] = p.map((v, i) => v * (1 - f) + ui.flash.colour[i] * f);
  }
  return px;
}

// ---------------------------------------------------------------- matrix output
// The head stands with the Pi's USB end up, so the HAT is turned a quarter turn: rotate 90 (default).
export function toNative(px, rot = 90) {
  const out = new Array(64);
  for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 8; sx++) {
    let c, r;
    if (rot === 0) { c = sx; r = sy; } else if (rot === 90) { c = 7 - sy; r = sx; } else if (rot === 180) { c = 7 - sx; r = 7 - sy; } else { c = sy; r = 7 - sx; }
    out[r * 8 + c] = px[sy * 8 + sx];
  }
  return out;
}
// RGB565 little-endian, with brightness. Very dim channels are kept just visible instead of rounding to off.
export function rgb565(native, bright = 1) {
  const buf = Buffer.alloc(128);
  native.forEach((p, i) => {
    const ch = (v, bits) => { const m = (1 << bits) - 1, x = Math.round(v * bright / 255 * m); return v > 0 && x === 0 ? 1 : Math.min(m, x); };
    buf.writeUInt16LE((ch(p[0], 5) << 11) | (ch(p[1], 6) << 5) | ch(p[2], 5), i * 2);
  });
  return buf;
}
// joystick: native direction -> on-screen direction for a rotation
export function joyDir(dir, rot = 90) {
  const order = ['up', 'right', 'down', 'left'], i = order.indexOf(dir);
  if (i < 0) return dir;
  return order[(i - rot / 90 + 8) % 4];
}

// ---------------------------------------------------------------- device side
function findSense() {
  let fb = null, js = null;
  try { for (const n of fs.readdirSync('/sys/class/graphics')) if (/^fb\d+$/.test(n) && fs.readFileSync(`/sys/class/graphics/${n}/name`, 'utf8').includes('RPi-Sense FB')) fb = '/dev/' + n; } catch { /* none */ }
  try { for (const n of fs.readdirSync('/sys/class/input')) if (/^event\d+$/.test(n) && fs.readFileSync(`/sys/class/input/${n}/device/name`, 'utf8').includes('Sense HAT Joystick')) js = '/dev/input/' + n; } catch { /* none */ }
  return { fb, js };
}
function askLauncher(sock) {
  return new Promise((res) => {
    const c = net.createConnection(sock); let buf = '';
    const t = setTimeout(() => { c.destroy(); res('down'); }, 3000);
    c.on('connect', () => c.write('{"cmd":"status"}\n'));
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); c.end(); try { res(JSON.parse(buf.slice(0, i)).state || 'down'); } catch { res('down'); } } });
    c.on('error', () => { clearTimeout(t); res('down'); });
  });
}
function readThrottled() {
  return new Promise((res) => execFile('vcgencmd', ['get_throttled'], { timeout: 3000 }, (e, out) => {
    const m = !e && /0x([0-9a-f]+)/i.exec(out || ''); res(m ? parseInt(m[1], 16) : 0);
  }));
}

async function main() {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const LED_FILE = process.env.LED_FILE || '/run/btc-bot/led.json';
  const SOCK = process.env.UNLOCK_SOCKET || '/run/btc-bot/unlock.sock';
  const ROT = [0, 90, 180, 270].includes(+process.env.LED_ROTATE) ? +process.env.LED_ROTATE : 90;
  const SETTINGS = resolve(ROOT, 'led-settings.json');
  const LEVELS = [0.06, 0.12, 0.25, 0.45, 0.7, 1];
  const NIGHT = (process.env.LED_NIGHT || '22-7').split('-').map(Number);   // dimmer from 10 pm to 7 am (Central)
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  let ui = { level: 3, view: 'bal' };
  try { ui = Object.assign(ui, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch { /* defaults */ }
  const saveUi = () => { try { fs.writeFileSync(SETTINGS, JSON.stringify({ level: ui.level, view: ui.view })); } catch { /* read-only */ } };

  let dev = findSense();
  while (!dev.fb) {
    log('no Sense HAT LED matrix found (is the HAT on, and the Pi rebooted since?); checking again in a minute');
    await new Promise((r) => setTimeout(r, 60000));
    dev = findSense();
  }
  const fd = fs.openSync(dev.fb, 'r+');
  log(`drawing on ${dev.fb}${dev.js ? ', joystick ' + dev.js : ''} · rotation ${ROT}`);

  const st = { now: Date.now(), bot: 'down', data: null, tempC: null, throttled: 0 };
  let text = null, flash = null, lastEv = null;
  const scroll = (parts) => { text = { strip: textStrip(parts), at: Date.now() }; };
  let lastSlot = null;   // every 5 minutes on the clock (:00, :05, ...) the balance and total profit scroll by

  // first: an arrow pointing up for 3 s, to check the rotation
  const arrow = ['00011000', '00111100', '01111110', '11011011', '00011000', '00011000', '00011000', '00011000'];
  fs.writeSync(fd, rgb565(toNative(arrow.flatMap((r) => [...r].map((b) => (b === '1' ? C.cyan : C.off))), ROT), 0.4), 0, 128, 0);
  await new Promise((r) => setTimeout(r, 3000));

  async function poll() {
    st.bot = await askLauncher(SOCK);
    try { st.data = JSON.parse(fs.readFileSync(LED_FILE, 'utf8')); } catch { st.data = null; }
    try { st.tempC = +fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8') / 1000; } catch { st.tempC = null; }
    // trade events: flash green/red when the autopilot buys, gold for a win
    const ev = st.data && st.data.last;
    if (ev && lastEv && (ev.id !== lastEv.id || ev.result !== lastEv.result)) {
      if (ev.id !== lastEv.id) flash = { colour: ev.side === 'UP' ? C.green : C.red, at: Date.now() };
      else if (ev.result === true) flash = { colour: C.gold, at: Date.now() };
    }
    if (ev) lastEv = ev;
  }
  setInterval(poll, 1000); poll();
  setInterval(async () => { st.throttled = await readThrottled(); }, 15000); st.throttled = await readThrottled();

  if (dev.js) {
    const KEYS = { 103: 'up', 108: 'down', 105: 'left', 106: 'right', 28: 'press' };
    const s = fs.createReadStream(dev.js); let pend = Buffer.alloc(0);
    s.on('data', (b) => {
      pend = Buffer.concat([pend, b]);
      while (pend.length >= 24) {
        const type = pend.readUInt16LE(16), code = pend.readUInt16LE(18), value = pend.readInt32LE(20);
        pend = pend.subarray(24);
        if (type !== 1 || value !== 1 || !KEYS[code]) continue;
        const dir = KEYS[code] === 'press' ? 'press' : joyDir(KEYS[code], ROT);
        if (dir === 'press') {
          const d = st.data;
          if (st.bot !== 'running') scroll([[st.bot === 'locked' ? 'LOCKED' : st.bot === 'parked' ? 'PARKED' : 'DOWN', C.white]]);
          else scroll(summaryParts(d));
        } else if (dir === 'up' || dir === 'down') { ui.level = Math.max(0, Math.min(LEVELS.length - 1, ui.level + (dir === 'up' ? 1 : -1))); saveUi(); }
        else { ui.view = ui.view === 'pnl' ? 'bal' : 'pnl'; saveUi(); }
      }
    });
    s.on('error', (e) => log('joystick:', e.message));
  }

  setInterval(() => {
    st.now = Date.now();
    const hour = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(st.now);
    const night = NIGHT[0] > NIGHT[1] ? hour >= NIGHT[0] || hour < NIGHT[1] : hour >= NIGHT[0] && hour < NIGHT[1];
    const bright = LEVELS[ui.level] * (night ? 0.5 : 1);
    const u = { view: ui.view };
    const slot = Math.floor(st.now / 300000);
    if (slot !== lastSlot && st.bot === 'running' && st.data && st.now - st.data.ts < 15000) { lastSlot = slot; if (!text) scroll(summaryParts(st.data)); }
    if (text) { const x0 = Math.floor((st.now - text.at) / 110); if (x0 > text.strip.length - 8) text = null; else u.text = { strip: text.strip, x0 }; }
    if (flash) { const t = (st.now - flash.at) / 1500; if (t >= 1) flash = null; else u.flash = { colour: flash.colour, k: Math.max(0, Math.sin(t * Math.PI * 3)) * 0.8 }; }
    try { fs.writeSync(fd, rgb565(toNative(frame(st, u), ROT), bright), 0, 128, 0); } catch (e) { log('matrix write failed:', e.message); }
  }, 50);

  const bye = () => { try { fs.writeSync(fd, Buffer.alloc(128), 0, 128, 0); } catch { /* gone */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

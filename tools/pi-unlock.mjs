#!/usr/bin/env node
// The only thing the laptop's restricted SSH key can run on the Pi (authorized_keys command="..."):
//   status          → prints RUNNING / LOCKED / PARKED / DOWN   (exit 0 running, 3 locked, 5 parked, 4 down)
//   unlock          → reads KEY=value lines (the laptop's polymarket.env) from stdin and hands them to the
//                     waiting bot over its private socket. Nothing is written to disk.
//   park            → stop trading and stay locked quietly (the bot moved back to the laptop)
import net from 'node:net';

const SOCK = process.env.UNLOCK_SOCKET || '/run/btc-bot/unlock.sock';
const mode = String(process.env.SSH_ORIGINAL_COMMAND || process.argv[2] || 'status').trim().split(/\s+/)[0];
if (!['status', 'unlock', 'park'].includes(mode)) { console.log('ERROR only status, unlock or park are allowed'); process.exit(1); }

function ask(obj) {
  return new Promise((res, rej) => {
    const c = net.createConnection(SOCK);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); rej(new Error('no answer from the bot')); }, 8000);
    c.on('connect', () => c.write(JSON.stringify(obj) + '\n'));
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); c.end(); try { res(JSON.parse(buf.slice(0, i))); } catch (e) { rej(e); } } });
    c.on('error', (e) => { clearTimeout(t); rej(e); });
  });
}
function readStdin() {
  return new Promise((res) => {
    let s = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; if (s.length > 16384) process.stdin.destroy(); });
    process.stdin.on('end', () => res(s)); process.stdin.on('close', () => res(s));
  });
}
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };

try {
  if (mode === 'status') {
    const r = await ask({ cmd: 'status' });
    const word = r.state === 'running' ? 'RUNNING' : r.state === 'parked' ? 'PARKED' : 'LOCKED';
    console.log(`${word} (bot process up ${ago(r.since)})`);
    process.exit(r.state === 'running' ? 0 : r.state === 'parked' ? 5 : 3);
  }
  if (mode === 'park') {
    const r = await ask({ cmd: 'park' });
    console.log(r.ok ? 'PARKED: the Pi bot stopped trading and stays locked' : 'ERROR ' + r.error);
    process.exit(r.ok ? 0 : 1);
  }
  // unlock
  const env = {};
  for (const line of (await readStdin()).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const r = await ask({ cmd: 'unlock', env });
  console.log(r.ok ? (r.note ? 'RUNNING (' + r.note + ')' : 'UNLOCKED: the bot is starting') : 'ERROR ' + r.error);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.log(`DOWN: the Pi bot service is not answering (${e.code || e.message}). On the Pi: sudo systemctl status btc-bot`);
  process.exit(4);
}

// BTC Pattern Watch bot on a Raspberry Pi, without storing secrets on the Pi.
//
// systemd starts this at boot. It does NOT read polymarket.env: it waits, locked, until the laptop sends the
// Polymarket key and autopilot password over SSH (tools/pi-unlock.mjs → a private unix socket that only this user
// can open), keeps them in this process's memory only, then starts the normal bot (tools/signal-bot.mjs).
// After a reboot or crash it is locked again until the laptop unlocks it (the laptop's unlock task does that).
//
// Socket commands, one JSON line each:  {cmd:'status'}  {cmd:'unlock', env:{...}}  {cmd:'park'}
//   park = stop trading and stay locked quietly (used when the bot moves back to the laptop).
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '..');
const SOCK = process.env.UNLOCK_SOCKET || '/run/btc-bot/unlock.sock';
const PARK = resolve(ROOT, 'parked');                 // present = moved back to the laptop: stay locked, no alerts
const LOG = process.env.LOG_FILE || '';
const NTFY = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''), TOPIC = process.env.NTFY_TOPIC || '';
const ALLOWED = ['PM_KEY_ID', 'PM_SECRET_KEY', 'AUTOPILOT_PASSWORD', 'NTFY_TOKEN', 'HC_PING_KEY', 'HC_PING_URL', 'HC_SLUG'];

if (LOG && existsSync(LOG) && statSync(LOG).size > 5 * 1024 * 1024) { try { renameSync(LOG, LOG + '.old'); } catch { /* keep going */ } }
const stamp = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false });
function log(...a) {
  const line = `${stamp()} ${a.join(' ')}`;
  console.log(line);
  if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch { /* disk full */ } }
}

let state = existsSync(PARK) ? 'parked' : 'locked';
const since = Date.now();
log(`Pi launcher started (pid ${process.pid}) · ${state === 'parked' ? 'parked: the bot runs on the laptop' : 'locked: waiting for the laptop to unlock it'}`);

// A phone alert if nobody unlocks it (e.g. the Pi rebooted while the laptop was off), then every 6 hours
async function nag() {
  if (state !== 'locked' || !TOPIC) return;
  try {
    await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}`, {
      method: 'POST',
      headers: { Title: 'Pi bot is locked', Priority: '4', Tags: 'lock', ...(process.env.NTFY_TOKEN ? { Authorization: 'Bearer ' + process.env.NTFY_TOKEN } : {}) },
      body: 'The Raspberry Pi bot restarted and is waiting for your laptop to unlock it, so it is not trading or sending BUY alerts. Turn on the laptop (its unlock task runs every 5 minutes), or run the unlock step from install-pi.ps1.',
    });
    log('sent the "Pi bot is locked" alert');
  } catch (e) { log('could not send the locked alert:', e.message); }
}
setTimeout(nag, 3 * 60000).unref();
setInterval(nag, 6 * 3600000).unref();

function clockSynced() {
  if (existsSync('/run/systemd/timesync/synchronized')) return true;
  try { return execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 3000 }).toString().trim() === 'yes'; }
  catch { return true; }   // can't tell (not systemd): don't block
}
function validSecret(s) {
  try { const n = Buffer.from(String(s).trim(), 'base64').length; return n === 32 || n === 64; } catch { return false; }
}
async function handle(msg, reply) {
  const cmd = msg && msg.cmd;
  if (cmd === 'status') return reply({ ok: true, state, since, pid: process.pid });
  if (cmd === 'park') {
    reply({ ok: true, state: 'parked' });
    try { writeFileSync(PARK, new Date().toISOString() + '\n'); } catch { /* read-only? */ }
    log('parked by the laptop: stopping (the service restarts locked and stays quiet)');
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (cmd === 'unlock') {
    if (state === 'running') return reply({ ok: true, state, note: 'already unlocked' });
    const env = msg.env || {};
    const miss = ['PM_KEY_ID', 'PM_SECRET_KEY', 'AUTOPILOT_PASSWORD'].filter((k) => !env[k]);
    if (miss.length) return reply({ ok: false, error: 'missing ' + miss.join(', ') });
    if (!validSecret(env.PM_SECRET_KEY)) return reply({ ok: false, error: 'PM_SECRET_KEY does not look like a Polymarket US secret key' });
    if (String(env.AUTOPILOT_PASSWORD).length < 8) return reply({ ok: false, error: 'AUTOPILOT_PASSWORD too short' });
    for (const k of ALLOWED) if (env[k]) process.env[k] = String(env[k]);   // memory only: never written anywhere
    for (const k of Object.keys(env)) delete env[k];
    process.env.AUTOPILOT_ENV = '/dev/null/none';                            // the bot must not look for polymarket.env
    if (existsSync(PARK)) { try { unlinkSync(PARK); } catch { /* fine */ } }
    state = 'running';
    reply({ ok: true, state });
    // The Pi has no clock battery: after a power cut it boots with an old time until it reaches a time server, and
    // Polymarket refuses requests stamped with the wrong time. Wait for the clock (up to 15 minutes) before trading.
    if (!clockSynced()) {
      log('unlocked by the laptop: waiting for the clock to sync before starting the bot');
      const t0 = Date.now();
      while (!clockSynced() && Date.now() - t0 < 15 * 60000) await new Promise((r) => setTimeout(r, 2000));
      log(clockSynced() ? 'clock synced' : 'clock still not synced after 15 minutes; starting anyway');
    }
    log('unlocked by the laptop: starting the bot');
    try { await import('./signal-bot.mjs'); }
    catch (e) { log('the bot failed to start:', (e && e.stack) || e); process.exit(1); }
    return;
  }
  reply({ ok: false, error: 'unknown command' });
}

// private socket: the directory is created by systemd (RuntimeDirectory, mode 0700, owned by this user)
if (existsSync(SOCK)) { try { unlinkSync(SOCK); } catch { /* stale */ } }
const server = net.createServer((c) => {
  let buf = '';
  c.setTimeout(10000, () => c.destroy());
  c.on('data', (d) => {
    buf += d;
    if (buf.length > 16384) return c.destroy();
    const i = buf.indexOf('\n'); if (i < 0) return;
    let msg = null; try { msg = JSON.parse(buf.slice(0, i)); } catch { /* bad line */ }
    buf = '';
    handle(msg, (r) => { try { c.end(JSON.stringify(r) + '\n'); } catch { /* gone */ } });
  });
  c.on('error', () => {});
});
server.listen(SOCK, () => { try { chmodSync(SOCK, 0o600); } catch { /* fine */ } });
server.on('error', (e) => { log('unlock socket error:', e.message); process.exit(1); });

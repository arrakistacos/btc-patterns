/*
 * Autopilot link crypto — shared by autopilot.html (browser) and tools/autopilot.mjs (Node 22+).
 * The bot and the page talk through two ntfy topics. Everything the bot publishes is encrypted, and every
 * command the page sends is signed, with keys derived from a password only you know.
 *
 *   status topic  <topic>-ap   bot → page  "APS1.<base64url(iv|ciphertext)>"         (AES-256-GCM)
 *   command topic <topic>-apc  page → bot  "APC1.<base64url(json)>.<base64url(mac)>"  (HMAC-SHA256)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APCrypto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ITER = 200000;

  function b64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  // ntfy topics have a 64-character limit
  const topics = (topic) => { const t = String(topic).slice(0, 56); return { status: t + '-ap', command: t + '-apc' }; };

  // 64 bytes from PBKDF2(password, topic): first half encrypts status, second half signs commands
  async function deriveBits(password, topic) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('btc-patterns autopilot v1|' + topic), iterations: ITER }, base, 512);
    return new Uint8Array(bits);
  }
  async function keysFromBits(bits) {
    return {
      enc: await subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
      mac: await subtle.importKey('raw', bits.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    };
  }
  async function keys(password, topic) { return keysFromBits(await deriveBits(password, topic)); }

  async function seal(K, obj) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, K.enc, enc.encode(JSON.stringify(obj))));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return 'APS1.' + b64u(all);
  }
  async function open(K, str) {
    if (typeof str !== 'string' || !str.startsWith('APS1.')) return null;
    try {
      const all = unb64u(str.slice(5));
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, K.enc, all.slice(12));
      return JSON.parse(dec.decode(pt));
    } catch (e) { return null; }   // wrong password or not ours
  }

  async function signCommand(K, cmd, args) {
    const body = { ts: Date.now(), n: b64u(globalThis.crypto.getRandomValues(new Uint8Array(9))), c: cmd, a: args || {} };
    const p = b64u(enc.encode(JSON.stringify(body)));
    const mac = new Uint8Array(await subtle.sign('HMAC', K.mac, enc.encode(p)));
    return { text: 'APC1.' + p + '.' + b64u(mac), nonce: body.n };
  }
  // Returns the command if the signature is valid and it is fresh (±2 min), else null
  async function verifyCommand(K, str, maxAgeMs) {
    if (typeof str !== 'string' || !str.startsWith('APC1.')) return null;
    const parts = str.split('.');
    if (parts.length !== 3) return null;
    try {
      const ok = await subtle.verify('HMAC', K.mac, unb64u(parts[2]), enc.encode(parts[1]));
      if (!ok) return null;
      const body = JSON.parse(dec.decode(unb64u(parts[1])));
      if (!(Math.abs(Date.now() - body.ts) <= (maxAgeMs || 120000))) return null;
      return body;
    } catch (e) { return null; }
  }

  return { topics, deriveBits, keysFromBits, keys, seal, open, signCommand, verifyCommand, b64u, unb64u };
});

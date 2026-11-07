/* BTC Pattern Watch — live feed, chart rendering, UI */
(() => {
  'use strict';
  const INTERVAL = 300;          // 5 minutes
  const HISTORY = 1200;          // ~4 days of candles to learn hit rates from
  const MAX_CANDLES = 1500;
  const STALE_SEC = 25;          // reconnect the socket if silent this long
  const E = window.PatternEngine;
  const P = E.PATTERNS;
  const COLORS = { up: '#16c784', down: '#ea3943', flat: '#f5b041' };

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('btcpw.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('btcpw.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------- state ----------
  const state = {
    candles: [],
    enabled: store.get('enabled', {}),
    view: Object.assign({ marks: true, lines: true, pred: true, minConf: 55, levels: true, minTouches: 3 }, store.get('view', {})),
    source: store.get('source', 'auto'),
    result: null,
    lastAnalyzed: null,
    pending: null,                 // prediction waiting for its candle to close
    live: store.get('live', []),   // scored live predictions
    skew: 0,                       // exchange clock minus local clock (s)
    sizing: Object.assign({ bankroll: null, basis: 'cautious', kelly: 0.25, cap: 0.02 }, store.get('sizing', {})),
  };
  const isOn = (t) => state.enabled[t] !== false;
  const minConf = () => (state.view.minConf || 0) / 100;
  const now = () => Date.now() / 1000 + state.skew;

  // ---------- formatting ----------
  const $ = (id) => document.getElementById(id);
  const usd = (x, d = 0) => (x == null || !isFinite(x)) ? '—' : '$' + x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (x) => (x >= 0 ? '+' : '−') + usd(Math.abs(x));
  const pct = (x) => Math.round(x * 100) + '%';
  const tLocal = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const biasCls = (b) => (b > 0 ? 'up' : b < 0 ? 'down' : 'flat');
  const biasArrow = (b) => (b > 0 ? '▲' : b < 0 ? '▼' : '◆');

  // ---------- network ----------
  async function getJSON(url, ms = 9000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  const iso = (t) => new Date(t * 1000).toISOString();
  const bucket = (ts) => Math.floor(ts / INTERVAL) * INTERVAL;

  const PROVIDERS = {
    coinbase: {
      name: 'Coinbase',
      async history(count) {
        const out = [];
        let end = bucket(Date.now() / 1000) + INTERVAL;
        const per = 290;
        for (let got = 0; got < count; got += per) {
          const start = end - per * INTERVAL;
          const rows = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${iso(start)}&end=${iso(end)}`);
          if (!Array.isArray(rows)) throw new Error('bad response');
          for (const r of rows) out.push({ t: r[0], l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5] });
          if (!rows.length) break;
          end = start;
        }
        return out;
      },
      async recent() {
        const end = bucket(Date.now() / 1000) + INTERVAL;
        const rows = await getJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${iso(end - 36 * INTERVAL)}&end=${iso(end)}`);
        return rows.map((r) => ({ t: r[0], l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5] }));
      },
      stream(h) {
        const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
        ws.onopen = () => { ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'heartbeat'] })); h.open(); };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'ticker' && m.price) h.trade(+m.price, +(m.last_size || 0), m.time ? Date.parse(m.time) / 1000 : null);
          else if (m.type === 'heartbeat') h.ping();
          else if (m.type === 'error') h.fail(m.message || 'feed error');
        };
        ws.onerror = () => h.fail('socket error');
        ws.onclose = () => h.close();
        return ws;
      },
    },
    binanceus: {
      name: 'Binance.US',
      async history(count) {
        const rows = await getJSON(`https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${Math.min(count, 1000)}`);
        return rows.map((r) => ({ t: r[0] / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
      },
      async recent() { return this.history(36); },
      stream(h) {
        const ws = new WebSocket('wss://stream.binance.us:9443/ws/btcusdt@kline_5m');
        ws.onopen = () => h.open();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.k) h.candle({ t: m.k.t / 1000, o: +m.k.o, h: +m.k.h, l: +m.k.l, c: +m.k.c, v: +m.k.v }, m.E ? m.E / 1000 : null);
        };
        ws.onerror = () => h.fail('socket error');
        ws.onclose = () => h.close();
        return ws;
      },
    },
    kraken: {
      name: 'Kraken',
      async history() {
        const j = await getJSON('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5');
        if (j.error && j.error.length) throw new Error(j.error[0]);
        const key = Object.keys(j.result).find((k) => k !== 'last');
        return j.result[key].map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] }));
      },
      async recent() { return (await this.history()).slice(-36); },
      stream(h) {
        const ws = new WebSocket('wss://ws.kraken.com/v2');
        ws.onopen = () => { ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ohlc', symbol: ['BTC/USD'], interval: 5 } })); h.open(); };
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.channel === 'heartbeat') return h.ping();
          if (m.channel !== 'ohlc' || !Array.isArray(m.data)) return;
          for (const d of m.data) {
            const t = Date.parse(d.interval_begin) / 1000;
            if (isFinite(t)) h.candle({ t, o: +d.open, h: +d.high, l: +d.low, c: +d.close, v: +d.volume }, d.timestamp ? Date.parse(d.timestamp) / 1000 : null);
          }
        };
        ws.onerror = () => h.fail('socket error');
        ws.onclose = () => h.close();
        return ws;
      },
    },
  };

  // ---------- feed controller ----------
  const feed = { key: null, ws: null, open: false, lastMsg: 0, retries: 0, resyncTimer: null, reconnectTimer: null, error: '', gen: 0 };

  function cleanCandles(rows) {
    const map = new Map();
    for (const k of rows) if (isFinite(k.t) && isFinite(k.c) && k.h >= k.l) map.set(k.t, k);
    return [...map.values()].sort((a, b) => a.t - b.t).slice(-MAX_CANDLES);
  }

  async function start(pref) {
    const gen = ++feed.gen;
    stopStream();
    clearTimeout(feed.resyncTimer);
    const order = pref === 'auto' ? ['coinbase', 'binanceus', 'kraken'] : [pref].concat(['coinbase', 'binanceus', 'kraken'].filter((k) => k !== pref));
    setStatus('warn', 'Loading history…');
    for (const key of order) {
      try {
        const rows = cleanCandles(await PROVIDERS[key].history(HISTORY));
        if (gen !== feed.gen) return;
        if (rows.length < 100) throw new Error('only ' + rows.length + ' candles');
        feed.key = key;
        state.candles = rows;
        state.lastAnalyzed = null;
        state.pending = null;
        renderCandles(true);
        maybeAnalyze(true);
        connectStream();
        scheduleResync();
        return;
      } catch (err) {
        console.warn(PROVIDERS[key].name + ' history failed:', err);
        feed.error = PROVIDERS[key].name + ': ' + err.message;
      }
    }
    setStatus('err', 'All sources failed — retrying');
    feed.resyncTimer = setTimeout(() => start(pref), 15000);
  }

  function stopStream() {
    clearTimeout(feed.reconnectTimer);
    if (feed.ws) { feed.ws.onclose = null; feed.ws.onerror = null; feed.ws.onmessage = null; try { feed.ws.close(); } catch (e) { /* ignore */ } }
    feed.ws = null; feed.open = false;
  }

  function connectStream() {
    stopStream();
    const prov = PROVIDERS[feed.key];
    if (!prov.stream) return;
    const gen = feed.gen;
    const alive = () => gen === feed.gen;
    const touch = () => { feed.lastMsg = Date.now() / 1000; feed.retries = 0; feed.open = true; };
    try {
      feed.ws = prov.stream({
        open: () => { if (alive()) { touch(); } },
        ping: () => { if (alive()) touch(); },
        trade: (price, size, ts) => { if (alive()) { touch(); onTrade(price, size, ts); } },
        candle: (k, ts) => { if (alive()) { touch(); onCandle(k, ts); } },
        fail: (msg) => { if (alive()) feed.error = msg; },
        close: () => { if (alive()) { feed.open = false; scheduleReconnect(); } },
      });
      feed.lastMsg = Date.now() / 1000;
    } catch (err) {
      feed.error = err.message;
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    clearTimeout(feed.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** feed.retries++);
    feed.reconnectTimer = setTimeout(() => { connectStream(); resync(); }, delay);
  }

  function scheduleResync(ms) {
    clearTimeout(feed.resyncTimer);
    const wait = ms != null ? ms : (feed.open ? 60000 : 8000); // poll fast while the socket is down
    feed.resyncTimer = setTimeout(async () => { await resync(); scheduleResync(); }, wait);
  }

  async function resync() {
    if (!feed.key) return;
    const gen = feed.gen;
    try {
      const rows = cleanCandles(await PROVIDERS[feed.key].recent());
      if (gen !== feed.gen || !rows.length) return;
      mergeRest(rows);
      feed.restOk = Date.now() / 1000;
    } catch (err) {
      feed.error = 'resync: ' + err.message;
    }
  }

  // ---------- candle maintenance ----------
  function trim() { if (state.candles.length > MAX_CANDLES) state.candles.splice(0, state.candles.length - MAX_CANDLES); }

  function noteClock(ts) {
    if (!ts || !isFinite(ts)) return;
    const s = ts - Date.now() / 1000;
    if (Math.abs(s) < 600) state.skew = state.skew * 0.9 + s * 0.1;
  }

  function onTrade(price, size, ts) {
    noteClock(ts);
    pushTick(ts || now(), price);
    const t = bucket(ts || now());
    const C = state.candles;
    const last = C[C.length - 1];
    if (!last || t > last.t) {
      if (last && t - last.t > INTERVAL) scheduleResync(0); // gap — backfill
      C.push({ t, o: last ? last.c : price, h: Math.max(price, last ? last.c : price), l: Math.min(price, last ? last.c : price), c: price, v: size });
      trim();
    } else if (t === last.t) {
      last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += size;
    } else return;
    updateLastBar();
  }

  function onCandle(k, ts) {
    noteClock(ts);
    pushTick(ts || now(), k.c);
    const C = state.candles;
    const last = C[C.length - 1];
    if (!last || k.t > last.t) {
      if (last && k.t - last.t > INTERVAL) scheduleResync(0);
      C.push(k); trim();
    } else if (k.t === last.t) C[C.length - 1] = k;
    else {
      const idx = C.findIndex((x) => x.t === k.t);
      if (idx >= 0) { C[idx] = k; renderCandles(false); maybeAnalyze(true); }
      return;
    }
    updateLastBar();
  }

  function mergeRest(rows) {
    const C = state.candles;
    const nowT = now();
    let structural = false, closedChanged = false;
    for (const k of rows) {
      const last = C[C.length - 1];
      if (!last || k.t > last.t) { C.push(k); structural = true; continue; }
      let idx = -1;
      for (let j = C.length - 1; j >= 0 && C[j].t >= k.t; j--) if (C[j].t === k.t) { idx = j; break; }
      if (idx < 0) { C.push(k); C.sort((a, b) => a.t - b.t); structural = true; continue; }
      const cur = C[idx];
      const forming = k.t + INTERVAL > nowT;
      if (forming && feed.open) {
        cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.v = Math.max(cur.v, k.v);
      } else if (cur.o !== k.o || cur.h !== k.h || cur.l !== k.l || cur.c !== k.c || Math.abs(cur.v - k.v) > 1e-9) {
        C[idx] = k;
        if (!forming) closedChanged = true;
      }
    }
    trim();
    if (structural || closedChanged) renderCandles(false);
    else updateLastBar();
    maybeAnalyze(structural || closedChanged);
  }

  // ---------- chart ----------
  const LW = window.LightweightCharts;
  const chartEl = $('chart');
  const chart = LW.createChart(chartEl, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#0b0e14' }, textColor: '#a9b4c4', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
    grid: { vertLines: { color: '#141922' }, horzLines: { color: '#141922' } },
    rightPriceScale: { borderColor: '#222a37', scaleMargins: { top: 0.08, bottom: 0.24 } },
    timeScale: {
      borderColor: '#222a37', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8,
      tickMarkFormatter: (t, type) => {
        const d = new Date(t * 1000);
        // The chart marks day boundaries in UTC; only show a date label at real local midnight
        const localMidnight = d.getHours() === 0 && d.getMinutes() === 0;
        return type < 3 && localMidnight ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      },
    },
    localization: {
      timeFormatter: (t) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      priceFormatter: (p) => '$' + Math.round(p).toLocaleString(),
    },
    crosshair: { mode: LW.CrosshairMode.Normal },
  });
  const candleSeries = chart.addCandlestickSeries({
    upColor: COLORS.up, downColor: COLORS.down, borderVisible: false,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down,
  });
  const volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const ghostSeries = chart.addCandlestickSeries({
    upColor: 'rgba(22,199,132,0.10)', downColor: 'rgba(234,57,67,0.10)', borderVisible: true,
    borderUpColor: 'rgba(22,199,132,0.95)', borderDownColor: 'rgba(234,57,67,0.95)',
    wickUpColor: 'rgba(22,199,132,0.7)', wickDownColor: 'rgba(234,57,67,0.7)',
    lastValueVisible: false, priceLineVisible: false,
  });
  let patternSeries = [];
  let priceLines = [];

  const barOf = (k) => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c });
  const volOf = (k) => ({ time: k.t, value: k.v, color: k.c >= k.o ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)' });

  function renderCandles(fitView) {
    const C = state.candles;
    candleSeries.setData(C.map(barOf));
    volSeries.setData(C.map(volOf));
    if (fitView) showLatest();
    updateHeader();
  }

  function updateLastBar() {
    const C = state.candles;
    const k = C[C.length - 1];
    if (!k) return;
    try { candleSeries.update(barOf(k)); volSeries.update(volOf(k)); } catch (e) { renderCandles(false); }
    updateHeader();
  }

  function updateHeader() {
    const C = state.candles;
    const k = C[C.length - 1];
    if (!k) return;
    $('price').textContent = usd(k.c, 2);
    const ref = C[Math.max(0, C.length - 1 - 288)];
    const d = k.c - ref.o, r = d / ref.o;
    const el = $('chg');
    el.textContent = (d >= 0 ? '▲ ' : '▼ ') + usd(Math.abs(d)) + ' (' + (r * 100).toFixed(2) + '%) 24h';
    el.className = 'chg num ' + (d >= 0 ? 'up' : 'down');
    document.title = usd(k.c) + ' · BTC Pattern Watch';
  }

  // ---------- analysis ----------
  function closedCandles() {
    const C = state.candles;
    let end = C.length;
    const t = now();
    while (end > 0 && C[end - 1].t + INTERVAL > t) end--;
    return end === C.length ? C : C.slice(0, end);
  }

  function maybeAnalyze(force) {
    const closed = closedCandles();
    if (closed.length < 80) return;
    const last = closed[closed.length - 1];
    if (!force && last.t === state.lastAnalyzed) return;
    // Score the live prediction that was waiting on this candle
    const pd = state.pending;
    if (pd && pd.forTime === last.t && !pd.scored) {
      pd.scored = true;
      const actual = Math.sign(last.c - pd.base);
      state.live.push({ t: last.t, dir: pd.dir, p: pd.p, pred: pd.close, actual: last.c, hit: pd.dir !== 0 && pd.dir === actual, called: pd.signal });
      state.live = state.live.slice(-500);
      store.set('live', state.live);
    }
    state.lastAnalyzed = last.t;
    const t0 = performance.now();
    state.result = E.analyze(closed, { enabled: isOn, interval: INTERVAL });
    state.result.ms = performance.now() - t0;
    state.closedForLevels = closed;
    computeLevels();
    const pred = state.result.prediction;
    if (!pd || pd.forTime !== pred.forTime || !pd.scored) state.pending = Object.assign({}, pred, { scored: false });
    renderAnalysis();
  }

  function renderAnalysis() {
    const R = state.result;
    if (!R) return;
    renderMarkers(R);
    renderChartPatterns(R);
    renderPrediction(R);
    renderActive(R);
    renderToggles(R);
    renderLevels();
  }

  // ---------- support / resistance levels ----------
  let levelSeries = [];
  function computeLevels() {
    const closed = state.closedForLevels;
    state.levels = closed ? E.findLevels(closed, { minTouches: state.view.minTouches, maxPerSide: 4 }) : [];
  }
  function renderLevels() {
    for (const s of levelSeries) chart.removeSeries(s);
    levelSeries = [];
    const levels = (state.levels || []).slice().sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance)); // nearest first
    const box = $('levelList');
    $('levelCount').textContent = levels.length ? levels.length + ' found' : '';
    if (!levels.length) box.innerHTML = `<div class="empty">No level with ${state.view.minTouches}+ touches is unbroken right now. Try fewer touches.</div>`;
    else {
      const last = state.candles[state.candles.length - 1];
      box.innerHTML = levels.map((L, k) => {
        const away = last ? last.c - L.price : -L.distance;
        const pctAway = last ? (away / L.price * 100) : 0;
        const since = new Date(L.firstT * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        return `<div class="pitem" data-k="${k}">
          <span class="arrow ${L.type === 'R' ? 'down' : 'up'}">${L.type === 'R' ? '▔' : '▁'}</span>
          <span class="nm">${L.type === 'R' ? 'Resistance' : 'Support'} <span class="num">${usd(L.price)}</span></span>
          <span class="badge">${L.count}× ${L.testing ? '· testing' : ''}</span>
          <span class="sub">Respected ${L.count} times, never closed through since ${esc(since)} · price is ${signed(away)} (${pctAway.toFixed(2)}%) ${away >= 0 ? 'above' : 'below'} it</span>
        </div>`;
      }).join('');
      box.querySelectorAll('.pitem').forEach((node) => {
        node.onclick = () => { const L = levels[+node.dataset.k]; chart.timeScale().setVisibleRange({ from: L.firstT - 10 * INTERVAL, to: state.candles[state.candles.length - 1].t + 4 * INTERVAL }); };
      });
    }
    if (!state.view.levels || !state.candles.length) return;
    const endT = state.candles[state.candles.length - 1].t;
    for (const L of levels) {
      const col = L.type === 'R' ? 'rgba(234,57,67,0.85)' : 'rgba(22,199,132,0.85)';
      const times = [...new Set([L.firstT, ...L.touches.map((q) => q.t), endT])].sort((a, b) => a - b);
      const s = chart.addLineSeries({
        color: col, lineWidth: L.testing ? 2 : 1, lineStyle: LW.LineStyle.LargeDashed,
        priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
        title: L.type + ' ×' + L.count, autoscaleInfoProvider: () => null,
      });
      s.setData(times.map((t) => ({ time: t, value: L.price })));
      s.setMarkers(L.touches.map((q, idx) => ({ time: q.t, position: 'inBar', shape: 'circle', color: col, size: 0.55, text: idx === L.touches.length - 1 ? String(L.count) : '' })));
      levelSeries.push(s);
    }
  }

  function renderMarkers(R) {
    if (!state.view.marks) { candleSeries.setMarkers([]); return; }
    const labelFrom = R.lastTime - 40 * INTERVAL; // label recent marks; older ones are arrows only
    const marks = R.candleMarks.filter((s) => isOn(s.type) && s.quality >= minConf()).map((s) => ({
      time: s.t1,
      position: s.bias >= 0 ? 'belowBar' : 'aboveBar',
      color: s.bias > 0 ? COLORS.up : s.bias < 0 ? COLORS.down : COLORS.flat,
      shape: s.bias > 0 ? 'arrowUp' : s.bias < 0 ? 'arrowDown' : 'circle',
      text: s.t1 >= labelFrom ? P[s.type].label + ' ' + Math.round(s.quality * 100) + '%' : '',
      size: 0.8,
    }));
    marks.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(marks);
  }

  function renderChartPatterns(R) {
    for (const s of patternSeries) chart.removeSeries(s);
    patternSeries = [];
    if (!state.view.lines) return;
    for (const d of R.chartDrawings) {
      if (!isOn(d.type) || d.quality < minConf()) continue;
      const col = d.bias > 0 ? COLORS.up : d.bias < 0 ? COLORS.down : COLORS.flat;
      const alpha = d.active ? 1 : 0.4;
      const color = hexA(col, alpha);
      d.lines.forEach((ln, li) => {
        const pts = [];
        for (const [t, v] of ln.pts) if (!pts.length || t > pts[pts.length - 1].time) pts.push({ time: t, value: v });
        if (pts.length < 2) return;
        const s = chart.addLineSeries({
          color, lineWidth: d.active ? 2 : 1, lineStyle: ln.dash ? LW.LineStyle.Dashed : LW.LineStyle.Solid,
          lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
        });
        s.setData(pts);
        if (li === 0) {
          s.setMarkers([{
            time: pts[pts.length - 1].time, position: d.bias >= 0 ? 'belowBar' : 'aboveBar', color,
            shape: 'square', size: 0.6,
            text: P[d.type].label + ' ' + Math.round(d.quality * 100) + '%' + (d.status !== 'forming' ? ' ✓' : ''),
          }]);
        }
        patternSeries.push(s);
      });
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function renderPrediction(R) {
    const pr = R.prediction;
    for (const pl of priceLines) candleSeries.removePriceLine(pl);
    priceLines = [];
    // Ghost candle only when the patterns actually have a directional read
    if (state.view.pred && pr && pr.signal && pr.dir !== 0) {
      ghostSeries.setData([{ time: pr.forTime, open: pr.ghost.o, high: pr.ghost.h, low: pr.ghost.l, close: pr.ghost.c }]);
    } else ghostSeries.setData([]);

    $('predFor').textContent = 'Pattern call at ' + tLocal(pr.forTime) + ' open · candle closes ' + tLocal(pr.forTime + INTERVAL);
    const dirEl = $('predDir'), confEl = $('predConf');
    if (pr.signal && pr.dir !== 0) {
      dirEl.textContent = pr.dir > 0 ? '▲ UP' : '▼ DOWN';
      dirEl.className = 'dir ' + biasCls(pr.dir);
      confEl.textContent = (pr.confidence * 100).toFixed(1) + '% confidence';
      confEl.className = 'conf num ' + biasCls(pr.dir);
    } else {
      dirEl.textContent = '◆ NO EDGE';
      dirEl.className = 'dir flat';
      confEl.textContent = '50/50';
      confEl.className = 'conf num muted';
    }
    $('predMeter').style.left = (pr.p * 100).toFixed(1) + '%';
    $('predClose').textContent = usd(pr.close, 2);
    $('predRange').textContent = usd(pr.low) + ' – ' + usd(pr.high);
    $('predMove').textContent = signed(pr.close - pr.base) + '  from ' + usd(pr.base);
    $('drivers').innerHTML = pr.drivers.length
      ? 'Driven by ' + pr.drivers.slice(0, 4).map((d) => `<b class="${biasCls(d.bias)}">${biasArrow(d.bias)} ${esc(P[d.type].name)}</b> (conf ${pct(d.quality)}, est. hit ${pct(d.rel)})`).join(', ')
      : 'No enabled pattern is active on the last closed candle, so the model has no directional read.';

    const wf = R.wf;
    const hours = ((R.lastTime - R.firstTime) / 3600).toFixed(0);
    const calledLive = state.live.filter((x) => x.called);
    const liveHits = calledLive.filter((x) => x.hit).length;
    $('track').innerHTML =
      `Track record (walk-forward, last ${hours}h): <b>${wf.called ? pct(wf.hits / wf.called) : '—'}</b> of ${wf.called} calls right` +
      (wf.called ? ` · avg miss <b>${usd(wf.err / wf.called)}</b> vs ${usd(wf.naiveErr / wf.called)} for "no change"` : '') +
      `<br>Live in this browser: <b>${calledLive.length ? liveHits + '/' + calledLive.length + ' (' + pct(liveHits / calledLive.length) + ')' : 'scoring starts at the next close'}</b>`;
  }

  function renderActive(R) {
    const list = R.active.filter((s) => isOn(s.type) && s.quality >= minConf() && (s.kind === 'chart' || s.i1 === R.n - 1));
    list.sort((a, b) => b.quality - a.quality);
    $('activeCount').textContent = list.length ? list.length + ' now' : '';
    const el = $('activeList');
    if (!list.length) { el.innerHTML = '<div class="empty">Nothing on the last closed candle. Recent patterns stay on the chart.</div>'; return; }
    el.innerHTML = list.map((s, idx) => {
      const st = R.stats[s.type];
      const hr = st.n >= 5 ? `hit ${pct(st.rate)} of ${st.n}` : `hit n/a (${st.n} seen)`;
      const tgt = s.target ? ` · target ${usd(s.target)}` : '';
      return `<div class="pitem" data-idx="${idx}">
        <span class="arrow ${biasCls(s.bias)}">${biasArrow(s.bias)}</span>
        <span class="nm">${esc(P[s.type].name)}</span>
        <span class="badge">${pct(s.quality)}</span>
        <span class="sub">${esc(s.status === 'complete' ? 'completed ' + tLocal(s.t1) : s.status)}${tgt} · ${hr}<br>${esc(s.why || '')}</span>
      </div>`;
    }).join('');
    el.querySelectorAll('.pitem').forEach((node) => {
      node.onclick = () => {
        const s = list[+node.dataset.idx];
        chart.timeScale().setVisibleRange({ from: s.t0 - 25 * INTERVAL, to: s.t1 + 10 * INTERVAL });
      };
    });
  }

  function renderToggles(R) {
    const groups = [['candle', 'Candlestick patterns'], ['chart', 'Chart patterns']];
    const html = groups.map(([kind, title]) => {
      const rows = Object.keys(P).filter((t) => P[t].kind === kind).map((t) => {
        const st = R ? R.stats[t] : null;
        const hr = !st ? '' : st.n >= 5 ? `${pct(st.rate)} · ${st.n}` : `${st.n} seen`;
        return `<label class="trow ${isOn(t) ? '' : 'off'}">
          <input type="checkbox" data-type="${t}" ${isOn(t) ? 'checked' : ''}>
          <span class="${biasCls(P[t].bias)}">${biasArrow(P[t].bias)}</span>
          <span class="nm">${esc(P[t].name)}</span>
          <span class="hr">${hr}</span></label>`;
      }).join('');
      return `<div class="tgroup"><div class="gh">${title}<span><button data-kind="${kind}" data-on="1">on</button><button data-kind="${kind}" data-on="0">off</button></span></div>${rows}</div>`;
    }).join('');
    const box = $('toggles');
    box.innerHTML = html;
    box.querySelectorAll('input[data-type]').forEach((inp) => {
      inp.onchange = () => { state.enabled[inp.dataset.type] = inp.checked; saveToggles(); };
    });
    box.querySelectorAll('button[data-kind]').forEach((b) => {
      b.onclick = () => { for (const t in P) if (P[t].kind === b.dataset.kind) state.enabled[t] = b.dataset.on === '1'; saveToggles(); };
    });
  }

  function saveToggles() {
    store.set('enabled', state.enabled);
    if (state.result) maybeAnalyze(true); else renderToggles(null);
  }

  // ---------- status + clock ----------
  function setStatus(kind, text) {
    $('dot').className = 'dot ' + kind;
    $('statusText').textContent = text;
  }

  function tick() {
    const name = feed.key ? PROVIDERS[feed.key].name : '';
    const age = Date.now() / 1000 - feed.lastMsg;
    if (!feed.key) { /* still loading */ }
    else if (feed.open && age < 10) setStatus('live', 'Live · ' + name);
    else if (feed.open) setStatus('warn', name + ' · quiet ' + Math.round(age) + 's');
    else setStatus('warn', name + ' · polling (socket reconnecting)');
    if (feed.open && age > STALE_SEC) { feed.error = 'stale socket'; connectStream(); }
    $('status').title = feed.error ? 'Last issue: ' + feed.error : 'Streaming from ' + name;
    if (state.result && state.result.prediction) {
      const left = Math.max(0, state.result.prediction.forTime + INTERVAL - now());
      $('countdown').textContent = Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0');
    }
    maybeAnalyze(false);
    renderWindow();
  }

  // ---------- this window vs Polymarket ----------
  const ticks = []; // [ts, price], last ~6 minutes, for time-weighted averages
  function pushTick(ts, price) {
    if (!isFinite(price)) return;
    if (ticks.length && ts < ticks[ticks.length - 1][0]) ts = ticks[ticks.length - 1][0];
    ticks.push([ts, price]);
    while (ticks.length && ticks[0][0] < ts - 400) ticks.shift();
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

  state.params = Object.assign({}, E.DEFAULT_WINDOW_PARAMS);
  state.overrides = store.get('overrides', {});        // user slider settings; empty = use tuned values
  const params = () => Object.assign({}, state.params, state.overrides);
  fetch('params.json', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((j) => {
    if (j && j.window) { state.params = Object.assign({}, E.DEFAULT_WINDOW_PARAMS, j.window); state.paramsTuned = j.generated; }
    syncSettingsUI();
  }).catch(() => { /* defaults */ });

  const pm = { t: null, token: null, ws: null, bid: null, ask: null, last: null, lastMsg: 0, poll: null, ping: null, status: '' };
  async function pmRoll(t) {
    if (pm.t === t) return;
    pm.t = t; pm.token = null; pm.bid = pm.ask = pm.last = null; pm.status = 'finding market…';
    pmClose();
    for (let a = 0; a < 6 && pm.t === t; a++) {
      try {
        const m = (await getJSON(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${t}`))[0];
        if (m) { pm.token = JSON.parse(m.clobTokenIds)[JSON.parse(m.outcomes).indexOf('Up')]; break; }
      } catch (e) { /* retry */ }
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (pm.t !== t) return;
    if (!pm.token) { pm.status = 'no Polymarket market found'; return; }
    pm.status = 'connecting…';
    pmConnect(pm.token, t);
  }
  function pmClose() {
    clearInterval(pm.ping); clearInterval(pm.poll);
    if (pm.ws) { pm.ws.onclose = null; try { pm.ws.close(); } catch (e) { /* ignore */ } }
    pm.ws = null;
  }
  function pmConnect(token, t) {
    pmClose();
    let ws;
    try { ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market'); } catch (e) { return pmPoll(token, t); }
    pm.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ assets_ids: [token], type: 'market', custom_feature_enabled: true })); pm.ping = setInterval(() => { try { ws.send('PING'); } catch (e) { /* closed */ } }, 9000); };
    ws.onmessage = (e) => {
      if (e.data === 'PONG' || pm.token !== token) return;
      let d; try { d = JSON.parse(e.data); } catch (err) { return; }
      for (const x of Array.isArray(d) ? d : [d]) {
        if (x.event_type === 'best_bid_ask' && x.asset_id === token) { pm.bid = +x.best_bid; pm.ask = +x.best_ask; pm.lastMsg = Date.now(); }
        else if (x.price_changes) { for (const c of x.price_changes) if (c.asset_id === token && c.best_bid != null) { pm.bid = +c.best_bid; pm.ask = +c.best_ask; pm.lastMsg = Date.now(); } }
        else if (x.event_type === 'last_trade_price' && x.asset_id === token) { pm.last = +x.price; pm.lastMsg = Date.now(); }
        else if (x.event_type === 'book' && x.asset_id === token) {
          const b = (x.bids || []).map((q) => +q.price), a = (x.asks || []).map((q) => +q.price);
          if (b.length) pm.bid = Math.max(...b); if (a.length) pm.ask = Math.min(...a); pm.lastMsg = Date.now();
        }
      }
      pm.status = 'live';
    };
    ws.onclose = () => { clearInterval(pm.ping); if (pm.t === t) pmPoll(token, t); };
  }
  function pmPoll(token, t) {   // fallback: REST midpoint every 5s
    clearInterval(pm.poll);
    pm.status = 'polling';
    const go = async () => {
      if (pm.t !== t) return clearInterval(pm.poll);
      try { const j = await getJSON(`https://clob.polymarket.com/midpoint?token_id=${token}`); const m = +j.mid; if (isFinite(m)) { pm.bid = pm.ask = m; pm.lastMsg = Date.now(); } } catch (e) { /* keep last */ }
    };
    go(); pm.poll = setInterval(go, 5000);
  }
  function pmMid() {
    if (pm.bid == null || pm.ask == null) return pm.last;
    if (pm.ask - pm.bid > 0.1 && pm.last != null) return pm.last;
    return (pm.bid + pm.ask) / 2;
  }

  function windowOdds() {
    const C = state.candles;
    const t = now(), Ws = bucket(t), e = t - Ws;
    const closed = closedCandles();
    if (closed.length < 60 || !C.length) return null;
    const cur = C[C.length - 1];
    const K = cur.t === Ws ? cur.o : closed[closed.length - 1].c;
    const S = cur.c;
    const P = params(), i = closed.length - 1;
    const sig0 = E.parkinsonSigma(closed, i, P.volBars, INTERVAL);
    const pVol = E.windowUpProb({
      S, K, sigma: sig0 * P.volScale, elapsed: e, mode: P.mode, W: INTERVAL,
      avgSoFar: twAvg(Ws, t), avgLast60: twAvg(Ws + INTERVAL - 60, t),
    });
    const pr = state.result && state.result.prediction;
    const z = pr && pr.forTime === Ws ? pr.z : 0;
    const vel = E.velocity(closed, i, P.velBars, sig0, INTERVAL);
    const p = E.combineWindow(pVol, z, vel, P);
    return { Ws, e, K, S, p, pVol, z, vel, sigma: sig0 * P.volScale, left: INTERVAL - e };
  }

  function renderWindow() {
    const w = windowOdds();
    if (!w) return;
    pmRoll(w.Ws);
    $('winLabel').textContent = tLocal(w.Ws) + ' – ' + tLocal(w.Ws + INTERVAL) + ' window';
    $('winLeft').textContent = Math.floor(w.left / 60) + ':' + String(Math.floor(w.left % 60)).padStart(2, '0') + ' left';
    const setBar = (bar, label, p) => {
      if (p == null || !isFinite(p)) { $(bar).style.width = '0'; $(label).textContent = '—'; $(label).className = 'num muted'; return; }
      $(bar).style.width = (p * 100).toFixed(1) + '%';
      $(bar).style.background = p >= 0.5 ? 'var(--up)' : 'var(--down)';
      $(label).textContent = 'Up ' + (p * 100).toFixed(1) + '%';
      $(label).className = 'num ' + (p >= 0.5 ? 'up' : 'down');
    };
    setBar('barOurs', 'pOurs', w.p);
    const mk = pmMid();
    setBar('barPoly', 'pPoly', mk);
    const d = w.S - w.K;
    $('winK').textContent = usd(w.K, 2);
    $('winNow').textContent = usd(w.S, 2);
    $('winGap').innerHTML = `<span class="${d >= 0 ? 'up' : 'down'}">${signed(d)}</span> · ${(d / (w.sigma * Math.sqrt(Math.max(1, w.left)))).toFixed(2)}σ of time left`;
    const stale = pm.lastMsg && Date.now() - pm.lastMsg > 30000;
    const diff = mk != null ? (w.p - mk) * 100 : null;
    $('winNote').innerHTML =
      (diff != null ? `Ours is <b>${Math.abs(diff).toFixed(1)} pts ${diff >= 0 ? 'more bullish' : 'more bearish'}</b> than the market. ` : '') +
      `Polymarket: ${esc(stale ? 'stale' : pm.status)}` +
      (pm.token ? ` · <a href="https://polymarket.com/event/btc-updown-5m-${w.Ws}" target="_blank" rel="noopener" style="color:var(--accent)">open market ↗</a>` : '') +
      `<br>Model: ${esc(params().mode)} settlement, ${params().volBars * 5}-min volatility, ${params().velBars * 5}-min velocity` +
      (Object.keys(state.overrides).length ? ' · <b>your slider settings</b>' : state.paramsTuned ? ` · tuned ${new Date(state.paramsTuned).toLocaleDateString()}` : ' · default params') +
      `. Start price is Coinbase's; Polymarket settles on Chainlink, which can differ by a few dollars.`;
    renderEdge(w, mk);
    renderSettingsReadout(w);
    drawWindowLines(w);
  }

  // Start price (target) labelled with live P(Up), plus 95% safe-zone lines that tighten as time runs out
  const winLines = {};
  function drawWindowLines(w) {
    const want = state.view.pred && w;
    if (!want) { for (const k of Object.keys(winLines)) { candleSeries.removePriceLine(winLines[k]); delete winLines[k]; } return; }
    const spread = w.sigma * Math.sqrt(Math.max(1, w.left));
    const gap95 = 1.645 * spread;   // one-sided 95%
    const gap85 = 1.036 * spread;   // one-sided 85%
    const upCol = COLORS.up, dnCol = COLORS.down;
    const spec = {
      start: { price: w.K, color: w.p >= 0.5 ? upCol : dnCol, lineWidth: 2, lineStyle: LW.LineStyle.Solid, axisLabelVisible: true,
               title: `Start · Up ${(w.p * 100).toFixed(0)}%` },
      hi: { price: w.K + gap95, color: 'rgba(22,199,132,0.7)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'Up 95%' },
      lo: { price: w.K - gap95, color: 'rgba(234,57,67,0.7)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'Down 95%' },
      hi85: { price: w.K + gap85, color: 'rgba(245,176,65,0.85)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'Up 85%' },
      lo85: { price: w.K - gap85, color: 'rgba(245,176,65,0.85)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: true, title: 'Down 85%' },
    };
    for (const [k, o] of Object.entries(spec)) {
      if (winLines[k]) winLines[k].applyOptions(o); else winLines[k] = candleSeries.createPriceLine(o);
    }
  }

  // ---------- model settings (sliders) ----------
  const SLIDERS = [
    { id: 'setVol', key: 'volBars', fmt: (v) => `${v} candle${v > 1 ? 's' : ''} (${fmtMin(v * 5)})` },
    { id: 'setVel', key: 'velBars', fmt: (v) => `${v} candle${v > 1 ? 's' : ''} (${fmtMin(v * 5)})` },
    { id: 'setScale', key: 'volScale', fmt: (v) => `×${(+v).toFixed(2)}` },
  ];
  function fmtMin(m) { return m < 60 ? m + ' min' : (m / 60).toFixed(m % 60 ? 1 : 0) + ' h'; }
  function syncSettingsUI() {
    const P = params();
    for (const sl of SLIDERS) {
      const el = $(sl.id);
      if (!el) continue;
      el.value = P[sl.key];
      $(sl.id + 'Val').textContent = sl.fmt(P[sl.key]);
      const tuned = state.params[sl.key];
      $(sl.id + 'Tuned').textContent = 'tuned: ' + sl.fmt(tuned) + (state.overrides[sl.key] != null && state.overrides[sl.key] !== tuned ? '' : ' ✓');
    }
    $('setReset').disabled = !Object.keys(state.overrides).length;
  }
  for (const sl of SLIDERS) {
    const el = $(sl.id);
    if (!el) continue;
    el.oninput = () => {
      const v = sl.key === 'volScale' ? +(+el.value).toFixed(2) : Math.round(+el.value);
      if (v === state.params[sl.key]) delete state.overrides[sl.key]; else state.overrides[sl.key] = v;
      store.set('overrides', state.overrides);
      syncSettingsUI();
      renderWindow();
    };
  }
  $('setReset').onclick = () => { state.overrides = {}; store.set('overrides', {}); syncSettingsUI(); renderWindow(); };
  $('bankroll').value = state.sizing.bankroll || '';
  $('bankroll').oninput = () => { const v = parseFloat($('bankroll').value); state.sizing.bankroll = v > 0 ? v : null; saveSizing(); };
  for (const [id, key, parse] of [['sizeBasis', 'basis', String], ['sizeKelly', 'kelly', Number], ['sizeCap', 'cap', Number]]) {
    $(id).value = String(state.sizing[key]);
    $(id).onchange = () => { state.sizing[key] = parse($(id).value); saveSizing(); };
  }
  syncSettingsUI();

  function renderSettingsReadout(w) {
    const el = $('setReadout');
    if (!el || !w) return;
    const perMin = w.sigma * Math.sqrt(60);
    const left = Math.max(1, w.left);
    const overLeft = w.sigma * Math.sqrt(left);
    const gap95 = 1.645 * overLeft;   // one-sided 95%
    const gapNow = Math.abs(w.S - w.K);
    el.innerHTML =
      `Typical move: <b>$${perMin.toFixed(0)}</b> per minute · <b>$${overLeft.toFixed(0)}</b> over the ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')} left<br>` +
      `Gap needed for 95% sure right now: <b>$${gap95.toFixed(0)}</b> · current gap <b class="${gapNow >= gap95 ? 'up' : 'muted'}">$${gapNow.toFixed(0)}</b>` +
      (gapNow >= gap95 ? ' ✓' : '') +
      `<br>Velocity (last ${fmtMin(params().velBars * 5)}): <b class="${w.vel >= 0 ? 'up' : 'down'}">${w.vel >= 0 ? '+' : ''}${w.vel.toFixed(2)}</b> typical moves` +
      (Object.keys(state.overrides).length ? '<br><span class="flat">Edge-check history was built with the tuned settings, so its win rates may not match your custom ones.</span>' : '');
  }

  // ---------- edge check + paper trading ----------
  state.edge = null;
  fetch('data/edge.json', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((j) => { state.edge = j; }).catch(() => {});
  state.paper = store.get('paper', []);
  const fee = (p) => 0.07 * p * (1 - p);
  function priceAgo(sec) {
    const target = now() - sec;
    let best = null;
    for (const [t, p] of ticks) { if (t <= target) best = p; else break; }
    return best;
  }

  // ---------- bet sizing (fractional Kelly with a hard cap) ----------
  function saveSizing() { store.set('sizing', state.sizing); renderWindow(); }
  function renderSizing(info) {
    const out = $('sizeOut');
    if (!out) return;
    const S = state.sizing, B = +S.bankroll;
    if (!(B > 0)) { out.innerHTML = '<span class="muted">Enter your bankroll to see bet sizes.</span>'; return; }
    if (!info) { out.innerHTML = 'Suggested bet: <b>—</b> <span class="muted">(only shown between 0:40 and 4:30 into a window, once Polymarket odds are in)</span>'; return; }
    const q = S.basis === 'average' ? info.winRate : info.ciLo;     // win chance used for sizing
    const c = info.cost;                                            // ask + fee, per $1 payout
    const live = `<br><span class="muted">Live check: win chance ${(q * 100).toFixed(1)}% (${S.basis}) vs cost ${(c * 100).toFixed(1)}¢ · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>`;
    if (info.ask >= 0.95) {
      out.innerHTML = `Suggested bet: <b>$0</b> <span class="muted">— at ${Math.round(info.ask * 100)}¢ the payoff is too thin for the risk</span>` + live;
      return;
    }
    const fullKelly = Math.max(0, (q - c) / (1 - c));
    const f = Math.min(S.cap, fullKelly * S.kelly);
    if (f <= 0) {
      out.innerHTML = `Suggested bet: <b>$0</b> <span class="muted">— ${S.basis === 'average' ? 'history' : 'even the cautious end of history'} doesn't beat the cost</span>` + live;
      return;
    }
    const amt = B * f, shares = Math.floor(amt / c), spend = shares * c;
    if (shares < 1) { out.innerHTML = `Suggested bet: <b>$0</b> <span class="muted">— the edge is too small to buy even 1 share with this bankroll</span>` + live; return; }
    const tip = `Win chance used: ${(q * 100).toFixed(1)}% (${S.basis}). Full Kelly: ${(fullKelly * 100).toFixed(1)}% of bankroll; using ${S.kelly === 1 ? 'full' : S.kelly === 0.5 ? '½' : '¼'} Kelly${fullKelly * S.kelly > S.cap ? `, capped at ${S.cap * 100}%` : ''}.`;
    out.innerHTML = `<span title="${esc(tip)}">Suggested bet: <b>${(f * 100).toFixed(1)}%</b> = <b>$${spend.toFixed(2)}</b> <span class="muted">(${shares} shares at ${Math.round(info.ask * 100)}¢)</span></span>` +
      `<br><span class="muted">If it loses: <b class="down">−$${spend.toFixed(2)}</b> · if it wins: <b class="up">+$${(shares - spend).toFixed(2)}</b>${fullKelly * S.kelly > S.cap ? ` · capped at ${S.cap * 100}%` : ''}</span>` + live;
  }

  const row = (k, v, cls, tip) => `<div class="erow"${tip ? ` title="${esc(tip)}"` : ''}><span>${k}</span><b class="num ${cls || ''}">${v}</b></div>`;
  function renderEdge(w, mk) {
    const box = $('edgeBox');
    if (!box) return;
    const vEl = $('edgeVerdict');
    const setVerdict = (cls, text) => { vEl.className = 'verdict ' + cls; vEl.textContent = text; };
    if (mk == null || pm.bid == null || pm.ask == null) { setVerdict('grey', 'Waiting'); $('edgeChecks').innerHTML = ''; $('edgeHist').textContent = 'Waiting for Polymarket odds…'; renderSizing(null); renderPaper(); return; }
    const favUp = mk >= 0.5;
    const sign = favUp ? 1 : -1;
    const favMid = favUp ? mk : 1 - mk;
    const ask = favUp ? pm.ask : 1 - pm.bid;          // what it costs to buy the favorite right now
    const breakeven = ask + fee(ask);
    const oursFav = favUp ? w.p : 1 - w.p;
    const p60 = priceAgo(60);
    const mom = p60 != null ? Math.sign(w.S - p60) : null;   // null = not enough tick history yet
    const checks = [
      { ok: oursFav >= favMid, txt: 'Model', tip: `Our model ${(oursFav * 100).toFixed(1)}% vs market ${(favMid * 100).toFixed(1)}%` },
      { ok: mom === sign, txt: 'Momentum', tip: mom == null ? 'Needs 60s of live prices' : 'Price over the last minute moved ' + (mom === sign ? 'toward' : 'away from') + ' the favorite' },
      { ok: Math.sign(w.vel) === sign, txt: 'Velocity', tip: 'Recent 5-min trend ' + (Math.sign(w.vel) === sign ? 'toward' : 'away from') + ' the favorite' },
    ];
    const agree = checks.every((c) => c.ok);
    $('edgeChecks').innerHTML = checks.map((c) => `<li class="${c.ok ? 'ok' : 'no'}" title="${esc(c.tip)}">${c.ok ? '✓' : '✗'} ${c.txt}</li>`).join('');

    const favName = favUp ? 'Up' : 'Down';
    const E_ = state.edge;
    const cp = Math.round(w.e / 60) * 60;
    if (!E_ || w.e < 40 || w.e > 270 || !E_.checkpoints[cp]) {
      setVerdict('grey', w.e < 40 ? 'Wait' : w.e > 270 ? 'Too late' : 'No data');
      $('edgeHist').innerHTML = row('Buy ' + favName + ' at', `${(ask * 100).toFixed(0)}¢`, favUp ? 'up' : 'down') + row('Need to win', `${(breakeven * 100).toFixed(0)}%`);
      renderSizing(null);
      renderPaper();
      return;
    }
    const C = E_.checkpoints[cp];
    const b = C.byBucket.find((x) => favMid >= x.lo && favMid < x.hi) || C.byBucket[C.byBucket.length - 1];
    let cell = agree ? b.agree : b.all, scope = `favorite priced ${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}%`;
    if (!cell.n || cell.n < 20) { cell = agree ? C.agree : C.all; scope = 'any favorite price (too few at this price)'; }
    const cond = agree ? 'all three signals agreed' : 'signals did not all agree';
    let cls, text;
    if (cell.n < 20) { cls = 'grey'; text = 'Not enough data'; }
    else if (cell.ciLo > breakeven) { cls = 'green'; text = 'Edge'; }
    else if (cell.winRate > breakeven) { cls = 'amber'; text = 'Maybe'; }
    else { cls = 'grey'; text = 'No edge'; }
    setVerdict(cls, text);
    const per100 = (cell.winRate - breakeven) / ask * 100;
    const details = `Past windows at ~${cp / 60}:00, favorite priced ${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}%, ${agree ? 'all 3 checks passing' : 'not all checks passing'}: won ${cell.wins} of ${cell.n} (likely range ${(cell.ciLo * 100).toFixed(0)}–${(cell.ciHi * 100).toFixed(0)}%). Cost includes the ${(fee(ask) * 100).toFixed(1)}¢ fee.`;
    $('edgeHist').innerHTML =
      row('Buy ' + favName + ' at', `${(ask * 100).toFixed(0)}¢`, favUp ? 'up' : 'down') +
      row('Need to win', `${(breakeven * 100).toFixed(0)}%`) +
      row('Has won', cell.n >= 20 ? `${(cell.winRate * 100).toFixed(0)}% <span class="muted">of ${cell.n}</span>` : '—', '', details) +
      (cell.n >= 20 ? row('Per $100', `${per100 >= 0 ? '+' : '−'}$${Math.abs(per100).toFixed(2)}`, per100 >= 0 ? 'up' : 'down') : '') +
      (ask >= 0.95 ? `<div class="warn">⚠ One loss wipes out ~${Math.round(ask / Math.max(0.001, 1 - ask - fee(ask)))} wins</div>` : '');
    renderSizing(cell.n >= 20 ? { winRate: cell.winRate, ciLo: cell.ciLo, cost: breakeven, ask } : null);

    // Paper trade: first all-agree, non-grey reading between 1:40 and 3:20 into the window
    if (agree && cls !== 'grey' && w.e >= 100 && w.e <= 200 && !state.paper.some((x) => x.t === w.Ws)) {
      state.paper.push({ t: w.Ws, side: favName, ask: +ask.toFixed(4), fee: +fee(ask).toFixed(4), at: Math.round(w.e), verdict: cls, result: null });
      state.paper = state.paper.slice(-300);
      store.set('paper', state.paper);
    }
    renderPaper();
  }

  let paperChecking = 0;
  async function resolvePaper() {
    const due = state.paper.filter((x) => x.result == null && x.t + INTERVAL < now() - 30);
    if (!due.length || Date.now() - paperChecking < 15000) return;
    paperChecking = Date.now();
    for (const x of due.slice(0, 5)) {
      try {
        const m = (await getJSON(`https://gamma-api.polymarket.com/markets?closed=true&slug=btc-updown-5m-${x.t}`))[0];
        if (!m) continue;
        const prices = JSON.parse(m.outcomePrices || '[]'), outs = JSON.parse(m.outcomes || '[]');
        const i = outs.indexOf(x.side);
        if (prices[i] === '1' || prices[i] === '0') x.result = prices[i] === '1' ? 1 : 0;
      } catch (e) { /* try later */ }
    }
    store.set('paper', state.paper);
  }
  function renderPaper() {
    resolvePaper();
    const done = state.paper.filter((x) => x.result != null);
    const open = state.paper.length - done.length;
    if (!state.paper.length) { $('edgePaper').innerHTML = 'Paper trades: none yet <span title="Logged automatically when all 3 checks pass between 1:40 and 3:20 into a window">ⓘ</span>'; return; }
    const wins = done.filter((x) => x.result === 1).length;
    const pnl = done.reduce((a, x) => a + x.result - x.ask - x.fee, 0);
    $('edgePaper').innerHTML = `Paper trades: <b>${wins} of ${done.length}</b> won` +
      (done.length ? ` · <b class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl * 100 / done.length).toFixed(2)}</b> per $100` : '') +
      (open ? ` · ${open} pending` : '') + ` · <a href="#" id="paperReset" style="color:var(--muted)">reset</a>`;
    const r = $('paperReset');
    if (r) r.onclick = (ev) => { ev.preventDefault(); if (confirm('Clear paper-trade history?')) { state.paper = []; store.set('paper', []); renderPaper(); } };
  }

  // ---------- wiring ----------
  const viewBoxes = { showMarks: 'marks', showLines: 'lines', showPred: 'pred', showLevels: 'levels' };
  $('minTouches').value = String(state.view.minTouches);
  $('minTouches').onchange = () => { state.view.minTouches = +$('minTouches').value; store.set('view', state.view); computeLevels(); renderLevels(); };
  for (const [id, k] of Object.entries(viewBoxes)) {
    $(id).checked = state.view[k] !== false;
    $(id).onchange = () => { state.view[k] = $(id).checked; store.set('view', state.view); renderAnalysis(); renderWindow(); };
  }
  function showLatest() {
    const n = state.candles.length, bars = chartEl.clientWidth < 600 ? 60 : 140;
    chart.timeScale().setVisibleLogicalRange({ from: n - bars, to: n + 4 });
  }
  $('fit').onclick = showLatest;
  $('minConf').value = state.view.minConf;
  $('minConfVal').textContent = state.view.minConf + '%';
  $('minConf').oninput = () => {
    state.view.minConf = +$('minConf').value;
    $('minConfVal').textContent = state.view.minConf + '%';
    store.set('view', state.view);
    if (state.result) { renderMarkers(state.result); renderChartPatterns(state.result); renderActive(state.result); }
  };
  $('allOn').onclick = () => { for (const t in P) state.enabled[t] = true; saveToggles(); };
  $('allOff').onclick = () => { for (const t in P) state.enabled[t] = false; saveToggles(); };
  $('source').value = state.source;
  $('source').onchange = () => { state.source = $('source').value; store.set('source', state.source); start(state.source); };

  const wake = () => {
    if (document.visibilityState !== 'visible' || !feed.key) return;
    resync();
    if (!feed.open || Date.now() / 1000 - feed.lastMsg > 10) connectStream();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);

  renderToggles(null);
  setInterval(tick, 1000);
  start(state.source);
})();

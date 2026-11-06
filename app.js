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
    view: Object.assign({ marks: true, lines: true, pred: true, minConf: 55 }, store.get('view', {})),
    source: store.get('source', 'auto'),
    result: null,
    lastAnalyzed: null,
    pending: null,                 // prediction waiting for its candle to close
    live: store.get('live', []),   // scored live predictions
    skew: 0,                       // exchange clock minus local clock (s)
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
        return type < 3 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
    if (state.view.pred && pr) {
      ghostSeries.setData([{ time: pr.forTime, open: pr.ghost.o, high: pr.ghost.h, low: pr.ghost.l, close: pr.ghost.c }]);
      const col = pr.dir > 0 ? COLORS.up : pr.dir < 0 ? COLORS.down : COLORS.flat;
      priceLines.push(candleSeries.createPriceLine({ price: pr.close, color: col, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: 'pred' }));
      priceLines.push(candleSeries.createPriceLine({ price: pr.high, color: 'rgba(125,136,153,0.6)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: false, title: '' }));
      priceLines.push(candleSeries.createPriceLine({ price: pr.low, color: 'rgba(125,136,153,0.6)', lineWidth: 1, lineStyle: LW.LineStyle.Dotted, axisLabelVisible: false, title: '' }));
    } else ghostSeries.setData([]);

    $('predFor').textContent = 'Next candle · closes ' + tLocal(pr.forTime + INTERVAL);
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
  }

  // ---------- wiring ----------
  const viewBoxes = { showMarks: 'marks', showLines: 'lines', showPred: 'pred' };
  for (const [id, k] of Object.entries(viewBoxes)) {
    $(id).checked = state.view[k] !== false;
    $(id).onchange = () => { state.view[k] = $(id).checked; store.set('view', state.view); renderAnalysis(); };
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

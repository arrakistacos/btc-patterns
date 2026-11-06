/*
 * BTC Pattern Engine
 * Detects classic candlestick + chart patterns on closed candles only (no repainting),
 * scores each one, learns walk-forward hit rates from the loaded history, and
 * predicts the close of the next candle.
 *
 * Candle shape: { t: unixSeconds, o, h, l, c, v }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatternEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PATTERNS = {
    // ---- Candlestick patterns (1–3 candles) ----
    bull_engulf:    { name: 'Bullish Engulfing',    label: 'Engulf',   kind: 'candle', bias: 1 },
    bear_engulf:    { name: 'Bearish Engulfing',    label: 'Engulf',   kind: 'candle', bias: -1 },
    hammer:         { name: 'Hammer',               label: 'Hammer',   kind: 'candle', bias: 1 },
    inv_hammer:     { name: 'Inverted Hammer',      label: 'Inv Ham',  kind: 'candle', bias: 1 },
    shooting_star:  { name: 'Shooting Star',        label: 'Sh Star',  kind: 'candle', bias: -1 },
    hanging_man:    { name: 'Hanging Man',          label: 'Hang Man', kind: 'candle', bias: -1 },
    morning_star:   { name: 'Morning Star',         label: 'M Star',   kind: 'candle', bias: 1 },
    evening_star:   { name: 'Evening Star',         label: 'E Star',   kind: 'candle', bias: -1 },
    three_soldiers: { name: 'Three White Soldiers', label: '3 Sold',   kind: 'candle', bias: 1 },
    three_crows:    { name: 'Three Black Crows',    label: '3 Crows',  kind: 'candle', bias: -1 },
    bull_harami:    { name: 'Bullish Harami',       label: 'Harami',   kind: 'candle', bias: 1 },
    bear_harami:    { name: 'Bearish Harami',       label: 'Harami',   kind: 'candle', bias: -1 },
    piercing:       { name: 'Piercing Line',        label: 'Pierce',   kind: 'candle', bias: 1 },
    dark_cloud:     { name: 'Dark Cloud Cover',     label: 'Dk Cloud', kind: 'candle', bias: -1 },
    doji:           { name: 'Doji (trend exhaustion)', label: 'Doji',  kind: 'candle', bias: 0 },
    // ---- Chart patterns (multi-swing) ----
    double_top:         { name: 'Double Top',               label: 'Dbl Top',  kind: 'chart', bias: -1 },
    double_bottom:      { name: 'Double Bottom',            label: 'Dbl Bot',  kind: 'chart', bias: 1 },
    head_shoulders:     { name: 'Head & Shoulders',         label: 'H&S',      kind: 'chart', bias: -1 },
    inv_head_shoulders: { name: 'Inverse Head & Shoulders', label: 'Inv H&S',  kind: 'chart', bias: 1 },
    asc_triangle:       { name: 'Ascending Triangle',       label: 'Asc Tri',  kind: 'chart', bias: 1 },
    desc_triangle:      { name: 'Descending Triangle',      label: 'Desc Tri', kind: 'chart', bias: -1 },
    sym_triangle:       { name: 'Symmetrical Triangle',     label: 'Sym Tri',  kind: 'chart', bias: 0 },
    rising_wedge:       { name: 'Rising Wedge',             label: 'R Wedge',  kind: 'chart', bias: -1 },
    falling_wedge:      { name: 'Falling Wedge',            label: 'F Wedge',  kind: 'chart', bias: 1 },
    bull_flag:          { name: 'Bull Flag',                label: 'Bull Flag', kind: 'chart', bias: 1 },
    bear_flag:          { name: 'Bear Flag',                label: 'Bear Flag', kind: 'chart', bias: -1 },
  };

  const PIVOT_K = 4;        // bars each side to confirm a swing high/low (confirmed 4 bars late)
  const PIVOT_WINDOW = 120; // bars of swings considered for chart patterns (10 hours on 5m)
  const PRIOR_N = 20;       // shrinkage strength for hit-rate estimates
  const MAX_Z = 1.4;        // caps combined prediction at ~80%

  // ---------- helpers ----------
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const body = (k) => Math.abs(k.c - k.o);
  const range = (k) => Math.max(k.h - k.l, 1e-9);
  const upW = (k) => k.h - Math.max(k.o, k.c);
  const loW = (k) => Math.min(k.o, k.c) - k.l;
  const isBull = (k) => k.c > k.o;
  const isBear = (k) => k.c < k.o;
  const logit = (p) => Math.log(p / (1 - p));

  function computeATR(C, n = 14) {
    const out = new Array(C.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < C.length; i++) {
      const k = C[i];
      const tr = i === 0 ? k.h - k.l
        : Math.max(k.h - k.l, Math.abs(k.h - C[i - 1].c), Math.abs(k.l - C[i - 1].c));
      if (i < n) { sum += tr; if (i === n - 1) out[i] = sum / n; }
      else out[i] = (out[i - 1] * (n - 1) + tr) / n;
    }
    return out;
  }

  function computeVolAvg(C, n = 20) {
    const out = new Array(C.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < C.length; i++) {
      if (i >= n) out[i] = sum / n;
      sum += C[i].v || 0;
      if (i >= n) sum -= C[i - n].v || 0;
    }
    return out;
  }

  function computePivots(C, k) {
    const highs = [], lows = [];
    for (let j = k; j < C.length - k; j++) {
      let isH = true, isL = true;
      for (let d = 1; d <= k && (isH || isL); d++) {
        if (!(C[j].h >= C[j - d].h && C[j].h > C[j + d].h)) isH = false;
        if (!(C[j].l <= C[j - d].l && C[j].l < C[j + d].l)) isL = false;
      }
      if (isH) highs.push({ i: j, p: C[j].h });
      if (isL) lows.push({ i: j, p: C[j].l });
    }
    return { highs, lows };
  }

  // Net move over the 10 bars ending at j, in ATRs (+ = uptrend into j)
  function trendInto(ctx, j) {
    if (j < 10) return 0;
    const A = ctx.atr[j];
    if (!(A > 0)) return 0;
    return (ctx.C[j].c - ctx.C[j - 10].c) / A;
  }

  function volFactor(ctx, i) {
    const r = (ctx.C[i].v || 0) / ctx.vavg[i];
    if (!isFinite(r)) return 0.5;
    return clamp01((r - 0.8) / 1.2);
  }

  function fitLine(pts) {
    const n = pts.length;
    let sx = 0, sy = 0;
    for (const q of pts) { sx += q.i; sy += q.p; }
    const mx = sx / n, my = sy / n;
    let num = 0, den = 0;
    for (const q of pts) { num += (q.i - mx) * (q.p - my); den += (q.i - mx) ** 2; }
    const m = den ? num / den : 0;
    const b = my - m * mx;
    let maxRes = 0;
    for (const q of pts) maxRes = Math.max(maxRes, Math.abs(q.p - (m * q.i + b)));
    return { m, b, maxRes, at: (x) => m * x + b };
  }

  // ---------- candlestick patterns (must end exactly on bar i) ----------
  function detectCandles(ctx, i) {
    const out = [];
    if (i < 13) return out;
    const { C, atr } = ctx;
    const A = atr[i - 1];
    if (!(A > 0)) return out;
    const k = C[i], p = C[i - 1], q = C[i - 2];
    const vf = volFactor(ctx, i);
    const tb1 = trendInto(ctx, i - 1);
    const tb2 = trendInto(ctx, i - 2);
    const dn = (t) => clamp01((-t - 0.5) / 2.5);
    const up = (t) => clamp01((t - 0.5) / 2.5);
    const bk = body(k), bp = body(p), bq = body(q), rk = range(k);

    const push = (type, i0, quality, bias, why) => {
      const b = bias === undefined ? PATTERNS[type].bias : bias;
      out.push({
        type, kind: 'candle', id: type + ':' + C[i].t, key: type + ':' + C[i].t,
        i0, i1: i, t0: C[i0].t, t1: C[i].t, bias: b, quality: clamp01(quality),
        status: 'complete', why,
        price: b >= 0 ? Math.min(...C.slice(i0, i + 1).map((x) => x.l)) : Math.max(...C.slice(i0, i + 1).map((x) => x.h)),
      });
    };

    // Engulfing
    if (isBear(p) && isBull(k) && k.o <= p.c + 0.02 * A && k.c >= p.o && bk > bp && bk >= 0.3 * A && tb1 < -0.5)
      push('bull_engulf', i - 1, 0.35 + 0.25 * clamp01((bk / Math.max(bp, 1e-9) - 1) / 2) + 0.25 * dn(tb1) + 0.15 * vf, 1,
        'Green body swallowed the prior red body after a decline');
    if (isBull(p) && isBear(k) && k.o >= p.c - 0.02 * A && k.c <= p.o && bk > bp && bk >= 0.3 * A && tb1 > 0.5)
      push('bear_engulf', i - 1, 0.35 + 0.25 * clamp01((bk / Math.max(bp, 1e-9) - 1) / 2) + 0.25 * up(tb1) + 0.15 * vf, -1,
        'Red body swallowed the prior green body after a rally');

    // Single-candle shapes
    if (bk > 0.08 * rk && rk >= 0.6 * A) {
      const lowerLong = loW(k) >= 2 * bk && upW(k) <= 0.15 * rk;
      const upperLong = upW(k) >= 2 * bk && loW(k) <= 0.15 * rk;
      if (lowerLong) {
        const sq = clamp01((loW(k) / rk - 0.55) / 0.35);
        if (tb1 < -1) push('hammer', i, 0.3 + 0.3 * sq + 0.25 * dn(tb1) + 0.15 * vf, 1, 'Long lower wick rejecting lows after a decline');
        if (tb1 > 1) push('hanging_man', i, 0.25 + 0.3 * sq + 0.25 * up(tb1) + 0.15 * vf, -1, 'Long lower wick at the top of a rally');
      }
      if (upperLong) {
        const sq = clamp01((upW(k) / rk - 0.55) / 0.35);
        if (tb1 < -1) push('inv_hammer', i, 0.25 + 0.3 * sq + 0.25 * dn(tb1) + 0.15 * vf, 1, 'Long upper wick probing higher after a decline');
        if (tb1 > 1) push('shooting_star', i, 0.3 + 0.3 * sq + 0.25 * up(tb1) + 0.15 * vf, -1, 'Long upper wick rejecting highs after a rally');
      }
    }

    // Doji at an extended trend
    if (bk <= 0.08 * rk && rk >= 0.5 * A && Math.abs(tb1) >= 1.5)
      push('doji', i, 0.2 + 0.25 * (tb1 < 0 ? dn(tb1) : up(tb1)), tb1 < 0 ? 1 : -1,
        'Indecision candle after a ' + (tb1 < 0 ? 'decline' : 'rally'));

    // Morning / Evening star
    if (isBear(q) && bq >= 0.6 * A && bp <= 0.4 * bq && isBull(k) && bk >= 0.4 * A && tb2 < -0.5) {
      const mid = (q.o + q.c) / 2;
      if (k.c > mid) push('morning_star', i - 2, 0.4 + 0.25 * clamp01((k.c - mid) / (bq / 2)) + 0.2 * dn(tb2) + 0.15 * vf, 1,
        'Big red, small pause, green close past the midpoint');
    }
    if (isBull(q) && bq >= 0.6 * A && bp <= 0.4 * bq && isBear(k) && bk >= 0.4 * A && tb2 > 0.5) {
      const mid = (q.o + q.c) / 2;
      if (k.c < mid) push('evening_star', i - 2, 0.4 + 0.25 * clamp01((mid - k.c) / (bq / 2)) + 0.2 * up(tb2) + 0.15 * vf, -1,
        'Big green, small pause, red close past the midpoint');
    }

    // Three white soldiers / three black crows
    const trio = [q, p, k];
    if (trio.every(isBull) && p.c > q.c && k.c > p.c && Math.min(bq, bp, bk) >= 0.4 * A &&
        p.o >= q.o - 0.05 * A && p.o <= q.c + 0.05 * A && k.o >= p.o - 0.05 * A && k.o <= p.c + 0.05 * A &&
        trio.every((x) => upW(x) <= 0.4 * body(x))) {
      const avgB = (bq + bp + bk) / 3 / A;
      push('three_soldiers', i - 2, 0.4 + 0.3 * clamp01((avgB - 0.4) / 0.8) + 0.15 * clamp01(0.5 - tb2 / 4) + 0.15 * vf, 1,
        'Three strong green candles, each closing higher');
    }
    if (trio.every(isBear) && p.c < q.c && k.c < p.c && Math.min(bq, bp, bk) >= 0.4 * A &&
        p.o <= q.o + 0.05 * A && p.o >= q.c - 0.05 * A && k.o <= p.o + 0.05 * A && k.o >= p.c - 0.05 * A &&
        trio.every((x) => loW(x) <= 0.4 * body(x))) {
      const avgB = (bq + bp + bk) / 3 / A;
      push('three_crows', i - 2, 0.4 + 0.3 * clamp01((avgB - 0.4) / 0.8) + 0.15 * clamp01(0.5 + tb2 / 4) + 0.15 * vf, -1,
        'Three strong red candles, each closing lower');
    }

    // Harami (small inside body, stays in the near half) and Piercing / Dark cloud (pushes past midpoint)
    if (isBear(p) && bp >= 0.6 * A && isBull(k) && tb1 < -0.5) {
      const mid = (p.o + p.c) / 2;
      if (k.o >= p.c - 0.02 * A && k.c <= mid && bk <= 0.5 * bp && bk >= 0.05 * A)
        push('bull_harami', i - 1, 0.3 + 0.2 * (1 - bk / bp) + 0.3 * dn(tb1) + 0.2 * vf, 1, 'Small green candle held inside a big red one');
      else if (k.o <= p.c + 0.05 * A && k.c > mid && k.c < p.o)
        push('piercing', i - 1, 0.35 + 0.3 * clamp01((k.c - mid) / (p.o - mid)) + 0.2 * dn(tb1) + 0.15 * vf, 1, 'Green candle closed above the midpoint of a big red one');
    }
    if (isBull(p) && bp >= 0.6 * A && isBear(k) && tb1 > 0.5) {
      const mid = (p.o + p.c) / 2;
      if (k.o <= p.c + 0.02 * A && k.c >= mid && bk <= 0.5 * bp && bk >= 0.05 * A)
        push('bear_harami', i - 1, 0.3 + 0.2 * (1 - bk / bp) + 0.3 * up(tb1) + 0.2 * vf, -1, 'Small red candle held inside a big green one');
      else if (k.o >= p.c - 0.05 * A && k.c < mid && k.c > p.o)
        push('dark_cloud', i - 1, 0.35 + 0.3 * clamp01((mid - k.c) / (mid - p.o)) + 0.2 * up(tb1) + 0.15 * vf, -1, 'Red candle closed below the midpoint of a big green one');
    }
    return out;
  }

  // ---------- chart patterns (active on bar i) ----------
  function minBetween(C, a, b) {
    let best = { i: -1, p: Infinity };
    for (let j = a + 1; j < b; j++) if (C[j].l < best.p) best = { i: j, p: C[j].l };
    return best;
  }
  function maxBetween(C, a, b) {
    let best = { i: -1, p: -Infinity };
    for (let j = a + 1; j < b; j++) if (C[j].h > best.p) best = { i: j, p: C[j].h };
    return best;
  }

  function chartSig(ctx, i, type, o) {
    const C = ctx.C;
    const key = type + ':' + o.anchor;
    return Object.assign({
      type, kind: 'chart', key, id: key + (o.status === 'forming' ? '' : ':brk'),
      i1: i, t1: C[i].t, t0: C[o.i0].t,
    }, o, { quality: clamp01(o.quality) });
  }

  function detectDouble(ctx, i, piv, dir) {
    // dir = -1 double top (uses highs), +1 double bottom (uses lows)
    const { C, atr } = ctx;
    const A = atr[i];
    const P = dir < 0 ? piv.H : piv.L;
    if (P.length < 2) return null;
    const b = P[P.length - 1];
    if (i - b.i > 40) return null;
    for (let x = P.length - 2; x >= Math.max(0, P.length - 4); x--) {
      const a = P[x];
      const sep = b.i - a.i;
      if (sep < 6 || sep > 80) continue;
      const diff = Math.abs(a.p - b.p);
      if (diff > 0.6 * A) continue;
      const extreme = dir < 0 ? Math.max(a.p, b.p) : Math.min(a.p, b.p);
      const mid = dir < 0 ? minBetween(C, a.i, b.i) : maxBetween(C, a.i, b.i);
      const beyond = dir < 0 ? maxBetween(C, a.i, b.i).p - extreme : extreme - minBetween(C, a.i, b.i).p;
      if (beyond > 0.1 * A) continue;
      const height = Math.abs(extreme - mid.p);
      if (height < 2 * A) continue;
      let broke = -1, invalid = false;
      for (let j = b.i + 1; j <= i; j++) {
        if (dir < 0 ? C[j].c > extreme + 0.2 * A : C[j].c < extreme - 0.2 * A) { invalid = true; break; }
        if (broke < 0 && (dir < 0 ? C[j].c < mid.p : C[j].c > mid.p)) broke = j;
      }
      if (invalid) continue;
      const target = mid.p + dir * height;
      if (broke >= 0) {
        if (i - broke > 15) continue;
        let reached = false;
        for (let j = broke; j <= i; j++) if (dir < 0 ? C[j].l <= target : C[j].h >= target) reached = true;
        if (reached) continue;
      }
      const type = dir < 0 ? 'double_top' : 'double_bottom';
      const status = broke >= 0 ? (dir < 0 ? 'neckline broken ↓' : 'neckline broken ↑') : 'forming';
      return chartSig(ctx, i, type, {
        anchor: C[a.i].t + '-' + C[b.i].t, i0: a.i, bias: dir, status, target,
        quality: 0.35 + 0.2 * (1 - diff / (0.6 * A)) + 0.15 * clamp01((height / A - 2) / 4) + (broke >= 0 ? 0.2 : 0) + 0.1 * volFactor(ctx, broke >= 0 ? broke : b.i),
        why: (dir < 0 ? 'Two matching peaks' : 'Two matching lows') + ' with a ' + (height / A).toFixed(1) + '×ATR swing between',
        price: extreme,
        lines: [
          { pts: [[C[a.i].t, a.p], [C[mid.i].t, mid.p], [C[b.i].t, b.p]] },
          { pts: [[C[a.i].t, mid.p], [C[i].t, mid.p]], dash: true },
        ],
      });
    }
    return null;
  }

  function detectHS(ctx, i, piv, dir) {
    // dir = -1 head & shoulders (highs), +1 inverse (lows)
    const { C, atr } = ctx;
    const A = atr[i];
    const P = dir < 0 ? piv.H : piv.L;
    if (P.length < 3) return null;
    const [ls, hd, rs] = P.slice(-3);
    if (i - rs.i > 40) return null;
    const s = -dir; // +1 for H&S: head is above shoulders
    if (!(s * (hd.p - ls.p) > 0 && s * (hd.p - rs.p) > 0)) return null;
    const t1 = dir < 0 ? minBetween(C, ls.i, hd.i) : maxBetween(C, ls.i, hd.i);
    const t2 = dir < 0 ? minBetween(C, hd.i, rs.i) : maxBetween(C, hd.i, rs.i);
    if (t1.i < 0 || t2.i < 0 || t2.i === t1.i) return null;
    const neck = (x) => t1.p + (t2.p - t1.p) * (x - t1.i) / (t2.i - t1.i);
    const height = s * (hd.p - neck(hd.i));
    const shDiff = Math.abs(ls.p - rs.p);
    if (height < 2 * A) return null;
    if (s * (hd.p - (s > 0 ? Math.max(ls.p, rs.p) : Math.min(ls.p, rs.p))) < 0.5 * A) return null;
    if (shDiff > 0.35 * height) return null;
    if (s * (ls.p - neck(ls.i)) < 0.5 * A || s * (rs.p - neck(rs.i)) < 0.5 * A) return null;
    let broke = -1;
    for (let j = rs.i + 1; j <= i; j++) {
      if (s * (C[j].c - hd.p) > 0) return null; // took out the head → invalid
      if (broke < 0 && s * (neck(j) - C[j].c) > 0) broke = j;
    }
    const target = neck(broke >= 0 ? broke : i) - s * height;
    if (broke >= 0) {
      if (i - broke > 15) return null;
      for (let j = broke; j <= i; j++) if (s > 0 ? C[j].l <= target : C[j].h >= target) return null;
    }
    const timeSym = 1 - Math.abs((hd.i - ls.i) - (rs.i - hd.i)) / (rs.i - ls.i);
    const type = dir < 0 ? 'head_shoulders' : 'inv_head_shoulders';
    return chartSig(ctx, i, type, {
      anchor: C[ls.i].t + '-' + C[hd.i].t + '-' + C[rs.i].t, i0: ls.i, bias: dir,
      status: broke >= 0 ? (dir < 0 ? 'neckline broken ↓' : 'neckline broken ↑') : 'forming', target,
      quality: 0.3 + 0.2 * (1 - shDiff / (0.35 * height)) + 0.15 * timeSym + (broke >= 0 ? 0.2 : 0) + 0.15 * clamp01((height / A - 2) / 4),
      why: 'Three swings, middle one ' + (dir < 0 ? 'highest' : 'lowest') + ', shoulders within ' + Math.round(shDiff / height * 100) + '% of head height',
      price: hd.p,
      lines: [
        { pts: [[C[ls.i].t, ls.p], [C[t1.i].t, t1.p], [C[hd.i].t, hd.p], [C[t2.i].t, t2.p], [C[rs.i].t, rs.p]] },
        { pts: [[C[t1.i].t, t1.p], [C[i].t, neck(i)]], dash: true },
      ],
    });
  }

  function detectTriangle(ctx, i, piv) {
    const W = 90;
    const H = piv.H.filter((x) => x.i >= i - W).slice(-4);
    const L = piv.L.filter((x) => x.i >= i - W).slice(-4);
    // Try dropping stale swings from the front; keep the cleanest fit (quality weighs fit + touches).
    let best = null;
    for (let nh = H.length; nh >= 2; nh--) {
      for (let nl = L.length; nl >= 2; nl--) {
        const r = tryTriangle(ctx, i, H.slice(-nh), L.slice(-nl));
        if (r && (!best || r.quality > best.quality)) best = r;
      }
    }
    return best;
  }

  function tryTriangle(ctx, i, h, l) {
    const { C, atr } = ctx;
    const A = atr[i];
    const start = Math.min(h[0].i, l[0].i);
    if (i - start < 15) return null;
    const fu = fitLine(h), fl = fitLine(l);
    const w0 = fu.at(start) - fl.at(start), w1 = fu.at(i) - fl.at(i);
    const tol = Math.max(0.8 * A, 0.06 * w0);
    if (i - h[h.length - 1].i > 30 || i - l[l.length - 1].i > 30) return null; // last touch must be recent
    if (fu.maxRes > tol || fl.maxRes > tol) return null;
    if (!(w0 > 1.2 * A && w1 > 0 && w1 < 0.85 * w0)) return null;
    if (fu.m !== fl.m) {
      const apex = (fl.b - fu.b) / (fu.m - fl.m);
      if (apex < i) return null;
    }
    const su = fu.m / A, sl = fl.m / A, F = 0.025;
    const uFlat = Math.abs(su) <= Math.max(F, 0.25 * Math.abs(sl)), lFlat = Math.abs(sl) <= Math.max(F, 0.25 * Math.abs(su));
    let type = null;
    if (uFlat && sl > F) type = 'asc_triangle';
    else if (lFlat && su < -F) type = 'desc_triangle';
    else if (su < -F && sl > F) type = 'sym_triangle';
    else if (su > F && sl > F && sl > su) type = 'rising_wedge';
    else if (su < -F && sl < -F && su < sl) type = 'falling_wedge';
    if (!type) return null;
    let outside = 0;
    for (let j = start; j < i; j++) if (C[j].c > fu.at(j) + 0.3 * A || C[j].c < fl.at(j) - 0.3 * A) outside++;
    if (outside / (i - start) > 0.1) return null;
    let bias = PATTERNS[type].bias, status = 'forming';
    if (type === 'sym_triangle') bias = Math.sign(C[start].c - C[Math.max(0, start - 20)].c) || 1;
    const brkUp = C[i].c > fu.at(i) + 0.15 * A, brkDn = C[i].c < fl.at(i) - 0.15 * A;
    if (brkUp) { bias = 1; status = 'breakout ↑'; } else if (brkDn) { bias = -1; status = 'breakdown ↓'; }
    const target = bias > 0 ? fu.at(i) + w0 : fl.at(i) - w0;
    const fitQ = 1 - Math.max(fu.maxRes, fl.maxRes) / tol;
    const touches = clamp01((h.length + l.length - 4) / 3);
    return chartSig(ctx, i, type, {
      anchor: String(C[start].t), i0: start, bias, status, target,
      quality: 0.3 + 0.25 * fitQ + 0.15 * touches + (status !== 'forming' ? 0.2 : 0) + 0.1 * volFactor(ctx, i),
      why: (h.length + l.length) + ' touches on converging trendlines',
      price: bias > 0 ? fu.at(i) : fl.at(i),
      lines: [
        { pts: [[C[start].t, fu.at(start)], [C[i].t, fu.at(i)]] },
        { pts: [[C[start].t, fl.at(start)], [C[i].t, fl.at(i)]] },
      ],
    });
  }

  function detectFlag(ctx, i, dir) {
    const { C, atr } = ctx;
    const A = atr[i];
    for (let len = 4; len <= 15; len++) {
      const j = i - len;
      if (j - 3 < 0) break;
      let best = null;
      for (let m = 3; m <= 10; m++) {
        const s = j - m;
        if (s < 0) break;
        const move = dir * (C[j].c - C[s].o);
        if (move >= 3 * A && (!best || move > best.move)) best = { s, move };
      }
      if (!best) continue;
      let agree = 0;
      for (let x = best.s; x <= j; x++) if (dir * (C[x].c - C[x].o) > 0) agree++;
      if (agree / (j - best.s + 1) < 0.55) continue;
      let poleTip = dir > 0 ? -Infinity : Infinity;
      for (let x = best.s; x <= j; x++) poleTip = dir > 0 ? Math.max(poleTip, C[x].h) : Math.min(poleTip, C[x].l);
      let cHi = -Infinity, cLo = Infinity;
      for (let x = j + 1; x < i; x++) { cHi = Math.max(cHi, C[x].h); cLo = Math.min(cLo, C[x].l); }
      const retr = dir > 0 ? poleTip - cLo : cHi - poleTip;
      if (retr < 0 || retr > 0.5 * best.move) continue;
      const beyond = dir > 0 ? cHi - poleTip : poleTip - cLo;
      if (beyond > 0.3 * A) continue;
      if (cHi - cLo > 0.6 * best.move) continue;
      const drift = dir * (C[i - 1].c - C[j + 1].c) / Math.max(1, len - 2) / A;
      if (drift > 0.05) continue;
      if (dir * (C[i].c - (poleTip - dir * 0.5 * best.move)) < 0) continue; // collapsed through the flag
      const brk = dir > 0 ? C[i].c > cHi : C[i].c < cLo;
      const type = dir > 0 ? 'bull_flag' : 'bear_flag';
      const poleBase = dir > 0 ? C[best.s].l : C[best.s].h;
      return chartSig(ctx, i, type, {
        anchor: String(C[j].t), i0: best.s, bias: dir,
        status: brk ? (dir > 0 ? 'breakout ↑' : 'breakdown ↓') : 'forming',
        target: (dir > 0 ? cHi : cLo) + dir * best.move,
        quality: 0.35 + 0.25 * clamp01((best.move / A - 3) / 4) + 0.2 * (1 - retr / (0.5 * best.move)) + (brk ? 0.2 : 0),
        why: 'Pole of ' + (best.move / A).toFixed(1) + '×ATR then a ' + (len - 1) + '-bar pause retracing ' + Math.round(retr / best.move * 100) + '%',
        price: dir > 0 ? cHi : cLo,
        lines: [
          { pts: [[C[best.s].t, poleBase], [C[j].t, poleTip]] },
          { pts: [[C[j + 1].t, cHi], [C[i].t, cHi]], dash: true },
          { pts: [[C[j + 1].t, cLo], [C[i].t, cLo]], dash: true },
        ],
      });
    }
    return null;
  }

  function detectChart(ctx, i, piv) {
    if (!(ctx.atr[i] > 0)) return [];
    return [
      detectDouble(ctx, i, piv, -1), detectDouble(ctx, i, piv, 1),
      detectHS(ctx, i, piv, -1), detectHS(ctx, i, piv, 1),
      detectTriangle(ctx, i, piv),
      detectFlag(ctx, i, 1), detectFlag(ctx, i, -1),
    ].filter(Boolean);
  }

  // ---------- prediction ----------
  function hitRate(stats, type) {
    const st = stats[type];
    const prior = PATTERNS[type].kind === 'candle' ? 0.52 : 0.54;
    return (st.hits + prior * PRIOR_N) / (st.n + PRIOR_N);
  }

  function predict(ctx, i, active, stats, interval) {
    const C = ctx.C;
    let z = 0;
    const drivers = [];
    for (const s of active) {
      if (!s.bias) continue;
      const rel = hitRate(stats, s.type);
      const w = Math.max(0, logit(rel)) * s.quality;
      if (w > 0) { z += s.bias * w; drivers.push({ type: s.type, bias: s.bias, weight: w, rel, quality: s.quality }); }
    }
    z = Math.max(-MAX_Z, Math.min(MAX_Z, z));
    const p = 1 / (1 + Math.exp(-z));
    let sumAbs = 0, sum = 0, sumSq = 0, m = 0, uw = 0, lw = 0;
    for (let j = Math.max(1, i - 99); j <= i; j++) {
      const d = C[j].c - C[j - 1].c;
      sumAbs += Math.abs(d); sum += d; sumSq += d * d; m++;
      uw += upW(C[j]); lw += loW(C[j]);
    }
    const mad = sumAbs / m, sd = Math.sqrt(Math.max(0, sumSq / m - (sum / m) ** 2));
    const o = C[i].c, close = o + (2 * p - 1) * mad;
    const signal = drivers.length > 0;
    return {
      signal, p, z,
      dir: signal ? Math.sign(p - 0.5) : 0,
      confidence: Math.max(p, 1 - p),
      base: o, close, low: close - sd, high: close + sd, sd, mad,
      forTime: C[i].t + interval, fromTime: C[i].t,
      ghost: { o, c: close, h: Math.max(o, close) + uw / m, l: Math.min(o, close) - lw / m },
      drivers: drivers.sort((a, b) => b.weight - a.weight),
    };
  }

  // ---------- full walk-forward pass ----------
  function analyze(C, opts) {
    opts = opts || {};
    const enabled = opts.enabled || (() => true);
    const interval = opts.interval || 300;
    const n = C.length;
    const atr = computeATR(C), vavg = computeVolAvg(C), piv = computePivots(C, PIVOT_K);
    const ctx = { C, atr, vavg };
    const stats = {};
    for (const t in PATTERNS) stats[t] = { n: 0, hits: 0, seen: 0 };
    const seen = new Set();
    const wf = { bars: 0, called: 0, hits: 0, err: 0, naiveErr: 0 };
    const candleMarks = [];
    const chartRecent = new Map();
    let hS = 0, hE = 0, lS = 0, lE = 0;
    let lastSigs = [], prediction = null;
    const zSeries = opts.collect ? [] : null; // [forTime, pattern z] for every bar (used by the tuner)
    const first = 30;
    for (let i = first; i < n; i++) {
      while (hE < piv.highs.length && piv.highs[hE].i + PIVOT_K <= i) hE++;
      while (lE < piv.lows.length && piv.lows[lE].i + PIVOT_K <= i) lE++;
      while (hS < hE && piv.highs[hS].i < i - PIVOT_WINDOW) hS++;
      while (lS < lE && piv.lows[lS].i < i - PIVOT_WINDOW) lS++;
      const known = { H: piv.highs.slice(hS, hE), L: piv.lows.slice(lS, lE) };
      const sigs = detectCandles(ctx, i).concat(detectChart(ctx, i, known));
      const active = sigs.filter((s) => enabled(s.type));
      const pred = predict(ctx, i, active, stats, interval);
      if (zSeries) zSeries.push([pred.forTime, pred.z]);
      if (i < n - 1) {
        const d = C[i + 1].c - C[i].c, actual = Math.sign(d);
        wf.bars++;
        if (pred.signal) {
          wf.called++;
          if (pred.dir === actual) wf.hits++;
          wf.err += Math.abs(pred.close - C[i + 1].c);
          wf.naiveErr += Math.abs(d);
        }
        for (const s of sigs) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          stats[s.type].seen++;
          if (s.bias) { stats[s.type].n++; if (actual === s.bias) stats[s.type].hits++; }
        }
      }
      for (const s of sigs) {
        if (s.kind === 'candle') { if (i >= n - 400) candleMarks.push(s); }
        else chartRecent.set(s.key, { s, lastI: i });
      }
      if (i === n - 1) { lastSigs = sigs; prediction = pred; }
    }
    // One drawing per chart-pattern type: the most recent instance, if seen in the last 36 bars
    const byType = new Map();
    for (const { s, lastI } of chartRecent.values()) {
      if (lastI < n - 1 - 36) continue;
      const cur = byType.get(s.type);
      if (!cur || lastI > cur.lastI || (lastI === cur.lastI && s.quality > cur.s.quality)) byType.set(s.type, { s, lastI });
    }
    const chartDrawings = [...byType.values()].map(({ s, lastI }) => Object.assign({}, s, { active: lastI === n - 1, lastT: C[lastI].t }));
    const rates = {};
    for (const t in PATTERNS) rates[t] = { n: stats[t].n, hits: stats[t].hits, seen: stats[t].seen, rate: stats[t].n ? stats[t].hits / stats[t].n : null, shrunk: hitRate(stats, t) };
    return {
      stats: rates, wf, candleMarks, chartDrawings, prediction,
      active: lastSigs, n, firstTime: C[0].t, lastTime: C[n - 1].t, zSeries,
    };
  }

  // ---------- Polymarket-style window odds ----------
  // P(Up) for a 5-minute "Up or Down" window: will the settlement price be >= the start price K?
  // Price is modelled as driftless Brownian motion in dollars with volatility sigma ($ per sqrt-second).
  //   mode 'spot'  : settles on the spot price at the end of the window
  //   mode 'end60' : settles on a 60-second TWAP ending at the window close
  //   mode 'full'  : settles on the TWAP over the whole window
  function normCdf(x) {
    // Abramowitz–Stegun 7.1.26 (|err| < 1.5e-7)
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }

  function windowUpProb(o) {
    const W = o.W || 300, e = Math.max(0, Math.min(W, o.elapsed || 0)), tau = W - e;
    const sig = Math.max(o.sigma, 1e-9);
    let mean, sd;
    if (o.mode === 'full') {
      const avg = e > 0 && o.avgSoFar != null ? o.avgSoFar : o.S;
      mean = (e * avg + o.S * tau) / W;
      sd = sig * Math.pow(tau, 1.5) / (Math.sqrt(3) * W);
    } else if (o.mode === 'end60') {
      const A = 60;
      if (tau > A) { mean = o.S; sd = sig * Math.sqrt(tau - A + A / 3); }
      else {
        const avg = o.avgLast60 != null ? o.avgLast60 : o.S;
        mean = ((A - tau) * avg + o.S * tau) / A;
        sd = sig * Math.pow(tau, 1.5) / (Math.sqrt(3) * A);
      }
    } else { mean = o.S; sd = sig * Math.sqrt(tau); }
    if (sd < 1e-9) return mean >= o.K ? 1 : 0;
    return normCdf((mean - o.K) / sd);
  }

  // Parkinson volatility from high/low of the last n closed candles, in $ per sqrt-second
  function parkinsonSigma(C, i, n, interval) {
    let s = 0, m = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { const r = C[j].h - C[j].l; s += r * r; m++; }
    return m ? Math.sqrt(s / m / (4 * Math.LN2) / (interval || 300)) : NaN;
  }

  // Velocity: net move over the last n closed candles in units of expected move (z-score)
  function velocity(C, i, n, sigma, interval) {
    if (i - n < 0 || !(sigma > 0)) return 0;
    return (C[i].c - C[i - n].c) / (sigma * Math.sqrt(n * (interval || 300)));
  }

  const DEFAULT_WINDOW_PARAMS = { mode: 'full', volBars: 12, volScale: 1, beta: 1, gamma: 0, velBars: 3 };

  // Combined probability: volatility/distance model + pattern lean + velocity term
  function combineWindow(pVol, patternZ, vel, params) {
    const pc = Math.min(1 - 1e-6, Math.max(1e-6, pVol));
    const z = logit(pc) + (params.beta || 0) * (patternZ || 0) + (params.gamma || 0) * (vel || 0);
    return 1 / (1 + Math.exp(-z));
  }

  return { PATTERNS, analyze, computeATR, computePivots, normCdf, windowUpProb, parkinsonSigma, velocity, combineWindow, DEFAULT_WINDOW_PARAMS };
});

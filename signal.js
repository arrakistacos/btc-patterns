/*
 * BUY / WAIT decision, shared by the web app (app.js) and the phone-alert bot (tools/signal-bot.mjs)
 * so both always make exactly the same call.
 *
 * BUY only when ALL hold: the gap from the start price has reached the target confidence on the side
 * Polymarket favors · price under 95¢ · both the live model AND history beat the price + fee by 2+ points.
 * (Feed health and the 0:40–4:30 time window are checked by the caller.)
 * Size: ¼ Kelly on the lower of the two win chances, kept between 1% and 2% of bankroll.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Signal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One-sided normal quantiles: gap ≥ Z × σ(time left) ⇒ that confidence
  const Z_FOR = { 60: 0.2533, 65: 0.3853, 70: 0.5244, 75: 0.6745, 80: 0.8416, 85: 1.0364, 90: 1.2816, 95: 1.6449 };
  const TARGETS = [60, 65, 70, 75, 80, 85, 90, 95];
  const MARGIN = 0.02, MIN_F = 0.01, MAX_F = 0.02, MAX_PRICE = 0.95;
  const START_SEC = 40, END_SEC = 270;
  const fee = (p) => 0.07 * p * (1 - p);   // Polymarket taker fee per share on crypto markets

  // Historical win rate for buying the favorite at this minute, price bucket and signal agreement
  function histCell(edge, elapsed, favMid, agree) {
    const cp = Math.round(elapsed / 60) * 60;
    if (!edge || !edge.checkpoints || !edge.checkpoints[cp]) return null;
    const C = edge.checkpoints[cp];
    const b = C.byBucket.find((x) => favMid >= x.lo && favMid < x.hi) || C.byBucket[C.byBucket.length - 1];
    let cell = agree ? b.agree : b.all;
    if (!cell || !cell.n || cell.n < 20) cell = agree ? C.agree : C.all;
    return cell || null;
  }

  // x = { w: { S, K, sigma, left }, favUp, ask, cost, oursFav, hist }
  // Returns { buy:false, why, sub } or { buy:true, q, f }
  function evalSignal(x, tgt) {
    const { w, favUp, ask, cost, oursFav, hist } = x;
    const side = favUp ? 'UP' : 'DOWN';
    const d = w.S - w.K, sigLeft = w.sigma * Math.sqrt(Math.max(1, w.left));
    const need = (Z_FOR[tgt] || Z_FOR[80]) * sigLeft;
    if (Math.abs(d) < need) return { buy: false, code: 'gap', why: `Gap not safe yet · needs $${(need - Math.abs(d)).toFixed(0)} more`, sub: `${tgt}% target` };
    if ((d >= 0) !== favUp) return { buy: false, code: 'disagree', why: 'Market disagrees with the gap', sub: `Gap says ${d >= 0 ? 'UP' : 'DOWN'}, Polymarket favors ${side} · likely a start-price difference` };
    if (ask >= MAX_PRICE) return { buy: false, code: 'thin', why: `Price too high · ${side} costs ${Math.round(ask * 100)}¢`, sub: 'Payoff too small for the risk' };
    if (!hist || hist.n < 20) return { buy: false, code: 'nohist', why: 'Not enough history at this price', sub: '' };
    const q = Math.min(oursFav, hist.winRate);
    if (q < cost + MARGIN) return { buy: false, code: 'price', why: `Price too high · ${Math.round(ask * 100)}¢ for a ${Math.round(q * 100)}% chance`, sub: `Needs ${Math.round((cost + MARGIN) * 100)}%+ to be worth it` };
    return { buy: true, q, f: Math.min(MAX_F, Math.max(MIN_F, 0.25 * (q - cost) / (1 - cost))) };
  }

  // Whole shares you can buy with fraction f of the bankroll at this all-in cost
  function sizeBet(bankroll, f, cost) {
    if (!(bankroll > 0)) return null;
    const shares = Math.floor((bankroll * f) / cost);
    return { shares, spend: shares * cost, profitIfWin: shares - shares * cost };
  }

  return { Z_FOR, TARGETS, MARGIN, MIN_F, MAX_F, MAX_PRICE, START_SEC, END_SEC, fee, histCell, evalSignal, sizeBet };
});

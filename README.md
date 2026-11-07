# BTC Pattern Watch

Live Bitcoin (BTC/USD) 5-minute candlestick chart that automatically finds classic chart patterns, scores them, and predicts the next candle.

**Live app:** https://arrakistacos.github.io/btc-patterns/

## What it does

- **Live red/green candles** streamed straight from the exchange into your browser — no server, no API key.
- **26 classic patterns**, each switchable on/off:
  - *Candlestick:* Bullish/Bearish Engulfing, Hammer, Inverted Hammer, Shooting Star, Hanging Man, Morning/Evening Star, Three White Soldiers, Three Black Crows, Bullish/Bearish Harami, Piercing Line, Dark Cloud Cover, Doji.
  - *Chart:* Double Top/Bottom, Head & Shoulders (+ inverse), Ascending/Descending/Symmetrical Triangle, Rising/Falling Wedge, Bull/Bear Flag.
- **Support & resistance levels** (toggle + minimum touches 2–6): horizontal levels that swing highs or lows have touched N+ times with no candle closing through since. Each line shows its touch count on the price axis, with a dot at every touch.
- **Pattern confidence** (0–100%): how textbook the shape is — swing/trendline fit, size vs ATR, the trend leading in, volume, and breakout confirmation.
- **Hit rate** per pattern, measured walk-forward on ~4 days of history: when it appeared, did the next candle close its way?
- **Next-candle prediction**: direction with confidence, predicted close, and a 68% range, drawn on the chart as a hollow "ghost" candle with dashed price lines.
- **Honest scoreboard**: walk-forward accuracy of the combined prediction, average miss vs a "no change" guess, and a live tally kept in your browser.

Patterns are evaluated on **closed candles only**, so nothing repaints.

## How it stays live

1. Loads ~1,200 candles of history over REST.
2. Streams trades over a WebSocket and builds the forming candle tick by tick.
3. Re-syncs from REST every 60 s (every 8 s if the socket is down), on tab focus, and after any gap.
4. Reconnects with backoff if the socket goes quiet for 25 s.
5. Fails over **Coinbase → Binance.US → Kraken** automatically (or pick one in the Source menu).

## Calibration against Polymarket

The **This window vs Polymarket** card shows our live P(Up) for the current 5-minute window next to Polymarket's live odds for its "Bitcoin Up or Down" market. The odds come from Polymarket's public market WebSocket, with a REST fallback.

The window model is: P(Up) = Φ((price − start price) / (σ·√time left)). σ is recent volatility (Parkinson high/low estimator), and the result is shifted in log-odds by the pattern lean and a velocity term. Its parameters live in `params.json`, tuned by:

```bash
node tools/backfill.mjs 4   # resolved 5m markets + minute odds + Coinbase candles → data/backfill.json
node tools/tune.mjs         # grid search; test = last 30% of windows → params.json + data/calibration.json
```

Results are at **[calibration.html](https://arrakistacos.github.io/btc-patterns/calibration.html)**. A GitHub Action (`.github/workflows/recalibrate.yml`) re-runs both every night and commits the new parameters.

### Edge check

Inside the window card, the **edge check** looks at buying the current favorite. It compares the live ask plus Polymarket's taker fee (`0.07 × p × (1 − p)` per share) against how often favorites at that price and minute actually won in the backfill. It counts three signals: our model at least as confident as the market, last-minute momentum, and 5-minute velocity. The history comes from `data/edge.json`, which `tools/tune.mjs` rebuilds nightly.

- **Green:** even the low end of the 95% range beats break-even.
- **Amber:** the average beats break-even but the range doesn't.
- **Grey:** no edge.

A paper trade is logged the first time all three signals agree between 1:40 and 3:20. It is resolved from Polymarket's result, so the app forward-tests itself in your browser.

Known gap: Polymarket's "price to beat" is the Chainlink price at the window open. That price is only streamed to authenticated API users, so the app uses Coinbase's price instead, which can differ by a few dollars.

### Second-by-second recorder (e.g. Raspberry Pi)

```bash
node tools/record.mjs                      # Node 22+; appends to data/recordings/YYYY-MM-DD.jsonl
# keep it running: pm2 start tools/record.mjs --name btc-recorder   (or a systemd service)
```

It logs the Coinbase price and Polymarket's bid/ask for the current window every second. This is finer data than the minute-level backfill, for tuning the last minute of each window.

## Files

- `index.html` — layout and styles
- `app.js` — data feed, chart rendering, UI
- `engine.js` — pattern detection, scoring, walk-forward hit rates, prediction (pure JS, also runs in Node)
- `calibration.html` — model vs Polymarket report
- `params.json` — tuned window-model parameters (rewritten nightly)
- `tools/backfill.mjs`, `tools/tune.mjs`, `tools/record.mjs` — data collection and tuning (Node 22+)
- `vendor/` — TradingView Lightweight Charts v4.2.3 (Apache-2.0)

Educational tool, not financial advice.

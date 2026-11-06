# BTC Pattern Watch

Live Bitcoin (BTC/USD) 5-minute candlestick chart that automatically finds classic chart patterns, scores them, and predicts the next candle.

**Live app:** https://arrakistacos.github.io/btc-patterns/

## What it does

- **Live red/green candles** streamed straight from the exchange into your browser — no server, no API key.
- **26 classic patterns**, each switchable on/off:
  - *Candlestick:* Bullish/Bearish Engulfing, Hammer, Inverted Hammer, Shooting Star, Hanging Man, Morning/Evening Star, Three White Soldiers, Three Black Crows, Bullish/Bearish Harami, Piercing Line, Dark Cloud Cover, Doji.
  - *Chart:* Double Top/Bottom, Head & Shoulders (+ inverse), Ascending/Descending/Symmetrical Triangle, Rising/Falling Wedge, Bull/Bear Flag.
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

## Files

- `index.html` — layout and styles
- `app.js` — data feed, chart rendering, UI
- `engine.js` — pattern detection, scoring, walk-forward hit rates, prediction (pure JS, also runs in Node)
- `vendor/` — TradingView Lightweight Charts v4.2.3 (Apache-2.0)

Educational tool, not financial advice.

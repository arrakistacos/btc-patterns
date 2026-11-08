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

The **health monitor** in the header shows each feed (Coinbase price, Polymarket odds) with a dot and the seconds since its last new data. A dot turns **red after 5 seconds** without data, and the app then re-syncs and reconnects on its own.

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

The calibration page has a **Calibrate now** button. It runs the same backfill and tuning in your browser using the shared `calib.js` (4 or 7 days of history, about 1–2 minutes) and applies the result to the chart in that browser. A link there starts the GitHub Action, which updates the site for every device.

Results are at **[calibration.html](https://arrakistacos.github.io/btc-patterns/calibration.html)**. A GitHub Action (`.github/workflows/recalibrate.yml`) re-runs both every night and commits the new parameters.

### Model settings

Sliders set the **volatility lookback** (1–48 five-minute candles), the **velocity lookback** (1–12 candles) and a **volatility multiplier** (0.5–2×). Each slider shows the tuned value, and a **Reset to tuned** button restores them. Your settings are saved in the browser.

A live readout shows the typical move per minute and over the time left. It also shows the **gap needed for 95% certainty** next to the current gap, plus velocity.

### BUY / WAIT signal

A banner above the chart shows **WAIT** (yellow, with the reason) or **BUY NOW** (green). BUY NOW shows the side, the exact dollar amount and share count for your bankroll, the chance to win, and what you'd win or lose. It turns green only when **all** of these hold:

1. Both data feeds are healthy (no red dots).
2. It is between 0:40 and 4:30 into the window.
3. The gap from the start price has reached the target confidence (default 80%).
4. That side is also Polymarket's favorite.
5. The price is under 95¢.
6. **Both** our live model and the historical win rate beat the price plus fee by at least 2 points.

The bet is ¼ Kelly on the lower of those two win chances, kept between **1% and 2%** of the bankroll. The target confidence is selectable from 60% to 95% (default 80%).

**Which target works best?** For every target at once, the app paper-trades the first BUY signal each target would have given in each window. It scores each one against Polymarket's real result and shows a scoreboard (trades, win rate, profit per $100). It records only while the page is open and is stored in that browser.

### Edge check

Inside the window card, the **edge check** looks at buying the current favorite. It compares the live ask plus Polymarket's taker fee (`0.07 × p × (1 − p)` per share) against how often favorites at that price and minute actually won in the backfill. It counts three signals: our model at least as confident as the market, last-minute momentum, and 5-minute velocity. The history comes from `data/edge.json`, which `tools/tune.mjs` rebuilds nightly.

- **Green:** even the low end of the 95% range beats break-even.
- **Amber:** the average beats break-even but the range doesn't.
- **Grey:** no edge.

A paper trade is logged the first time all three signals agree between 1:40 and 3:20. It is resolved from Polymarket's result, so the app forward-tests itself in your browser.

Known gap: Polymarket's "price to beat" is the Chainlink price at the window open. That price is only streamed to authenticated API users, so the app uses Coinbase's price instead, which can differ by a few dollars.

### Bet sizing

Enter a bankroll in the edge check to get a suggested bet as a percentage of the bankroll, a dollar amount, and a share count, plus what you'd lose or win. Sizing uses the Kelly formula for a binary contract: f = (q − c) / (1 − c). Here q is the win chance from history and c is the ask plus the fee.

Defaults are deliberately conservative:
- **Cautious** uses the low end of the historical range, so it suggests $0 unless the edge is proven.
- **¼ Kelly**, with a **2% cap** per bet.

You can switch to Average, ½ or Full Kelly, and 1–5% caps in Model settings. The bankroll is stored only in your browser.

### Second-by-second recorder (e.g. Raspberry Pi)

```bash
node tools/record.mjs                      # Node 22+; appends to data/recordings/YYYY-MM-DD.jsonl
# keep it running: pm2 start tools/record.mjs --name btc-recorder   (or a systemd service)
```

It logs the Coinbase price and Polymarket's bid/ask for the current window every second. This is finer data than the minute-level backfill, for tuning the last minute of each window.

## Phone alerts

A web page can't reliably ring a locked phone: phones pause a page's code soon after the screen turns off. So there are two kinds of alerts:

### 1. Signal bot → ntfy push (works with the phone locked)

`tools/signal-bot.mjs` runs 24/7 on an always-on machine, such as a Raspberry Pi. It watches the same feeds and makes **exactly the same BUY / WAIT decision** as the app, through the shared `signal.js` and `engine.js`. When BUY NOW fires, it sends an urgent push through [ntfy](https://ntfy.sh), a free iPhone/Android app with a loud alert. That's one alert per 5-minute window, so a flickering signal doesn't spam you. Tapping the alert opens that window's Polymarket market.

**Phone:** install **ntfy** (App Store / Google Play) → **+** → subscribe to your topic. Pick a long random name: anyone who knows it can read the alerts. On Android, long-press the topic → *Notification settings* → **Max priority** so it sounds even on Do Not Disturb.

**Windows laptop (one line):** open PowerShell with *Run as administrator* and paste:
```powershell
irm https://raw.githubusercontent.com/arrakistacos/btc-patterns/main/tools/install-windows.ps1 -OutFile $env:TEMP\btc-bot.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-bot.ps1 -Topic your-topic -Target 80 -Bankroll 1000
```
The installer does the following:
- installs Node.js if needed
- copies the bot to `%USERPROFILE%\dev\btc-patterns-bot`
- sets it to start hidden at logon and restart itself if it stops
- stops the laptop sleeping while plugged in, including with the lid closed (skip with `-KeepAwake:$false`)
- sends a test alert

Run it again to update the bot or change settings; `-Uninstall` removes it. To watch the log: `Get-Content $env:USERPROFILE\dev\btc-patterns-bot\signal-bot.log -Wait -Tail 20 -Encoding UTF8`.

**Raspberry Pi (Node 22+):**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git
git clone https://github.com/arrakistacos/btc-patterns && cd btc-patterns
NTFY_TOPIC=your-topic node tools/signal-bot.mjs --test     # phone should ring
NTFY_TOPIC=your-topic TARGET=80 BANKROLL=1000 node tools/signal-bot.mjs   # try it in the foreground
```
To keep it running across reboots, edit `tools/signal-bot.service` (user, folder, topic, target, bankroll), then:
```bash
sudo cp tools/signal-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now signal-bot
journalctl -u signal-bot -f      # watch its log
git pull && sudo systemctl restart signal-bot   # update later
```
It re-reads the tuned settings from the site every 30 minutes. If price data stops for over a minute, it sends a warning push, then an "all clear" when data returns.

### 2. In-browser alerts (page open)

The **🔔 Alerts** button in the signal banner beeps, vibrates (Android) and shows a system notification on each new BUY NOW, at most once per 20 seconds. It keeps working in a background tab on a computer. On phones it works only while the page is on screen, and on iPhone only from a Home Screen web app. Browsers need one tap after each page load before they allow sound, so the button shows "Tap to arm".

## Files

- `index.html` — layout and styles
- `app.js` — data feed, chart rendering, UI
- `engine.js` — pattern detection, scoring, walk-forward hit rates, prediction (pure JS, also runs in Node)
- `calibration.html` — model vs Polymarket report
- `params.json` — tuned window-model parameters (rewritten nightly)
- `signal.js` — the BUY / WAIT decision, shared by the app and the signal bot
- `sw.js` — tiny service worker so the page can show system notifications
- `tools/signal-bot.mjs` — 24/7 phone-alert bot (ntfy); `tools/install-windows.ps1` (Windows) and `tools/signal-bot.service` (Linux/Pi) keep it running
- `tools/backfill.mjs`, `tools/tune.mjs`, `tools/record.mjs` — data collection and tuning (Node 22+)
- `vendor/` — TradingView Lightweight Charts v4.2.3 (Apache-2.0)

Educational tool, not financial advice.

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

**Training uses Polymarket US data.** For every window, the backfill reads the official **price to beat** and **settlement price** from Polymarket US. The model is trained with that official start price, scored on the US result (settlement ≥ price to beat), and priced with the 60-second-average close that US uses. Polymarket's minute odds still come from polymarket.com, the only public odds history; those odds track the US market closely. If US data is unavailable, training falls back to polymarket.com results. Each run also scores the settings that were live before it on the same held-out windows and shows both on the calibration page.

The calibration page has a **Calibrate now** button. It runs the same backfill and tuning in your browser using the shared `calib.js` (4 or 7 days of history, about 1–2 minutes) and applies the result to the chart in that browser. A link there starts the GitHub Action, which updates the site for every device.

Results are at **[calibration.html](https://arrakistacos.github.io/btc-patterns/calibration.html)**. A GitHub Action (`.github/workflows/recalibrate.yml`) re-runs both **twice a day** (about 3:17 AM and 3:17 PM Central) and commits the new parameters. The site and the signal bot pick them up automatically; the bot re-reads them every 30 minutes.

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

The edge history is scored on **Polymarket US results**, the market you actually trade.

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

## Price to beat (Polymarket US)

Polymarket US's 5-minute BTC markets settle on the **CF Benchmarks BRTI** index. The start and end values are each the average of 60 BRTI prices in the minute before that time. The app and the bot read each window's official **price to beat** from Polymarket US's public event API (`signal.js` → `fetchUsTerms`). They price the window as a 60-second average at the close, and **never show or send BUY until the official price is in**, which takes a few seconds into each window. Until then, the app shows a Coinbase estimate marked *est.*

## Phone alerts

A web page can't reliably ring a locked phone: phones pause a page's code soon after the screen turns off. So there are two kinds of alerts:

### 1. Signal bot → ntfy push (works with the phone locked)

`tools/signal-bot.mjs` runs 24/7 on an always-on machine, such as a Raspberry Pi. It watches the same feeds and makes **exactly the same BUY / WAIT decision** as the app, through the shared `signal.js` and `engine.js`. When BUY NOW fires **and** both the model's win chance and Polymarket's odds for that side are at least 80% (`MIN_MODEL` / `MIN_MARKET`, installer `-MinModel` / `-MinMarket`), it sends an urgent push through [ntfy](https://ntfy.sh), a free iPhone/Android app with a loud alert. Each alert is just **🟢 BUY UP** or **🔴 BUY DOWN** with `MODEL x% · POLYMARKET y%`. That's one alert per 5-minute window, so a flickering signal doesn't spam you. Tapping the alert opens that window's market on Polymarket US (`polymarket.us/event/btc-updown-5m-YYYY-MM-DD-HHMMz`, start time in UTC), since polymarket.com blocks trading from the US.

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

### Autopilot: trade the alerts automatically

The signal bot can buy each BUY alert on **Polymarket US** for you, through Polymarket's official API (`tools/autopilot.mjs`). You control and watch it on the **[autopilot page](https://arrakistacos.github.io/btc-patterns/autopilot.html)**.

**How it trades:**
- It trades only when the bot sends a BUY alert, at most once per 5-minute window.
- It reads the live Polymarket US order book and buys the favored side with an **immediate-or-cancel limit order**, at most 1¢ above the best price. It buys only if the model's win chance still beats that price plus Polymarket's fee by 2 points, and the price is under 95¢. "Down" is placed the way Polymarket US requires: buying NO, priced as the YES price.
- **Bet size is a fixed % of the balance: 20% by default**, changeable on the page.
- **Practice mode (the default)** uses the real order book and real results with pretend money; no key is needed. **Live mode** places real orders and needs your API key.
- Every trade is followed to settlement and scored: win rate, profit today and all-time, and a daily table.

**Losing streak pause:** after **2 losses in a row** it pauses for **1 hour**, sends a push, then resumes on its own, and the count starts over. Both numbers are adjustable on the page (0 = never pause), and **Resume** ends a pause early.

**Goal:** set a dollar goal on the page. When the current mode's balance reaches it (practice balance, or your Polymarket US cash once no trades are open), it sends a "GOAL REACHED" push and pauses until you tap **Resume**. Each goal fires once; set a higher one to be told again. 0 turns it off.

**It halts itself and sends an urgent push when:**
- the money runs out: Polymarket US buying power under $1, checked every minute and before every order, or an order refused for insufficient funds;
- the daily loss limit is hit (default 50% of the day's starting balance); it resumes the next day;
- Polymarket rejects the API key.

Tap **Resume** on the page once it's fixed. **Turn off** on the page stops all new trades immediately.

**Which settings work best:** in every window, the bot checks all 80 combinations of gap target (60/70/80/90%), model minimum (off/80/85/90%) and Polymarket minimum (off/70/80/85/90%). It records the first BUY each would make, scores it on the Polymarket US result at Polymarket's price plus the US fee, and the autopilot page ranks them by profit per $100. **Use** switches the bot to that combination. It runs 24/7 with no page open and keeps 30 days in `scoreboard.json`; rankings mean little until rows have about 100 trades.

**Late coin-flip test (practice only):** with 75–30 seconds left in a close window (favorite priced 50–70¢), the bot paper-buys the side our model gives at least 60%, at the live Polymarket US price, $10 a trade, and scores it on the US result. In a backtest this won 65% at about 54¢, but those minute-by-minute prices may have lagged; this checks the idea against real prices. Results are on the autopilot page. **Trade this for real** (off by default, asks to confirm) places real orders of a fixed dollar amount ($5 to start) while autopilot is Live and on. These count toward your balance, stops, 2-loss pause and goal, and are skipped if a normal trade already happened in that window.

**Phone notifications:** each trade placed and each win or loss (both can be turned off), plus halts and switching to live.

**Setup (Windows):** create an API key at [polymarket.us/developer](https://polymarket.us/developer). It needs your verified Polymarket US account; the secret is shown only once. Then re-run the installer with `-Autopilot`:
```powershell
irm https://raw.githubusercontent.com/arrakistacos/btc-patterns/main/tools/install-windows.ps1 -OutFile $env:TEMP\btc-bot.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\btc-bot.ps1 -Topic your-topic -Autopilot
```
It asks for the Key ID, the secret and a password for the autopilot page. It saves them in `polymarket.env` next to the bot, readable only by your Windows account, and checks the key. On a Pi, create that file yourself with `PM_KEY_ID=…`, `PM_SECRET_KEY=…` and `AUTOPILOT_PASSWORD=…` lines. Check a key any time with `node tools/signal-bot.mjs --check-autopilot`.

**How the page connects:** your Polymarket key never leaves the laptop. The bot publishes its status to the ntfy topic `<your-topic>-ap`, encrypted (AES-256-GCM) with a key derived from your autopilot password. The page sends commands to `<your-topic>-apc`, each signed (HMAC-SHA256) and valid for 2 minutes. Anyone who learns the topic sees only scrambled text and can't send commands. Log in with your topic and password. Status refreshes about every 20 minutes and right after any change, which keeps well inside ntfy.sh's free limit of 250 messages a day. Settings and history are saved in `autopilot-state.json` next to the bot.

### 2. In-browser alerts (page open)

The **🔔 Alerts** button in the signal banner beeps, vibrates (Android) and shows a system notification on each new BUY NOW, at most once per 20 seconds. It keeps working in a background tab on a computer. On phones it works only while the page is on screen, and on iPhone only from a Home Screen web app. Browsers need one tap after each page load before they allow sound, so the button shows "Tap to arm".

## Files

- `index.html` — layout and styles
- `app.js` — data feed, chart rendering, UI
- `engine.js` — pattern detection, scoring, walk-forward hit rates, prediction (pure JS, also runs in Node)
- `calibration.html` — model vs Polymarket report
- `params.json` — tuned window-model parameters (rewritten twice a day)
- `signal.js` — the BUY / WAIT decision, shared by the app and the signal bot
- `autopilot.html` — autopilot control page; `apcrypto.js` — its encrypted link to the bot; `tools/autopilot.mjs` — the trading module inside the bot
- `sw.js` — tiny service worker so the page can show system notifications
- `tools/signal-bot.mjs` — 24/7 phone-alert bot (ntfy); `tools/install-windows.ps1` (Windows) and `tools/signal-bot.service` (Linux/Pi) keep it running
- `tools/backfill.mjs`, `tools/tune.mjs`, `tools/record.mjs` — data collection and tuning (Node 22+)
- `vendor/` — TradingView Lightweight Charts v4.2.3 (Apache-2.0)

Educational tool, not financial advice.

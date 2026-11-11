#!/bin/bash
# BTC Pattern Watch bot on a Raspberry Pi (64-bit Raspberry Pi OS / Debian 12). Run by tools/install-pi.ps1 from the
# laptop over SSH; safe to re-run (it updates the code and keeps the bot's state).
#   bash pi-setup.sh --topic T [--target 80] [--min-model 80] [--min-market 80] [--bankroll 0]
#                    --unlock-key 'ssh-ed25519 AAAA...'   (the laptop's restricted key: may only run pi-unlock.mjs)
#                    [--state]   (move the laptop's state files from ~/btc-incoming-*.json into the bot folder)
# Secrets are never written here: the service starts locked and the laptop unlocks it over SSH.
set -euo pipefail
TOPIC=''; TARGET=80; MINMODEL=80; MINMARKET=80; BANKROLL=0; UNLOCK_KEY=''; STATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --topic) TOPIC="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --min-model) MINMODEL="$2"; shift 2 ;;
    --min-market) MINMARKET="$2"; shift 2 ;;
    --bankroll) BANKROLL="$2"; shift 2 ;;
    --unlock-key) UNLOCK_KEY="$2"; shift 2 ;;
    --state) STATE=1; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
[[ "$TOPIC" =~ ^[A-Za-z0-9_-]{8,64}$ ]] || { echo 'ERROR: --topic must be your ntfy topic (8-64 letters, digits, - or _)'; exit 1; }
for v in "$TARGET" "$MINMODEL" "$MINMARKET"; do [[ "$v" =~ ^[0-9]{2}$ ]] || { echo "ERROR: bad number $v"; exit 1; }; done
[[ "$BANKROLL" =~ ^[0-9.]+$ ]] || { echo 'ERROR: bad bankroll'; exit 1; }
[[ "$UNLOCK_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+$ ]] || { echo 'ERROR: --unlock-key must be an ssh-ed25519 public key'; exit 1; }
USER_NAME=$(id -un); DIR="$HOME/btc-bot"
say() { echo -e "\033[36m$*\033[0m"; }

# 1) Node.js 22+
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say 'Installing Node.js 22...'
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E DEBIAN_FRONTEND=noninteractive bash - >/dev/null 2>&1
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null 2>&1
fi
NODE=$(command -v node); say "Node.js $($NODE --version) at $NODE"

# 2) Latest code from GitHub
say 'Downloading the latest code...'
mkdir -p "$DIR/tools"; chmod 700 "$DIR"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL https://github.com/arrakistacos/btc-patterns/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP"
SRC="$TMP/btc-patterns-main"
for f in engine.js signal.js apcrypto.js tools/signal-bot.mjs tools/autopilot.mjs tools/pi-launcher.mjs tools/pi-unlock.mjs; do install -m 644 "$SRC/$f" "$DIR/$f"; done

# 3) State carried over from the laptop (first move only; copied to ~/btc-incoming-*.json just before this runs):
#    trades, ledger, settings, scoreboard
if [ "$STATE" = 1 ]; then
  n=0
  for f in "$HOME"/btc-incoming-*.json; do
    [ -e "$f" ] || continue
    name=$(basename "$f"); name=${name#btc-incoming-}
    [[ "$name" =~ ^[a-z-]+\.json$ ]] && mv -f "$f" "$DIR/$name" && chmod 600 "$DIR/$name" && n=$((n+1))
  done
  say "Copied $n state file(s) from the laptop"
fi
rm -f "$DIR/polymarket.env"   # never kept on the Pi

# 4) The laptop's restricted key: it can only run the unlock helper (no shell, no forwarding)
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"
grep -v ' btc-bot-unlock$' "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.new" || true
echo "command=\"$NODE $DIR/tools/pi-unlock.mjs\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $UNLOCK_KEY btc-bot-unlock" >> "$HOME/.ssh/authorized_keys.new"
mv "$HOME/.ssh/authorized_keys.new" "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"

# 5) Service: starts at boot, restarts if it stops, starts LOCKED. Secrets stay in its memory only: no swap,
#    no core dumps, and it can't write anywhere but its own folder.
say 'Installing the btc-bot service...'
sudo tee /etc/systemd/system/btc-bot.service >/dev/null <<UNIT
[Unit]
Description=BTC Pattern Watch bot (locked until the laptop unlocks it)
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR
Environment=NTFY_TOPIC=$TOPIC
Environment=TARGET=$TARGET
Environment=MIN_MODEL=$MINMODEL
Environment=MIN_MARKET=$MINMARKET
Environment=BANKROLL=$BANKROLL
Environment=TZ_NAME=America/Chicago
Environment=LOG_FILE=$DIR/signal-bot.log
Environment=UNLOCK_SOCKET=/run/btc-bot/unlock.sock
ExecStart=$NODE tools/pi-launcher.mjs
Restart=always
RestartSec=10
RuntimeDirectory=btc-bot
RuntimeDirectoryMode=0700
MemorySwapMax=0
LimitCORE=0
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable btc-bot >/dev/null 2>&1
sudo systemctl restart btc-bot
sleep 2
if systemctl is-active --quiet btc-bot; then say 'btc-bot service is running (locked until the laptop unlocks it).'; else echo 'ERROR: the btc-bot service did not start:'; sudo systemctl status btc-bot --no-pager | tail -15; exit 1; fi

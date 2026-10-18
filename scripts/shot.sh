#!/bin/bash
# usage: scripts/shot.sh <url> <out.png> [width] [height] [scheme: light|dark]
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W=${3:-1360}; H=${4:-900}; SCHEME=${5:-light}
P=$(mktemp -d /tmp/chrome-prof-XXXX)
FLAGS=(--headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$P" --window-size=$W,$H --virtual-time-budget=6000 --screenshot="$2" --enable-logging=stderr --v=0)
[ "$SCHEME" = dark ] && FLAGS+=(--force-dark-mode --blink-settings=preferredColorScheme=1)
perl -e 'alarm 60; exec @ARGV' "$CH" "${FLAGS[@]}" "$1" < /dev/null 2>&1 | grep -i "console\|error" | grep -vi "dbus\|gcm\|ssl\|metrics\|updater\|GPU\|CVDisplayLink\|fontconfig\|sandbox" | head -8
rm -rf "$P"

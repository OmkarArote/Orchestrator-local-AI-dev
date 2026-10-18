#!/usr/bin/env bash
cd "$(dirname "$0")"; PIDFILE="$(pwd)/data/orchestrator.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then kill "$(cat "$PIDFILE")"; echo "stopped pid $(cat "$PIDFILE")"; else echo "not running"; fi
rm -f "$PIDFILE"

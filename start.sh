#!/usr/bin/env bash
# Start the orchestrator in the background. Logs: $ORCH_LOG_DIR (default ~/work/local-ai-dev/logs)/orchestrator.log
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=scripts/find-node.sh
. scripts/find-node.sh
NODE="$(find_node)" || { echo "Node.js >= 22.5 is required (it provides node:sqlite). Install it from https://nodejs.org or run: nvm install 22" >&2; exit 1; }
LOGDIR="${ORCH_LOG_DIR:-$HOME/work/local-ai-dev/logs}"; LOG="$LOGDIR/orchestrator.log"; PIDFILE="$(pwd)/data/orchestrator.pid"
mkdir -p "$LOGDIR" data
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
nohup "$NODE" --no-warnings server.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 1
PORT="${ORCH_PORT:-4310}"
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "started pid $(cat "$PIDFILE") -> http://127.0.0.1:$PORT  (log: $LOG)"; else echo "failed to start, see $LOG" >&2; rm -f "$PIDFILE"; exit 1; fi

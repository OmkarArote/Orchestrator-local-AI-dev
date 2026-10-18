#!/bin/bash
# usage: scripts/ui-smoke.sh <base url> [file:// test remote]  -- headless-Chrome UI smoke test against a scripts/dev-demo.js instance
cd "$(dirname "$0")/.." || exit 1
P=$(mktemp -d /tmp/orch-chrome-smoke-XXXXXX)
ORCH_SMOKE_PROFILE="$P" perl -e 'alarm 280; exec @ARGV' node scripts/ui-smoke.js "$@"; rc=$?
pkill -f "$P" 2>/dev/null; sleep 1; rm -rf "$P"
exit $rc

#!/bin/sh
# Check that the local Laya package imports. This script does not download weights.
set -eu
PY="${ORCH_LAYA_PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python3 was not found. Install Python 3, then install laya_mlx yourself."
  exit 1
fi
if ! "$PY" -c 'import laya_mlx' >/dev/null 2>&1; then
  echo "laya_mlx is not installed for $PY."
  echo "Install it yourself (no download is started by the orchestrator), then re-run this script."
  echo "The sidecar listens on 127.0.0.1 and ORCH_LAYA_PORT (default 4327)."
  echo "Set ORCH_LAYA_MODEL to the weights path if laya_mlx.load needs one."
  exit 1
fi
echo "laya_mlx imports. Start the sidecar with: ORCH_LAYA_PORT=\${ORCH_LAYA_PORT:-4327} $PY tools/laya-sidecar/server.py"
echo "Or set ORCH_DECIDER=1 and let the orchestrator start it. It stops before the coder loads an Ollama model unless ORCH_LAYA_KEEP=1."

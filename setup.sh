#!/usr/bin/env bash
# One-time setup / health check ("doctor"). Safe to re-run. It never downloads models and never installs anything unless you pass a flag.
#   ./setup.sh                  check prerequisites, create .env, print next steps
#   ./setup.sh --install-aider  also install aider (the local coding engine) via pipx/pip, then re-check
set -uo pipefail
cd "$(dirname "$0")"
. scripts/find-node.sh
ok(){ printf '  \033[32m✔\033[0m %s\n' "$*"; }; warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }; bad(){ printf '  \033[31m✘\033[0m %s\n' "$*"; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
FAIL=0
echo "Local AI Dev Orchestrator - setup check"
echo "Required:"
if NODE="$(find_node)"; then ok "Node.js $("$NODE" -v) ($NODE)"; else bad "Node.js >= 22.5 not found. Install: https://nodejs.org (or 'nvm install 22')"; FAIL=1; fi
if command -v git >/dev/null; then ok "$(git --version)"; else bad "git not found. Install git first."; FAIL=1; fi
echo "Local engine (free, runs on your machine):"
OLLAMA_URL="${OLLAMA_API_BASE:-http://127.0.0.1:11434}"
if command -v ollama >/dev/null; then ok "ollama installed ($(ollama --version 2>/dev/null | tail -1))"; else warn "Ollama not installed. Get it from https://ollama.com/download"; fi
if TAGS="$(curl -fsS --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null)"; then
  N="$(printf '%s' "$TAGS" | grep -o '"name"' | wc -l | tr -d ' ')"
  if [ "$N" -gt 0 ]; then ok "Ollama is running with $N model(s) installed (see them with: ollama list)"; else warn "Ollama is running but has no models. Example: ollama pull qwen2.5-coder:7b  (about 4.7 GB; fits a 16 GB machine)"; fi
else warn "Ollama is not reachable at $OLLAMA_URL. Start the Ollama app (or run: ollama serve)"; fi
if [ "${1:-}" = "--install-aider" ] && ! command -v aider >/dev/null; then
  echo "Installing aider..."
  if command -v pipx >/dev/null; then pipx install aider-chat; elif command -v python3 >/dev/null; then python3 -m pip install --user aider-install && python3 -m aider_install; else bad "need pipx or python3 to install aider"; fi
fi
if command -v aider >/dev/null; then ok "aider: $(command -v aider)"; else warn "aider not found (needed for the local engine). Install: ./setup.sh --install-aider   (or: python3 -m pip install aider-install && aider-install)"; fi
echo "Optional (Cursor engine, uses your Cursor plan):"
if [ -x "$HOME/.local/bin/agent" ] || command -v agent >/dev/null; then ok "Cursor CLI found (run 'agent login' once if you have not)"; else warn "Cursor CLI not found. Optional. Install: curl https://cursor.com/install -fsS | bash   then: agent login"; fi
[ -f .env ] || { cp .env.example .env && ok "created .env from .env.example (all settings commented out; edit if needed)"; }
mkdir -p data
echo
if [ "$FAIL" -ne 0 ]; then echo "Fix the ✘ items above, then re-run ./setup.sh"; exit 1; fi
echo "Next:"
echo "  ./start.sh                 # starts the dashboard at http://127.0.0.1:${ORCH_PORT:-4310}"
echo "  open the dashboard, Models -> choose your installed model, Projects -> New project / add a repo"
echo "  ./stop.sh                  # stops it"

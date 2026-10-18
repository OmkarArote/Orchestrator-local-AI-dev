#!/usr/bin/env bash
# find_node: print the path of a Node.js >= 22.5 binary (PATH first, then nvm, Homebrew, fnm/volta); return 1 if none.
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' >/dev/null 2>&1; }
find_node() {
  local c
  if c="$(command -v node 2>/dev/null)" && node_ok "$c"; then echo "$c"; return 0; fi
  for c in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /opt/homebrew/opt/node@22/bin/node /usr/local/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do
    [ -x "$c" ] && node_ok "$c" && { echo "$c"; return 0; }
  done
  return 1
}

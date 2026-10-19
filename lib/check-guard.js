'use strict';
// Check-command guard: a task check must TERMINATE (tests, lint, build, syntax check). A dev/start server or a watcher never exits, so the
// task sits in "checking" until the check timeout (swap-relook tasks #9-#12 ran `npm run dev` = nodemon). Pure functions, no I/O except
// reading package.json scripts that the caller passes in.

const SERVER_SCRIPT = /^(dev|start|serve|server|watch|preview|develop|run-server|start:dev|dev:.*|serve:.*|watch:.*)$/i;
// command text that runs forever (matched on one shell segment, after npm/yarn/pnpm script expansion)
const FOREVER = [
  [/\bnodemon\b/, 'nodemon (restarts on change, never exits)'],
  [/(^|\s)--watch(All)?\b/, 'a --watch flag'],
  [/\bnext\s+(dev|start)\b/, 'next dev/start'],
  [/\bvite(\s+(dev|serve|preview))?\s*$|\bvite\s+--/, 'vite dev server'],
  [/\bwebpack(-dev-server|\s+serve)\b/, 'webpack dev server'],
  [/\bng\s+serve\b|\breact-scripts\s+start\b|\bvue-cli-service\s+serve\b/, 'a frontend dev server'],
  [/\bts-node-dev\b|\btsx\s+watch\b/, 'a watch runner'],
  [/\bpm2\s+(start|restart)\b|\bforever\s+start\b/, 'a process manager'],
  [/\bhttp-server\b|\blive-server\b|\bserve\s+-s\b/, 'a static file server'],
  [/\b(flask\s+run|uvicorn|gunicorn|manage\.py\s+runserver|rails\s+s(erver)?)\b/, 'an app server'],
  [/\bdocker(-|\s+)compose\s+up\b(?!.*\s-d\b)/, 'docker compose up (attached)'],
  [/\bnode\s+(\S+\/)?(server|app|index|main)\.(c|m)?js\s*$/, 'node <server/app entry> (an HTTP server)'],
];

const segments = (cmd) => String(cmd).split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
const scriptOf = (seg) => {
  const m = seg.match(/^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)\b/);
  if (!m) return null;
  const builtin = { start: 'start', test: 'test', t: 'test' };
  if (/^(npm|pnpm|bun)\s+(install|i|ci|ls|exec|x|audit|outdated|pack)\b/.test(seg)) return null;
  if (/^yarn\s+(install|add|remove|why|dlx)\b/.test(seg)) return null;
  return builtin[m[1]] || m[1];
};

/**
 * Why `cmd` looks like a long-running server/watcher, or null when it should terminate. `scripts` = package.json scripts of the check's
 * working directory (optional): `npm run dev` is judged by the script name AND by what the script runs.
 */
function longRunningReason(cmd, scripts = {}, depth = 0) {
  if (!cmd || depth > 3) return null;
  for (const seg of segments(cmd)) {
    if (/^(timeout|gtimeout)\s+\d/.test(seg)) continue; // explicitly bounded by the user
    const script = scriptOf(seg);
    if (script) {
      if (script !== 'test' && SERVER_SCRIPT.test(script)) return `'${seg}' runs the '${script}' script, which is a dev/start server or watcher`;
      if (scripts && typeof scripts[script] === 'string') { const r = longRunningReason(scripts[script], scripts, depth + 1); if (r) return `'${seg}' runs "${scripts[script]}": ${r}`; }
      continue;
    }
    for (const [re, what] of FOREVER) if (re.test(seg)) return `'${seg}' starts ${what}`;
  }
  return null;
}

const HINT = 'a task check must terminate: use tests (e.g. `npm test`, `node --test --test-force-exit tests/x.test.js`), a lint/format check, a build, or a syntax check';

module.exports = { longRunningReason, HINT };

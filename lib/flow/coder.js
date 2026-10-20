'use strict';
// One-file editor for v2. Direct path: SEARCH/REPLACE via ollama.chat. Aider path: --edit-format diff, that file only.
// Reverts a no-op by writing the saved original. No recursive delete.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../../config');
const ollama = require('../ollama');
const { run } = require('../proc');

const BLOCK = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

function parseBlocks(text) {
  const blocks = [];
  for (const m of String(text || '').matchAll(BLOCK)) blocks.push({ search: m[1], replace: m[2] });
  return blocks;
}

function countExact(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function applyBlocks(original, blocks) {
  let text = original;
  for (const b of blocks) {
    if (countExact(text, b.search) !== 1) return { ok: false, reason: 'no_edit', error: 'SEARCH text must match exactly once' };
    text = text.replace(b.search, b.replace);
  }
  if (text === original) return { ok: false, reason: 'no_edit', error: 'edit changed nothing' };
  return { ok: true, text };
}

async function editDirect({ abs, prompt, model, chat, role = 'coder' }) {
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const talk = chat || ((body) => ollama.chat('ollama', body));
  const body = {
    model, stream: false, ...require('./roles').chatFields(role),
    messages: [
      { role: 'system', content: 'Reply with one or more SEARCH/REPLACE blocks and nothing else. The SEARCH text must occur exactly once in the file.\n<<<<<<< SEARCH\nexact existing text\n=======\nreplacement\n>>>>>>> REPLACE' },
      { role: 'user', content: `File ${path.basename(abs)}:\n${original}\n\nTask:\n${prompt}` },
    ],
  };
  const r = await talk(body);
  if (!r || !r.ok) return { ok: false, reason: 'no_edit', error: (r && r.message) || 'model reply failed' };
  const applied = applyBlocks(original, parseBlocks(r.content));
  if (!applied.ok) return applied;
  fs.writeFileSync(abs, applied.text);
  if (fs.readFileSync(abs, 'utf8') === original) { fs.writeFileSync(abs, original); return { ok: false, reason: 'no_edit', error: 'edit changed nothing' }; }
  return { ok: true, reason: null };
}

/** aider --model-settings-file body for a v2 step: the role's options (saved role wins, tuned fallback) and think, matched by the exact model name. */
function stepSettingsYaml(modelArg, role = 'coder', opts) {
  const roles = require('./roles');
  const o = roles.optionsFor(role, opts);
  const think = roles.thinkFor(role, opts);
  const keys = ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_predict', 'seed'].filter((k) => o[k] !== undefined);
  return `- name: ${modelArg}\n  extra_params:\n${keys.map((k) => `    ${k}: ${Number(o[k])}`).join('\n')}\n    think: ${typeof think === 'string' ? JSON.stringify(think) : think ? 'true' : 'false'}\n`;
}

const READ_MAX_FILES = 4, READ_MAX_CHARS = 12000, READ_FILE_CHARS = 6000;
const NOISE_RE = /(^|\/)(README[^/]*|CHANGELOG[^/]*|LICENSE[^/]*|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.md|app\.module\.[jt]s|main\.[jt]s|index\.html)$/i;

/**
 * --read context for one step: one entry per file (snippets of the same file are merged in line order), never the step's own
 * file, read-only reference files first (whole file), then reader snippets limited to `scope` files when given, else without
 * docs / lockfiles / app wiring. Capped at 4 files and 12000 chars (6000 per file). Task #34 sent one file 6 times plus README.
 * @returns {{path:string,text:string}[]}
 */
function buildReads({ rel, snippets = [], readOnly = [], root, scope = null }) {
  const out = [];
  let total = 0;
  const push = (p, text) => {
    if (!text || p === rel || out.some((o) => o.path === p) || out.length >= READ_MAX_FILES || total >= READ_MAX_CHARS) return;
    const t = String(text).slice(0, Math.min(READ_FILE_CHARS, READ_MAX_CHARS - total));
    out.push({ path: p, text: t });
    total += t.length;
  };
  for (const p of readOnly) {
    let text = null;
    try { text = fs.readFileSync(path.join(root, p), 'utf8'); } catch { /* missing: skip */ }
    push(p, text);
  }
  const byPath = new Map();
  for (const s of snippets || []) {
    if (!s || !s.path || s.path === rel) continue;
    if (scope ? !scope.includes(s.path) : NOISE_RE.test(s.path)) continue;
    if (!byPath.has(s.path)) byPath.set(s.path, []);
    const list = byPath.get(s.path);
    if (!list.some((x) => x.start === s.start && x.text === s.text)) list.push(s);
  }
  for (const [p, list] of byPath) push(p, list.sort((a, b) => (a.start || 0) - (b.start || 0)).map((s) => s.text).join('\n...\n'));
  return out;
}

async function editAider({ wt, rel, prompt, snippets, model, runCmd, role = 'coder', onSpawn, readOnly = [], taskId = 0, scope = null }) {
  const abs = path.join(wt, rel);
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  const format = cfg.AIDER_EDIT_FORMAT && cfg.AIDER_EDIT_FORMAT !== 'diff' ? cfg.AIDER_EDIT_FORMAT : 'diff';
  const reads = [];
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  for (const r of buildReads({ rel, snippets, readOnly, root: wt, scope })) {
    const f = path.join(cfg.LOG_DIR, `v2-read-t${taskId}-${r.path.replace(/[^\w.-]+/g, '_')}`);
    fs.writeFileSync(f, r.text);
    reads.push(f);
  }
  const modelArg = `ollama_chat/${String(model).replace(/^ollama_chat\//, '')}`;
  fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
  const settings = path.join(cfg.LOG_DIR, `v2-${role}-${String(model).replace(/[^\w.-]+/g, '_')}.model-settings.yml`);
  fs.writeFileSync(settings, stepSettingsYaml(modelArg, role));
  // one pinned file, no repo map: the step names its file, so aider has nothing to auto-add (aider 0.86 has no --no-auto-add)
  const args = ['--model', modelArg, '--model-settings-file', settings, '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--edit-format', format, '--no-pretty', '--no-fancy-input',
    '--map-tokens', '0', '--no-gitignore', '--no-suggest-shell-commands', '--no-detect-urls', '--message', prompt, ...reads.flatMap((f) => ['--read', f]), rel];
  const spawn = runCmd || run;
  // onSpawn hands the kill function to the runner, so a cancel stops this aider run (task #34 kept running after cancel)
  const r = await spawn(cfg.AIDER_BIN, args, { cwd: wt, timeoutMs: cfg.AIDER_TIMEOUT_MS, ...(onSpawn ? { onSpawn } : {}) });
  if (!r || r.code !== 0) return { ok: false, reason: 'no_edit', error: `aider exit ${r ? r.code : '?'}` };
  const next = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (next === (original || '')) {
    if (original != null) fs.writeFileSync(abs, original);
    return { ok: false, reason: 'no_edit', error: 'aider made no change' };
  }
  return { ok: true, reason: null, format };
}

async function editStep(ctx, step, { engine = 'aider', model, snippets, role = 'coder', readOnly = [], scope = null } = {}) {
  const rel = step.file;
  const abs = path.join(ctx.wt, rel);
  const prompt = `${ctx.task.prompt}\n\nStep ${step.id || ''}: ${step.intent || ''}\nFile: ${rel}`;
  if (engine === 'direct') return editDirect({ abs, prompt, model, role });
  return editAider({ wt: ctx.wt, rel, prompt, snippets, model, role, readOnly, scope, onSpawn: ctx.onSpawn, taskId: ctx.task && ctx.task.id });
}

module.exports = { editStep, editDirect, editAider, buildReads, stepSettingsYaml, parseBlocks, applyBlocks, countExact };

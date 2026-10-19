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

async function editDirect({ abs, prompt, model, chat }) {
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const talk = chat || ((body) => ollama.chat('ollama', body));
  const body = {
    model, stream: false, think: false, keep_alive: cfg.OLLAMA_KEEP_ALIVE,
    options: { temperature: 0.2, num_predict: cfg.LOCAL_NUM_PREDICT, num_ctx: cfg.LOCAL_NUM_CTX },
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

async function editAider({ wt, rel, prompt, snippets, model, runCmd }) {
  const abs = path.join(wt, rel);
  const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  const format = cfg.AIDER_EDIT_FORMAT && cfg.AIDER_EDIT_FORMAT !== 'diff' ? cfg.AIDER_EDIT_FORMAT : 'diff';
  const reads = [];
  for (const snip of snippets || []) {
    if (snip.path === rel) continue;
    const f = path.join(cfg.LOG_DIR, `v2-read-${path.basename(snip.path)}`);
    fs.mkdirSync(cfg.LOG_DIR, { recursive: true });
    fs.writeFileSync(f, snip.text || '');
    reads.push(f);
  }
  const args = ['--model', `ollama_chat/${String(model).replace(/^ollama_chat\//, '')}`, '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--edit-format', format, '--no-pretty', '--no-fancy-input', '--message', prompt, ...reads.flatMap((f) => ['--read', f]), rel];
  const spawn = runCmd || run;
  const r = await spawn(cfg.AIDER_BIN, args, { cwd: wt, timeoutMs: cfg.AIDER_TIMEOUT_MS });
  if (!r || r.code !== 0) return { ok: false, reason: 'no_edit', error: `aider exit ${r ? r.code : '?'}` };
  const next = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  if (next === (original || '')) {
    if (original != null) fs.writeFileSync(abs, original);
    return { ok: false, reason: 'no_edit', error: 'aider made no change' };
  }
  return { ok: true, reason: null, format };
}

async function editStep(ctx, step, { engine = 'aider', model, snippets } = {}) {
  const rel = step.file;
  const abs = path.join(ctx.wt, rel);
  const prompt = `${ctx.task.prompt}\n\nStep ${step.id || ''}: ${step.intent || ''}\nFile: ${rel}`;
  if (engine === 'direct') return editDirect({ abs, prompt, model });
  return editAider({ wt: ctx.wt, rel, prompt, snippets, model });
}

module.exports = { editStep, editDirect, editAider, parseBlocks, applyBlocks, countExact };

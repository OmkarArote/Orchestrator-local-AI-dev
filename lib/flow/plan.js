'use strict';
// Multi-file heuristic for flow v2. Pure: no git, no Ollama, no Cursor. The reader (later) is passed in.

const PATH_RE = /(?:^|[^\w./-])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})/g;

function promptPaths(prompt) {
  const out = [];
  for (const m of String(prompt || '').matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    // identifiers like visit.outcome or CheckOutDto.outcome are not files (task #33)
    if (require('./prompt-files').looksLikePath(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * @param {string} prompt
 * @param {{ difficulty?: string, route?: { difficulty?: string }, files?: ({path:string}|string)[], index?: string[] } | null} [reader]
 * @returns {{ multi: boolean, reason: string|null, paths: string[] }}
 */
function isMultiFile(prompt, reader) {
  const paths = promptPaths(prompt);
  const difficulty = reader && (reader.difficulty || (reader.route && reader.route.difficulty));
  if (difficulty === 'complex') return { multi: true, reason: 'files', paths };
  if (paths.length >= 2) return { multi: true, reason: 'files', paths };
  const index = reader && Array.isArray(reader.index) ? reader.index.map(String) : [];
  if (index.length) {
    const tokens = new Set(String(prompt || '').match(/[A-Za-z_][\w$]*/g) || []);
    const resolved = [];
    for (const file of index) {
      const base = file.split('/').pop();
      const stem = base.replace(/\.[^.]+$/, '');
      if ((tokens.has(base) || tokens.has(stem)) && !resolved.includes(file)) resolved.push(file);
    }
    if (resolved.length >= 2) return { multi: true, reason: 'files', paths: resolved };
  }
  const hits = reader && Array.isArray(reader.files) ? reader.files.map((f) => (typeof f === 'string' ? f : (f && f.path) || '')).filter(Boolean) : [];
  const dirs = new Set(hits.map((p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }).filter((d) => d && d !== '.'));
  if (dirs.size > 2) return { multi: true, reason: 'files', paths: hits };
  return { multi: false, reason: null, paths };
}

function tryParse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* a model often wraps the object */ }
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * @param {object|string} json
 * @returns {{ok:true, plan:object}|{ok:false, error:string}}
 */
function validatePlan(json) {
  const p = typeof json === 'string' ? tryParse(json) : json;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, error: 'plan is not a JSON object' };
  if (!Array.isArray(p.steps) || !p.steps.length) return { ok: false, error: 'plan needs at least one step' };
  const steps = [];
  for (const s of p.steps) {
    const file = s && typeof s.file === 'string' ? s.file.replace(/^\.\//, '').trim() : '';
    if (!file || file.startsWith('/') || file.split('/').includes('..') || file.startsWith('-')) return { ok: false, error: 'step file must be a repo-relative path' };
    steps.push({
      id: String((s && s.id) || steps.length + 1),
      file,
      intent: String((s && s.intent) || ''),
      acceptance: String((s && s.acceptance) || ''),
      estLines: Number(s && s.estLines) || 0,
    });
  }
  const risk = p.risk && typeof p.risk === 'object' && !Array.isArray(p.risk) ? p.risk : {};
  return {
    ok: true,
    plan: {
      targetBranch: p.targetBranch ? String(p.targetBranch) : null,
      steps,
      risk: { files: Number(risk.files) || steps.length, crossModule: !!risk.crossModule, contract: !!risk.contract, estDiff: Number(risk.estDiff) || 0 },
    },
  };
}

/** Local planner. One retry on invalid JSON, then the caller uses planCursor. Never calls Cursor itself. */
async function planLocal(ctx, reader, { chat, model } = {}) {
  const cfg = require('../../config');
  const talk = chat || ((body) => require('../ollama').chat('ollama', body));
  const modelName = model || (ctx && ctx.model) || 'ornith:9b';
  const user = JSON.stringify({
    prompt: ctx && ctx.task ? ctx.task.prompt : '',
    files: (reader && reader.files) || [],
    snippets: ((reader && reader.snippets) || []).slice(0, 8).map((s) => ({ path: s.path, text: String(s.text || '').slice(0, 1500) })),
  });
  const role = require('./roles').chatFields('planner');
  // explicit num_ctx: without it Ollama loads the model with its 4096-token default and silently cuts the plan prompt
  const trimmed = user.slice(0, cfg.requestCapFor(role.options.num_ctx, role.options.num_predict));
  const body = {
    model: modelName, stream: false, format: 'json', ...role,
    messages: [
      { role: 'system', content: 'Return one JSON object and nothing else: {"targetBranch":string|null,"steps":[{"id":string,"file":string,"intent":string,"acceptance":string,"estLines":number}],"risk":{"files":number,"crossModule":boolean,"contract":boolean,"estDiff":number}}. One step per file. estDiff is a line estimate.' },
      { role: 'user', content: trimmed },
    ],
  };
  let last = 'model reply failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await talk(body);
    if (!r || !r.ok) { last = (r && r.message) || 'model reply failed'; continue; }
    const v = validatePlan(r.content);
    if (v.ok) return { ok: true, plan: v.plan, source: 'local', model: modelName, attempts: attempt };
    last = v.error;
  }
  return { ok: false, error: last, attempts: 2, model: modelName };
}

/** Cursor planner. Parses plan text into steps, or one step per file the plan or the prompt names. */
async function planCursor(ctx, reader, planWithCursor) {
  if (typeof planWithCursor !== 'function') return { ok: false, error: 'no cursor planner' };
  const r = await planWithCursor(ctx);
  const text = String((r && (r.plan || r.text || r.fullText)) || '');
  const parsed = validatePlan(text);
  if (parsed.ok) return { ok: true, plan: parsed.plan, source: 'cursor', text, model: r && r.model || null };
  const named = [...new Set([...promptPaths(text), ...promptPaths(ctx && ctx.task && ctx.task.prompt), ...((reader && reader.files) || []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean)])];
  if (!named.length) return { ok: false, error: parsed.error || 'cursor plan had no files', text };
  return {
    ok: true, source: 'cursor-files', text, model: r && r.model || null,
    plan: { targetBranch: null, steps: named.map((file, i) => ({ id: String(i + 1), file, intent: 'implement', acceptance: 'check passes', estLines: 20 })), risk: { files: named.length, crossModule: false, contract: false, estDiff: named.length * 20 } },
  };
}

module.exports = { isMultiFile, promptPaths, validatePlan, planLocal, planCursor };

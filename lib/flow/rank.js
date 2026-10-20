'use strict';
// Rank an existing project index against a task prompt. No git and no model.
// An explicit ## Files section is the edit list. Otherwise symbol, path and summary overlap, plus import-graph neighbours.
const { parsePromptFiles } = require('./prompt-files');

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'only', 'when', 'then', 'else', 'true', 'false', 'null', 'return', 'function', 'const', 'class', 'edit', 'file', 'files', 'change', 'update', 'please', 'add', 'new', 'optional', 'string', 'keep', 'list']);

function words(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    if (STOP.has(w.toLowerCase()) || w.length > 48) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function mentioned(prompt, name) {
  if (!name || name.length < 3) return false;
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return re.test(prompt);
}

function kebab(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

/** A backtick name introduced as a new enum, placed beside an existing *.enum.ts. */
function proposedEnums(prompt, symbols, files) {
  const have = new Set((symbols || []).map((s) => s.name));
  const dirs = [...new Set((files || []).filter((f) => /\.enum\.[a-z]+$/i.test(f.path)).map((f) => f.path.split('/').slice(0, -1).join('/')))];
  if (!dirs.length) return [];
  const out = [];
  for (const line of String(prompt || '').split('\n')) {
    if (!/\benum\b/i.test(line) || !/\bnew\b/i.test(line)) continue;
    for (const m of line.matchAll(/`([A-Z][A-Za-z0-9]+)`/g)) {
      const name = m[1];
      if (have.has(name)) continue;
      const path = `${dirs[0]}/${kebab(name)}.enum.ts`;
      if ((files || []).some((f) => f.path === path) || out.includes(path)) continue;
      out.push(path);
    }
  }
  return out;
}

function scoreFiles({ files, symbols, modules, prompt, vectors }) {
  const scores = new Map();
  const add = (p, n) => { if (p) scores.set(p, (scores.get(p) || 0) + n); };
  const text = String(prompt || '');
  const ws = new Set(words(text).map((w) => w.toLowerCase()));
  for (const s of symbols || []) {
    if (!mentioned(text, s.name)) continue;
    const lineHit = text.split('\n').some((line) => mentioned(line, s.name) && /\b(do not|don't|must not)\b/i.test(line));
    const onlyDenial = lineHit && !text.split('\n').some((line) => mentioned(line, s.name) && !/\b(do not|don't|must not)\b/i.test(line));
    if (onlyDenial) continue;
    add(s.path, 8);
  }
  for (const f of files || []) {
    const base = f.path.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '').replace(/\.(enum|dto|schema|service|util|model|controller)$/i, '');
    if (text.includes(f.path)) add(f.path, 6);
    else if (mentioned(text, base) || (stem.length >= 4 && mentioned(text, stem))) add(f.path, 4);
    for (const seg of f.path.split('/')) if (seg.length >= 4 && ws.has(seg.toLowerCase())) add(f.path, 2);
  }
  for (const mod of modules || []) {
    if (!mod.summary) continue;
    let n = 0;
    for (const w of words(mod.summary)) if (ws.has(w.toLowerCase())) n++;
    if (!n) continue;
    const bonus = Math.min(6, n * 2);
    for (const f of files || []) {
      const dir = f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : '(root)';
      if (dir === mod.path || dir.startsWith(`${mod.path}/`)) add(f.path, bonus);
    }
  }
  if (vectors) {
    const have = new Set((files || []).map((f) => f.path));
    for (const [p, cos] of Object.entries(vectors)) {
      if (!have.has(p)) continue;
      const c = Number(cos);
      if (c > 0.25) add(p, Math.round(c * 6));
    }
  }
  return scores;
}

/**
 * @returns {{ files:{path:string,score:number,created?:boolean}[], readOnly:string[], created:string[], source:string }}
 */
function rankIndex({ files = [], symbols = [], edges = [], modules = [], prompt = '', vectors = null } = {}) {
  const have = new Set(files.map((f) => f.path));
  const parsed = parsePromptFiles(prompt, { exists: (p) => have.has(p) });
  if (parsed.section) {
    return {
      source: 'files-section',
      files: parsed.edit.map((p) => ({ path: p, score: 100, created: parsed.created.includes(p) })),
      readOnly: parsed.read,
      created: parsed.created,
    };
  }
  const scores = scoreFiles({ files, symbols, modules, prompt, vectors });
  const created = proposedEnums(prompt, symbols, files);
  for (const p of created) scores.set(p, Math.max(scores.get(p) || 0, 9));
  const ranked = [...scores.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const best = ranked.length ? ranked[0][1] : 0;
  const floor = Math.max(6, best * 0.5);
  const edit = [];
  for (const [p, n] of ranked) {
    if (edit.length >= 8) break;
    if (n < floor && !created.includes(p)) continue;
    edit.push({ path: p, score: n, created: created.includes(p) });
  }
  const editSet = new Set(edit.map((f) => f.path));
  const readOnly = [];
  for (const e of edges || []) {
    const hit = editSet.has(e.from) || editSet.has(e.to);
    const other = editSet.has(e.from) ? e.to : e.from;
    if (hit && other && !editSet.has(other) && have.has(other) && !readOnly.includes(other) && readOnly.length < 4) readOnly.push(other);
  }
  return { source: 'index', files: edit, readOnly, created: created.filter((p) => editSet.has(p)) };
}

module.exports = { rankIndex, kebab, proposedEnums };

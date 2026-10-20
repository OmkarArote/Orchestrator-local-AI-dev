'use strict';
// A feature that names more than LOCAL_MAX_FILES files is split into a stacked sequence of small v2 tasks (at most `max` files each)
// instead of one Cursor run. The parts are created pending: each still needs its own start approval. Nothing runs here.

/** Order paths by directory (first-seen order, so the caller's layer order stays), then cut into chunks of at most `max`. */
function splitFiles(paths, max = 3) {
  const uniq = [...new Set((paths || []).map(String).filter(Boolean))];
  const byDir = new Map();
  for (const p of uniq) {
    const i = p.lastIndexOf('/');
    const d = i < 0 ? '.' : p.slice(0, i);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(p);
  }
  const flat = [...byDir.values()].flat();
  const chunks = [];
  for (let i = 0; i < flat.length; i += Math.max(1, max)) chunks.push(flat.slice(i, i + Math.max(1, max)));
  return chunks;
}

/** Create the sequence. Returns { groupId, taskIds, chunks }. `store` is lib/db (injected for tests). */
function createSplit(task, paths, { store, max = 3, chunks: given } = {}) {
  const chunks = given || splitFiles(paths, max);
  const title = String(task.title || `task ${task.id}`).slice(0, 150);
  const groupId = store.createGroup({ project_id: task.project_id, title: `${title} (split from #${task.id})`, dependency: 'stack' });
  const taskIds = chunks.map((files, i) => {
    const id = store.createTask({
      project_id: task.project_id, title: `${title} - part ${i + 1}/${chunks.length}`.slice(0, 200),
      prompt: `${task.prompt}\n\nThis is part ${i + 1} of ${chunks.length}. Only change these files: ${files.join(', ')}. Other parts handle the rest.`,
      files, check_cmd: task.check_cmd || null, engine: 'auto', model: task.model || null, allow_escalation: true,
      service_id: task.service_id || null, group_id: groupId, step_no: i + 1, routing_source: 'split', flow: 'v2',
    });
    store.addEvent(id, 'system', `task created as part ${i + 1}/${chunks.length} of sequence #${groupId}, split from #${task.id} (${files.length} file(s): ${files.join(', ')}); status pending, awaiting start approval`);
    return id;
  });
  return { groupId, taskIds, chunks };
}

module.exports = { splitFiles, createSplit };

// ---- dependency-aware grouping (task #33: a new enum must stay with the DTO that uses it)
const path = require('node:path');
const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

/** Listed files that `file` imports (relative imports only), resolved against the list. */
function importsOf(file, text, listed) {
  const out = [];
  const dir = path.posix.dirname(file);
  for (const m of String(text || '').matchAll(IMPORT_RE)) {
    const base = path.posix.normalize(path.posix.join(dir, m[1]));
    const hit = EXTS.map((e) => base + e).find((c) => listed.includes(c));
    if (hit && hit !== file && !out.includes(hit)) out.push(hit);
  }
  return out;
}

const stemName = (file) => path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/\.(enum|dto|schema|model|service|types?)$/, '')
  .split(/[-_.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/** Existing listed file that will use a new file: the prompt line naming the new symbol also names a class/const defined in that file. */
function ownerOf(newFile, { prompt, existing, readFile }) {
  const sym = stemName(newFile);
  if (!sym) return null;
  const idents = new Set();
  for (const line of String(prompt || '').split('\n')) if (line.includes(sym)) for (const m of line.matchAll(/\b([A-Z][A-Za-z0-9]{2,})\b/g)) if (m[1] !== sym) idents.add(m[1]);
  for (const f of existing) {
    const text = readFile(f) || '';
    for (const id of idents) if (new RegExp(`\\b(?:class|interface|enum|type|function|const)\\s+${id}\\b`).test(text)) return f;
  }
  return null;
}

/**
 * Group edit files into parts of at most `max` files. New files do not count toward the cap when everything fits in one part
 * (they carry no content into the request). Otherwise: a new file is glued to the existing file that will use it, then units
 * are ordered so imported files come first and packed greedily.
 * @returns {string[][]}
 */
function groupFiles(files, { max = 3, created = [], prompt = '', readFile = () => null } = {}) {
  const list = [...new Set(files || [])];
  const existing = list.filter((f) => !created.includes(f));
  if (existing.length <= max) return list.length ? [[...created.filter((f) => list.includes(f)), ...existing]] : [];
  const unitOf = new Map(list.map((f) => [f, [f]]));
  for (const nf of created.filter((f) => list.includes(f))) {
    const owner = ownerOf(nf, { prompt, existing, readFile });
    if (!owner) continue;
    const u = unitOf.get(owner);
    if (u.length >= max) continue;
    u.unshift(nf);
    unitOf.set(nf, u);
  }
  const units = [...new Set(unitOf.values())];
  const deps = new Map(units.map((u) => [u, new Set()]));
  for (const u of units) for (const f of u) for (const imp of importsOf(f, readFile(f), list)) { const v = unitOf.get(imp); if (v && v !== u) deps.get(u).add(v); }
  const ordered = [];
  const visit = (u, seen = new Set()) => { if (ordered.includes(u) || seen.has(u)) return; seen.add(u); for (const d of deps.get(u)) visit(d, seen); ordered.push(u); };
  for (const u of units) visit(u);
  const parts = [];
  for (const u of ordered) {
    const last = parts[parts.length - 1];
    if (last && last.length + u.length <= max) last.push(...u); else parts.push([...u]);
  }
  return parts;
}

module.exports.groupFiles = groupFiles;
module.exports.importsOf = importsOf;

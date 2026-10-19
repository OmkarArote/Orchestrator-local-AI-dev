'use strict';
// Multi-file heuristic for flow v2. Pure: no git, no Ollama, no Cursor. The reader (later) is passed in.

const PATH_RE = /(?:^|[^\w./-])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})/g;

function promptPaths(prompt) {
  const out = [];
  for (const m of String(prompt || '').matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '');
    if (!out.includes(p)) out.push(p);
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

module.exports = { isMultiFile, promptPaths };

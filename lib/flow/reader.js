'use strict';
// v2 reader: git grep + a regex symbol map. No LLM. Git only through lib/proc.js.
const fs = require('node:fs');
const path = require('node:path');
const { git } = require('../proc');
const { rankIndex } = require('./rank');

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'only', 'when', 'then', 'else', 'true', 'false', 'null', 'return', 'function', 'const', 'class', 'edit', 'file', 'files', 'change', 'update', 'please']);
const SYM = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

function keywords(prompt) {
  const out = [];
  for (const m of String(prompt || '').matchAll(IDENT)) {
    const w = m[0];
    if (STOP.has(w.toLowerCase()) || w.length > 40) continue;
    if (!out.includes(w)) out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

function enclosing(lines, lineNo) {
  const idx = Math.max(0, lineNo - 1);
  let start = idx;
  for (let i = idx; i >= 0 && idx - i < 80; i--) {
    if (SYM.test(lines[i])) { start = i; break; }
  }
  let depth = 0, seen = false, end = Math.min(lines.length - 1, start + 40);
  for (let i = start; i < lines.length && i < start + 200; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) { end = i; break; }
  }
  if (!seen) { start = Math.max(0, idx - 40); end = Math.min(lines.length - 1, idx + 40); }
  return { start: start + 1, end: end + 1, text: lines.slice(start, end + 1).join('\n') };
}

/**
 * Rank files and pack enclosing snippets until budgetChars.
 * @returns {{files:{path:string,score:number}[], snippets:{path:string,start:number,end:number,text:string}[], symbols:{name:string,path:string}[], chars:number, index:string[]}}
 */
function packSnippets(base, picks, budgetChars) {
  const snippets = [];
  const symbols = [];
  let chars = 0;
  for (const file of picks) {
    if (chars >= budgetChars) break;
    let text;
    try { text = fs.readFileSync(path.join(base, file.path), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    lines.forEach((l, i) => { const s = SYM.exec(l); const name = s && (s[1] || s[2]); if (name) symbols.push({ name, path: file.path, line: i + 1 }); });
    const targets = file.lines && file.lines.length ? file.lines : [1];
    for (const n of targets) {
      if (chars >= budgetChars) break;
      const snip = enclosing(lines, n);
      const piece = snip.text.slice(0, Math.max(0, budgetChars - chars));
      if (!piece) break;
      snippets.push({ path: file.path, start: snip.start, end: snip.start + piece.split('\n').length - 1, text: piece });
      chars += piece.length;
    }
  }
  return { snippets, symbols, chars, tokenEstimate: Math.ceil(chars / 4) };
}

async function discover({ wt, root, prompt, budgetChars = 39000, index = null, vectors = null }) {
  const base = root || wt;
  if (index && Array.isArray(index.files) && index.files.length) {
    const ranked = rankIndex({ files: index.files, symbols: index.symbols, edges: index.edges, modules: index.modules, prompt, vectors });
    const picks = [...ranked.files.map((f) => ({ path: f.path, lines: [1] })), ...ranked.readOnly.map((p) => ({ path: p, lines: [1] }))];
    const packed = packSnippets(base, picks, budgetChars);
    return {
      files: ranked.files, readOnly: ranked.readOnly, created: ranked.created, source: ranked.source,
      snippets: packed.snippets, symbols: packed.symbols, chars: packed.chars, tokenEstimate: packed.tokenEstimate,
      budgetChars, index: ranked.files.map((f) => f.path),
    };
  }
  const ls = await git(wt, ['ls-files', '-z', '--', '.']);
  const listed = ls.code === 0 ? ls.out.split('\0').filter(Boolean) : [];
  const scores = new Map();
  const hitLines = new Map();
  for (const kw of keywords(prompt)) {
    const g = await git(wt, ['grep', '-n', '-I', '-F', '-e', kw, '--', '.']);
    if (g.code !== 0 && g.code !== 1) continue;
    for (const line of g.out.split('\n')) {
      const m = /^([^:]+):(\d+):/.exec(line);
      if (!m) continue;
      scores.set(m[1], (scores.get(m[1]) || 0) + 1);
      if (!hitLines.has(m[1])) hitLines.set(m[1], []);
      const arr = hitLines.get(m[1]);
      if (arr.length < 6) arr.push(Number(m[2]));
    }
  }
  for (const f of listed) {
    const base = f.split('/').pop();
    if (base && String(prompt).includes(base)) scores.set(f, (scores.get(f) || 0) + 3);
  }
  const files = [...scores.entries()].map(([p, score]) => ({ path: p, score })).sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const packed = packSnippets(base, files.map((f) => ({ path: f.path, lines: hitLines.get(f.path) || [1] })), budgetChars);
  return { files, snippets: packed.snippets, symbols: packed.symbols, chars: packed.chars, tokenEstimate: packed.tokenEstimate, budgetChars, index: listed };
}

module.exports = { discover, keywords, enclosing, rankIndex };

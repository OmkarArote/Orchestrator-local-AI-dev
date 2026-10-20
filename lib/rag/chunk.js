'use strict';
// Split a file into symbol chunks, or ~60-line windows when the file has no symbols.
const cfg = require('../../config');
const { extractSymbols } = require('../index/extract');

function windowSize() {
  const n = cfg.RAG_WINDOW;
  return Number.isInteger(n) && n >= 20 ? n : 60;
}

/** 1-based end line of a brace block that starts at `startLine`, capped at the window size. */
function braceEnd(lines, startLine, cap) {
  const start = Math.max(0, startLine - 1);
  let depth = 0;
  let seen = false;
  let end = Math.min(lines.length - 1, start + cap - 1);
  for (let i = start; i < lines.length && i < start + 200; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) { end = i; break; }
    if (i - start + 1 >= cap) { end = i; break; }
  }
  return end + 1;
}

/**
 * @returns {{chunk_key:string, kind:string, name:string|null, start_line:number, end_line:number, text:string}[]}
 */
function chunkText(text, file) {
  const src = String(text || '');
  const lines = src.split('\n');
  const cap = windowSize();
  const symbols = extractSymbols(src, file).slice().sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  if (!symbols.length) {
    const out = [];
    for (let i = 0; i < lines.length; i += cap) {
      const start = i + 1;
      const end = Math.min(lines.length, i + cap);
      const body = lines.slice(i, end).join('\n');
      if (!body.trim()) continue;
      out.push({ chunk_key: `window:${start}`, kind: 'window', name: null, start_line: start, end_line: end, text: body });
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const next = symbols[i + 1];
    let end;
    if (s.kind === 'route') {
      const limit = next ? Math.min(next.line - 1, s.line + 2) : Math.min(lines.length, s.line + 2);
      end = Math.max(s.line, limit);
    } else {
      end = braceEnd(lines, s.line, cap);
      if (next && next.line > s.line && end >= next.line) end = next.line - 1;
      if (end < s.line) end = s.line;
    }
    const body = lines.slice(s.line - 1, end).join('\n');
    if (!body.trim()) continue;
    out.push({
      chunk_key: `${s.kind}:${s.name}:${s.line}`,
      kind: s.kind,
      name: s.name,
      start_line: s.line,
      end_line: end,
      text: body,
    });
  }
  return out;
}

module.exports = { chunkText, braceEnd };

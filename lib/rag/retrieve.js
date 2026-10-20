'use strict';
// Build the coder context from stored chunks. Returns null when the caller should keep today's reader.
const cfg = require('../../config');
const { parsePromptFiles } = require('../flow/prompt-files');
const { proposedEnums } = require('../flow/rank');
const { optionsFor } = require('../flow/roles');
const { listChunks, listVectors } = require('./store');
const { rankChunks } = require('./rank');
const { fill } = require('./context');
const { decode, cosine } = require('./vectors');

function budgetFor(role) {
  const ctx = optionsFor(role || 'coder').num_ctx;
  return Math.floor(Number(ctx) * 0.6);
}

/**
 * @returns {Promise<object|null>} discover-shaped reader, or null to fall back
 */
async function retrieve({ serviceId, prompt, index, role = 'coder', embedder, budgetTokens } = {}) {
  if (!cfg.RAG || !serviceId || !index || !Array.isArray(index.files) || !index.files.length) return null;
  const have = new Set(index.files.map((f) => f.path));
  const parsed = parsePromptFiles(prompt, { exists: (p) => have.has(p) });
  if (parsed.section) return null;
  const chunks = listChunks(serviceId);
  if (!chunks.length) return null;
  const vecRows = listVectors(serviceId);
  let cosines = null;
  let vectorsSkipped = !vecRows.length;
  if (vecRows.length) {
    const embed = embedder || require('../index/embed').defaultEmbedder;
    let query = null;
    try {
      const got = await embed([String(prompt || '').slice(0, 2000)]);
      query = got && Array.isArray(got[0]) ? got[0] : null;
    } catch { query = null; }
    if (!query) vectorsSkipped = true;
    else {
      cosines = new Map();
      for (const row of vecRows) cosines.set(`${row.path}\0${row.chunk_key}`, cosine(query, decode(row.vector)));
    }
  }
  const ranked = rankChunks({
    chunks, prompt, cosines, edges: index.edges || [], files: index.files,
  });
  const filled = fill(ranked, budgetTokens || budgetFor(role));
  if (!filled.chunks.length || filled.chunks.every((c) => c.score <= 0)) return null;
  const created = proposedEnums(prompt, index.symbols || [], index.files);
  const files = [];
  const seen = new Set();
  for (const c of filled.chunks) {
    if (seen.has(c.path) || files.length >= 8) continue;
    seen.add(c.path);
    files.push({ path: c.path, score: c.score });
  }
  for (const p of created) {
    if (seen.has(p) || files.length >= 8) continue;
    seen.add(p);
    files.push({ path: p, score: 0.5, created: true });
  }
  const editSet = new Set(files.map((f) => f.path));
  const readOnly = [];
  for (const e of index.edges || []) {
    const hit = editSet.has(e.from) || editSet.has(e.to);
    const other = editSet.has(e.from) ? e.to : e.from;
    if (hit && other && !editSet.has(other) && have.has(other) && !readOnly.includes(other) && readOnly.length < 4) readOnly.push(other);
  }
  return {
    files,
    readOnly,
    created: created.filter((p) => editSet.has(p)),
    source: 'rag',
    snippets: filled.chunks.map((c) => {
      let text = c.text;
      if (cfg.GUARDRAILS) text = require('../guardrails/input').wrap(text, c.path).text;
      return { path: c.path, start: c.start_line, end: c.end_line, text };
    }),
    symbols: filled.chunks.filter((c) => c.name).map((c) => ({ name: c.name, path: c.path, line: c.start_line })),
    chars: filled.chars,
    tokenEstimate: filled.tokenEstimate,
    budgetChars: filled.budgetTokens * 4,
    index: files.map((f) => f.path),
    chunks: filled.chunks,
    vectorsSkipped,
    budgetTokens: filled.budgetTokens,
  };
}

module.exports = { retrieve, budgetFor };

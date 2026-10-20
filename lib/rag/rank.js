'use strict';
// Hybrid rank: BM25 + chunk cosine + import-graph proximity to files named in the task.
const path = require('node:path');
const cfg = require('../../config');
const { score } = require('./bm25');
const { promptPaths } = require('../flow/plan');

function moduleOf(filePath) {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '(root)' : dir;
}

function weightsOf(weights) {
  const w = weights || { bm25: cfg.RAG_W_BM25, vector: cfg.RAG_W_VECTOR, graph: cfg.RAG_W_GRAPH };
  return {
    bm25: Number(w.bm25) || 0,
    vector: Number(w.vector) || 0,
    graph: Number(w.graph) || 0,
  };
}

function namedFiles(prompt, files) {
  const have = new Set((files || []).map((f) => (typeof f === 'string' ? f : f.path)));
  const named = new Set();
  for (const p of promptPaths(prompt)) if (have.has(p)) named.add(p);
  return named;
}

function proximity(filePath, named, edges) {
  if (named.has(filePath)) return 1;
  const mod = moduleOf(filePath);
  let same = 0;
  for (const n of named) {
    if (edges.some((e) => (e.from === n && e.to === filePath) || (e.to === n && e.from === filePath))) return 0.6;
    if (moduleOf(n) === mod) same = 0.3;
  }
  return same;
}

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * @param {{chunks:object[], prompt:string, cosines?:Map<string,number>|null, edges?:object[], files?:object[], weights?:object}} input
 * @returns {object[]} chunks sorted by score, each with score, bm25, cosine, graph, why
 */
function rankChunks({ chunks = [], prompt = '', cosines = null, edges = [], files = [], weights } = {}) {
  const named = namedFiles(prompt, files.length ? files : chunks);
  const scored = score(chunks, prompt);
  const maxB = scored.reduce((m, c) => Math.max(m, c.bm25), 0);
  const hasVec = !!(cosines && (cosines.size || Object.keys(cosines).length));
  const w0 = weightsOf(weights);
  let wb = w0.bm25;
  let wv = hasVec ? w0.vector : 0;
  let wg = w0.graph;
  const sum = wb + wv + wg || 1;
  wb /= sum; wv /= sum; wg /= sum;
  const readCos = (key) => {
    if (!cosines) return 0;
    const raw = typeof cosines.get === 'function' ? cosines.get(key) : cosines[key];
    const n = Number(raw) || 0;
    return n > 0 ? n : 0;
  };
  const out = scored.map((c) => {
    const key = `${c.path}\0${c.chunk_key}`;
    const bNorm = maxB > 0 ? c.bm25 / maxB : 0;
    const cos = readCos(key);
    const graph = proximity(c.path, named, edges);
    const total = wb * bNorm + wv * cos + wg * graph;
    const why = `bm25 ${round4(bNorm)} · vector ${round4(cos)} · graph ${round4(graph)}`;
    return { ...c, score: total, cosine: cos, graph, why };
  });
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start_line - b.start_line);
  return out;
}

module.exports = { rankChunks, namedFiles, proximity, weightsOf };

'use strict';
// Extra ranking signal for the project index. Stored in index_embeddings. Ranking still works when this is off or the model is missing.
const crypto = require('node:crypto');
const cfg = require('../../config');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function store() { return require('../db'); }

function installedName(models, want) {
  return (models || []).some((m) => m.name === want || String(m.name || '').startsWith(`${want}:`));
}

/** Returns number[][] aligned with `texts`, or null when embeddings are off or the model is not installed. */
async function defaultEmbedder(texts) {
  if (!cfg.INDEX_EMBED) return null;
  const ollama = require('../ollama');
  const listed = await ollama.listModels();
  if (!listed.ok || !installedName(listed.models, cfg.INDEX_EMBED_MODEL)) return null;
  const r = await ollama.embed(cfg.INDEX_EMBED_MODEL, texts);
  if (!r.ok) throw new Error(r.message || 'embed failed');
  return r.embeddings;
}

/**
 * Persist vectors for files and folder summaries. Skips rows whose content hash is unchanged.
 * `embedder(texts)` returns one vector per text, or null to skip. A throw leaves the index usable.
 */
async function writeEmbeddings(service, { embedder = defaultEmbedder } = {}) {
  const d = store().db;
  const files = d.prepare('SELECT path, hash FROM index_files WHERE service_id = ? ORDER BY path').all(service.id);
  const symbols = d.prepare('SELECT path, name FROM index_symbols WHERE service_id = ? ORDER BY path, line, name').all(service.id);
  const mods = d.prepare('SELECT module_path, content_hash, summary FROM index_summaries WHERE service_id = ? ORDER BY module_path').all(service.id);
  const names = new Map();
  for (const s of symbols) {
    if (!names.has(s.path)) names.set(s.path, []);
    names.get(s.path).push(s.name);
  }
  const wanted = [];
  for (const f of files) {
    const text = `${f.path}\n${(names.get(f.path) || []).join(' ')}`.slice(0, 2000);
    wanted.push({ kind: 'file', ref: f.path, hash: sha256(`${f.hash}\n${text}`), text });
  }
  for (const m of mods) {
    wanted.push({ kind: 'module', ref: m.module_path, hash: m.content_hash, text: `${m.module_path}\n${m.summary || ''}`.slice(0, 2000) });
  }
  const haveRows = d.prepare('SELECT kind, ref, content_hash FROM index_embeddings WHERE service_id = ?').all(service.id);
  const have = new Map(haveRows.map((r) => [`${r.kind}\n${r.ref}`, r]));
  const live = new Set(wanted.map((w) => `${w.kind}\n${w.ref}`));
  const del = d.prepare('DELETE FROM index_embeddings WHERE service_id = ? AND kind = ? AND ref = ?');
  for (const [key, row] of have) if (!live.has(key)) del.run(service.id, row.kind, row.ref);
  const todo = wanted.filter((w) => {
    const prev = have.get(`${w.kind}\n${w.ref}`);
    return !prev || prev.content_hash !== w.hash;
  });
  if (!todo.length) return { embedded: 0, skipped: false };
  let vectors;
  try { vectors = await embedder(todo.map((t) => t.text)); }
  catch (e) { return { embedded: 0, error: e.message }; }
  if (!vectors) return { embedded: 0, skipped: true };
  if (!Array.isArray(vectors) || vectors.length !== todo.length) return { embedded: 0, error: 'embedder returned the wrong number of vectors' };
  const upsert = d.prepare(`INSERT INTO index_embeddings (service_id, kind, ref, content_hash, vector, model, built_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(service_id, kind, ref) DO UPDATE SET content_hash = excluded.content_hash, vector = excluded.vector, model = excluded.model, built_at = excluded.built_at`);
  const stamp = new Date().toISOString();
  let n = 0;
  for (let i = 0; i < todo.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || !v.length) continue;
    upsert.run(service.id, todo[i].kind, todo[i].ref, todo[i].hash, JSON.stringify(v), cfg.INDEX_EMBED_MODEL, stamp);
    n++;
  }
  return { embedded: n, skipped: false };
}

/** Cosine of the prompt against stored file vectors. Module vectors apply to files in that folder. Null when there is nothing to score. */
async function scoresFor(serviceId, prompt, { embedder = defaultEmbedder } = {}) {
  const d = store().db;
  const rows = d.prepare('SELECT kind, ref, vector FROM index_embeddings WHERE service_id = ?').all(serviceId);
  if (!rows.length) return null;
  let vectors;
  try { vectors = await embedder([String(prompt || '').slice(0, 2000)]); }
  catch { return null; }
  if (!vectors || !Array.isArray(vectors[0])) return null;
  const files = d.prepare('SELECT path FROM index_files WHERE service_id = ?').all(serviceId).map((r) => r.path);
  const out = {};
  for (const row of rows) {
    let vec;
    try { vec = JSON.parse(row.vector); } catch { continue; }
    const c = cosine(vectors[0], vec);
    if (row.kind === 'file') { out[row.ref] = Math.max(out[row.ref] || 0, c); continue; }
    for (const p of files) {
      const dir = p.includes('/') ? p.split('/').slice(0, -1).join('/') : '(root)';
      if (dir === row.ref || dir.startsWith(`${row.ref}/`)) out[p] = Math.max(out[p] || 0, c);
    }
  }
  return out;
}

module.exports = { cosine, writeEmbeddings, scoresFor, defaultEmbedder };

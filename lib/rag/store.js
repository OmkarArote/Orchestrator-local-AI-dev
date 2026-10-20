'use strict';
// Incremental chunk rows. A file is rewritten only when its git blob hash differs or it has no chunks yet.
const crypto = require('node:crypto');
const cfg = require('../../config');
const { chunkText } = require('./chunk');
const { encode } = require('./vectors');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function db() { return require('../db').db; }

/** Paths to rewrite, and chunk paths that are no longer in the index. */
function plan(serviceId, files) {
  const rows = db().prepare('SELECT path, file_hash FROM index_chunks WHERE service_id = ?').all(serviceId);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.path)) by.set(r.path, new Set());
    by.get(r.path).add(r.file_hash);
  }
  const live = new Set(files.map((f) => f.path));
  const remove = [...by.keys()].filter((p) => !live.has(p));
  const rewrite = [];
  for (const f of files) {
    const hashes = by.get(f.path);
    if (!hashes || hashes.size !== 1 || !hashes.has(f.hash)) rewrite.push(f.path);
  }
  return { rewrite, remove };
}

/**
 * Replace chunks for `rows` ({path, hash, text}) and drop `remove` paths.
 * `embedder(texts)` returns one vector per text, or null to skip. A throw keeps the chunks and records `error`.
 */
async function write(serviceId, rows, { remove = [], embedder } = {}) {
  const d = db();
  const delC = d.prepare('DELETE FROM index_chunks WHERE service_id = ? AND path = ?');
  const delV = d.prepare('DELETE FROM index_chunk_vectors WHERE service_id = ? AND path = ?');
  const ins = d.prepare(`INSERT INTO index_chunks (service_id, path, chunk_key, kind, name, start_line, end_line, file_hash, content_hash, text)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const pending = [];
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const p of remove) { delC.run(serviceId, p); delV.run(serviceId, p); }
    for (const row of rows) {
      delC.run(serviceId, row.path);
      delV.run(serviceId, row.path);
      for (const c of chunkText(row.text || '', row.path)) {
        const contentHash = sha256(c.text);
        ins.run(serviceId, row.path, c.chunk_key, c.kind, c.name, c.start_line, c.end_line, row.hash, contentHash, c.text);
        pending.push({ path: row.path, chunk_key: c.chunk_key, content_hash: contentHash, text: c.text.slice(0, 2000) });
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* none */ }
    throw e;
  }
  if (!pending.length) return { chunks: 0, embedded: 0, skipped: false };
  const embed = embedder || require('../index/embed').defaultEmbedder;
  let vectors;
  try { vectors = await embed(pending.map((p) => p.text)); }
  catch (e) { return { chunks: pending.length, embedded: 0, error: e.message }; }
  if (!vectors) return { chunks: pending.length, embedded: 0, skipped: true };
  if (!Array.isArray(vectors) || vectors.length !== pending.length) return { chunks: pending.length, embedded: 0, error: 'embedder returned the wrong number of vectors' };
  const upsert = d.prepare(`INSERT INTO index_chunk_vectors (service_id, path, chunk_key, content_hash, dim, vector, model, built_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(service_id, path, chunk_key) DO UPDATE SET content_hash = excluded.content_hash, dim = excluded.dim, vector = excluded.vector, model = excluded.model, built_at = excluded.built_at`);
  const stamp = new Date().toISOString();
  let n = 0;
  for (let i = 0; i < pending.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || !v.length) continue;
    upsert.run(serviceId, pending[i].path, pending[i].chunk_key, pending[i].content_hash, v.length, encode(v), cfg.INDEX_EMBED_MODEL, stamp);
    n++;
  }
  return { chunks: pending.length, embedded: n, skipped: false };
}

function listChunks(serviceId) {
  return db().prepare('SELECT path, chunk_key, kind, name, start_line, end_line, file_hash, content_hash, text FROM index_chunks WHERE service_id = ? ORDER BY path, start_line, chunk_key').all(serviceId);
}

function listVectors(serviceId) {
  return db().prepare('SELECT path, chunk_key, content_hash, dim, vector, model FROM index_chunk_vectors WHERE service_id = ?').all(serviceId);
}

module.exports = { plan, write, listChunks, listVectors };

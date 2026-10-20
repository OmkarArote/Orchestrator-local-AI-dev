'use strict';
// Result cache. Key is the hash of the task text and the commit SHA. Kinds: retrieval, decision, plan.
const crypto = require('node:crypto');
const store = require('../db');

function hash(text, sha) {
  return crypto.createHash('sha256').update(`${sha || ''}\n${text || ''}`).digest('hex');
}

function get(serviceId, kind, keyHash) {
  if (!serviceId || !kind || !keyHash) return null;
  const row = store.db.prepare('SELECT payload, created_at FROM flow_cache WHERE service_id = ? AND kind = ? AND key_hash = ?').get(serviceId, kind, keyHash);
  if (!row) return null;
  try { return { payload: JSON.parse(row.payload), created_at: row.created_at }; }
  catch { return null; }
}

function put(serviceId, kind, keyHash, payload) {
  if (!serviceId || !kind || !keyHash) return false;
  const body = JSON.stringify(payload == null ? null : payload);
  store.db.prepare(`INSERT INTO flow_cache (service_id, kind, key_hash, payload, created_at) VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(service_id, kind, key_hash) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`)
    .run(serviceId, kind, keyHash, body);
  return true;
}

module.exports = { hash, get, put };

'use strict';
// READ-ONLY lookups against the public Ollama registry (manifest GET only). Never downloads weights, never POSTs, never sends credentials.
// Used to show the download size of a model before anyone decides to pull it. A failure means "unknown", never "not downloadable".
const cfg = require('../config');
const ollama = require('./ollama');
const { validName } = ollama;

const cache = new Map(); // name -> {at, v}
const TTL = 24 * 60 * 60 * 1000;

/** 'qwen2.5-coder:7b' -> {repo:'library/qwen2.5-coder', tag:'7b'}; 'user/model:tag' -> {repo:'user/model', tag} */
function splitName(name) {
  const [path, tag = 'latest'] = name.split(/:(?=[^/]*$)/);
  return { repo: path.includes('/') ? path : `library/${path}`, tag };
}

async function verify(name, { fresh = false } = {}) {
  if (!validName(name)) return { ok: false, code: 'invalid_name', message: `invalid model name '${String(name).slice(0, 60)}'` };
  const hit = cache.get(name);
  if (!fresh && hit && Date.now() - hit.at < TTL) return { ...hit.v, cached: true };
  const { repo, tag } = splitName(name);
  const base = cfg.OLLAMA_REGISTRY.replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base) && !ollama.isLoopback(base)) return { ok: false, code: 'blocked', message: 'registry URL must be https (or loopback for tests)' };
  const url = `${base}/v2/${repo}/manifests/${encodeURIComponent(tag)}`;
  let res;
  try { res = await fetch(url, { method: 'GET', headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch (e) { return { ok: false, code: 'unreachable', message: `cannot verify: registry not reachable (${e.cause && e.cause.code ? e.cause.code : e.message})` }; }
  if (res.status === 404) { const v = { ok: true, exists: false, name, message: 'not found in the registry' }; cache.set(name, { at: Date.now(), v }); return v; }
  if (!res.ok) return { ok: false, code: `http_${res.status}`, message: `cannot verify: registry answered HTTP ${res.status}` };
  let m; try { m = JSON.parse(await res.text()); } catch { return { ok: false, code: 'bad_json', message: 'cannot verify: registry returned invalid JSON' }; }
  const layers = Array.isArray(m.layers) ? m.layers : [];
  const model = layers.find((l) => /image\.model$/.test(l.mediaType || ''));
  const total = layers.reduce((a, l) => a + (Number.isFinite(l.size) ? l.size : 0), 0) + (m.config && Number.isFinite(m.config.size) ? m.config.size : 0);
  const v = { ok: true, exists: true, name, weights_bytes: model ? model.size : null, total_bytes: total || null, layers: layers.length, digest: model ? model.digest : null, verified_at: new Date().toISOString() };
  cache.set(name, { at: Date.now(), v });
  return v;
}

module.exports = { verify, splitName, clearCache: () => cache.clear() };

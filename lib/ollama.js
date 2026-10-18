'use strict';
// The ONLY module that talks to Ollama (grep-guarded). Native HTTP API, global fetch, no dependencies.
// Every call resolves to { ok:true, ... } or { ok:false, code, message } - it never throws into callers.
//   codes: unreachable | timeout | http_<n> | bad_json | blocked | disabled | invalid_name | aborted
const cfg = require('../config');

const NAME_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,2}(:[A-Za-z0-9._-]+)?$/;
const validName = (n) => typeof n === 'string' && n.length <= 128 && NAME_RE.test(n);
const isLoopback = (u) => { try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ''); return ['127.0.0.1', '::1', 'localhost'].includes(h); } catch { return false; } };

function createAdapter({ base = cfg.OLLAMA_API_BASE, allowRemote = cfg.OLLAMA_ALLOW_REMOTE, allowPull = () => cfg.ALLOW_MODEL_PULL } = {}) {
  const baseUrl = String(base).replace(/\/+$/, '');
  const blocked = !allowRemote && !isLoopback(baseUrl);
  const cache = { tags: null, show: new Map() };

  /** One HTTP call. opts: body, timeoutMs, signal, raw (return Response for streaming) */
  async function call(method, path, { body, timeoutMs = 10000, signal, raw = false } = {}) {
    if (blocked) return { ok: false, code: 'blocked', message: `Ollama URL ${baseUrl} is not a loopback address (set ORCH_OLLAMA_ALLOW_REMOTE=1 to allow it)` };
    const sigs = [AbortSignal.timeout(timeoutMs)]; if (signal) sigs.push(signal);
    let res;
    try {
      res = await fetch(baseUrl + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.any(sigs) });
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, code: 'aborted', message: 'aborted' };
      if (e.name === 'TimeoutError') return { ok: false, code: 'timeout', message: `timeout after ${Math.round(timeoutMs / 1000)}s` };
      return { ok: false, code: 'unreachable', message: `Ollama not reachable at ${baseUrl}: ${e.cause && e.cause.code ? e.cause.code : e.message}` };
    }
    if (raw && res.ok) return { ok: true, res };
    let text = '';
    try { text = await res.text(); } catch (e) { return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : 'unreachable', message: e.message }; }
    if (!res.ok) { let m = text.slice(0, 300); try { const j = JSON.parse(text); if (j && j.error) m = String(j.error).slice(0, 300); } catch { /* keep text */ } return { ok: false, code: `http_${res.status}`, status: res.status, message: m, text: text.slice(0, 300) }; }
    let json; try { json = text ? JSON.parse(text) : {}; } catch { return { ok: false, code: 'bad_json', message: 'Ollama returned invalid JSON', text: text.slice(0, 300) }; }
    return { ok: true, status: res.status, json };
  }

  const version = async () => { const r = await call('GET', '/api/version', { timeoutMs: 3000 }); return r.ok ? { ok: true, version: r.json.version || null } : r; };
  const isReachable = async () => (await version()).ok;

  const ctxOf = (info) => { if (!info || typeof info !== 'object') return null; for (const [k, v] of Object.entries(info)) if (/\.context_length$/.test(k) && Number.isFinite(v)) return v; return null; };
  const normModel = (m) => ({
    name: m.name || m.model, size: m.size ?? null, digest: m.digest || null, modified_at: m.modified_at || null,
    family: (m.details && m.details.family) || null, parameter_size: (m.details && m.details.parameter_size) || null, quantization: (m.details && m.details.quantization_level) || null,
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : null, context_length: Number.isFinite(m.context_length) ? m.context_length : null,
  });

  /** Installed models (GET /api/tags). capabilities/context_length may be null on old Ollama versions: call show() for those. */
  async function listModels({ fresh = false } = {}) {
    if (!fresh && cache.tags && Date.now() - cache.tags.at < 3000) return cache.tags.v;
    const r = await call('GET', '/api/tags', { timeoutMs: 8000 });
    if (!r.ok) return r;
    if (!r.json || !Array.isArray(r.json.models)) return { ok: false, code: 'bad_json', message: "/api/tags reply has no 'models' array" };
    const v = { ok: true, models: r.json.models.map(normModel) };
    cache.tags = { at: Date.now(), v };
    return v;
  }

  /** POST /api/show -> {capabilities, context_length, parameters{}, thinking_values, details, requires}. Cached per name+digest. */
  async function show(name, { fresh = false } = {}) {
    if (!validName(name)) return { ok: false, code: 'invalid_name', message: `invalid model name '${String(name).slice(0, 60)}'` };
    const hit = cache.show.get(name);
    if (!fresh && hit && Date.now() - hit.at < 60000) return hit.v;
    const r = await call('POST', '/api/show', { body: { model: name }, timeoutMs: 15000 });
    if (!r.ok) return r;
    const j = r.json || {};
    const params = {};
    for (const line of String(j.parameters || '').split('\n')) { const m = line.trim().match(/^(\w+)\s+(.+)$/); if (m && !(m[1] in params)) params[m[1]] = /^-?\d+(\.\d+)?$/.test(m[2]) ? Number(m[2]) : m[2].replace(/^"|"$/g, ''); }
    const v = { ok: true, name, capabilities: Array.isArray(j.capabilities) ? j.capabilities : [], context_length: ctxOf(j.model_info), parameters: params,
      thinking_values: j.thinking && Array.isArray(j.thinking.values) ? j.thinking.values : null, details: j.details || {}, requires: j.requires || null, family: (j.details && j.details.family) || null };
    cache.show.set(name, { at: Date.now(), v });
    return v;
  }

  async function ps() {
    const r = await call('GET', '/api/ps', { timeoutMs: 5000 });
    if (!r.ok) return r;
    return { ok: true, models: ((r.json && r.json.models) || []).map((m) => ({ name: m.name || m.model, size: m.size ?? null, size_vram: m.size_vram ?? null, expires_at: m.expires_at || null })) };
  }

  /** Chat/generate for llm.js. api: 'ollama' (/api/chat) | 'openai' (/v1/chat/completions). Body is passed through unchanged. */
  async function chat(api, body, { timeoutMs = 120000 } = {}) {
    const r = await call('POST', api === 'ollama' ? '/api/chat' : '/v1/chat/completions', { body, timeoutMs });
    if (!r.ok) return r;
    const j = r.json;
    if (api === 'ollama') return { ok: true, content: (j.message && j.message.content) || '', prompt_tokens: j.prompt_eval_count, completion_tokens: j.eval_count };
    return { ok: true, content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', prompt_tokens: (j.usage || {}).prompt_tokens, completion_tokens: (j.usage || {}).completion_tokens };
  }

  // ---- DISABLED unless ORCH_ALLOW_MODEL_PULL=1 (opt-in). Never called by any default code path.
  const disabled = (what) => ({ ok: false, code: 'disabled', message: `${what} is disabled (ORCH_ALLOW_MODEL_PULL=0): downloads disabled - enable later` });

  /** POST /api/pull streaming NDJSON. onProgress({status, digest, total, completed, percent}). abort via signal. Resolves {ok} | {ok:false, code, message}. */
  async function pull(name, { onProgress, signal, timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
    if (!allowPull()) return disabled('model pull');
    if (!validName(name)) return { ok: false, code: 'invalid_name', message: `invalid model name '${String(name).slice(0, 60)}'` };
    const r = await call('POST', '/api/pull', { body: { model: name, stream: true }, timeoutMs, signal, raw: true });
    if (!r.ok) return r;
    let buf = '', last = null;
    try {
      const reader = r.res.body.getReader(); const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) return { ok: false, code: 'pull_failed', message: String(j.error).slice(0, 300) };
          last = j;
          if (onProgress) onProgress({ status: j.status, digest: j.digest || null, total: j.total ?? null, completed: j.completed ?? null, percent: j.total ? Math.min(100, Math.round(100 * (j.completed || 0) / j.total)) : null });
        }
      }
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, code: 'aborted', message: 'pull cancelled' };
      return { ok: false, code: e.name === 'TimeoutError' ? 'timeout' : 'unreachable', message: e.message };
    }
    cache.tags = null; cache.show.delete(name);
    return last && last.status === 'success' ? { ok: true } : { ok: false, code: 'incomplete', message: `pull ended without success (last status: ${last ? last.status : 'none'})` };
  }

  async function deleteModel(name) {
    if (!allowPull()) return disabled('model delete');
    if (!validName(name)) return { ok: false, code: 'invalid_name', message: `invalid model name '${String(name).slice(0, 60)}'` };
    const r = await call('DELETE', '/api/delete', { body: { model: name }, timeoutMs: 30000 });
    cache.tags = null; cache.show.delete(name);
    return r.ok ? { ok: true } : r;
  }

  return { baseUrl, blocked, version, isReachable, listModels, show, ps, chat, pull, deleteModel, validName, clearCache: () => { cache.tags = null; cache.show.clear(); } };
}

const adapter = createAdapter();
module.exports = { ...adapter, createAdapter, validName, NAME_RE, isLoopback };

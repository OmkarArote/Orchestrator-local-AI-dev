'use strict';
// Tiny client for the local Ollama model (free, on this Mac). Calls are serialised (one at a time) so the router / memory
// proposals never pile up on the GPU next to aider. All HTTP goes through lib/ollama.js (the only module that talks to Ollama).
const cfg = require('../config');
const ollama = require('./ollama');

let chain = Promise.resolve();
const serialise = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

/** Pull a JSON object out of a model reply (handles ```json fences and leading/trailing prose). */
function extractJson(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return { json: JSON.parse(s) }; } catch { /* try slice */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return { json: JSON.parse(s.slice(a, b + 1)) }; } catch (e) { return { error: `invalid JSON: ${e.message}` }; } }
  return { error: 'no JSON object in reply' };
}

/**
 * Request body for a JSON-answer chat. Exported for tests (request bodies must stay identical when no role overrides are configured).
 * api: 'openai' (/v1/chat/completions, thinking off via reasoning_effort=none) or 'ollama' (native /api/chat, think:false, explicit num_ctx).
 */
function buildBody({ system, user, api, model = cfg.LLM_MODEL, numCtx = cfg.MEMORY_NUM_CTX, maxTokens = 400, schema = null, options = {} }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const o = options || {}; // validated role options (lib/models.js); empty = identical request to before roles existed
  if (api === 'ollama') {
    const opt = { temperature: 0, num_ctx: numCtx, num_predict: maxTokens };
    for (const k of ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'seed', 'num_predict']) if (o[k] !== undefined) opt[k] = o[k];
    return { model, messages, stream: false, think: o.think !== undefined ? o.think : false, format: schema || 'json', options: opt, keep_alive: cfg.OLLAMA_KEEP_ALIVE };
  }
  // OpenAI-compatible endpoint: only the fields it understands (num_ctx cannot be set through /v1; use api=ollama for that)
  const b = { model, messages, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, reasoning_effort: 'none' };
  if (o.temperature !== undefined) b.temperature = o.temperature;
  if (o.top_p !== undefined) b.top_p = o.top_p;
  if (o.seed !== undefined) b.seed = o.seed;
  if (o.num_predict !== undefined && o.num_predict > 0) b.max_tokens = o.num_predict;
  return b;
}

/** Ask the local model for a JSON answer. Never throws; resolves {ok, json?, raw, error?, prompt_tokens, completion_tokens, ms}. */
function chatJson({ system, user, api = cfg.ROUTER_API, timeoutMs = cfg.ROUTER_TIMEOUT_MS, numCtx = cfg.MEMORY_NUM_CTX, maxTokens = 400, schema = null, model = cfg.LLM_MODEL, options = {} }) {
  return serialise(async () => {
    const t0 = Date.now();
    const body = buildBody({ system, user, api, model, numCtx, maxTokens, schema, options });
    const r = await ollama.chat(api, body, { timeoutMs });
    if (!r.ok) return { ok: false, raw: '', error: r.code === 'timeout' ? r.message : r.code.startsWith('http_') ? `HTTP ${r.status}: ${(r.text || r.message || '').slice(0, 300)}` : r.message, ms: Date.now() - t0 };
    const ex = extractJson(r.content);
    return { ok: !ex.error, json: ex.json, raw: r.content, error: ex.error, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, ms: Date.now() - t0 };
  });
}

module.exports = { chatJson, extractJson, buildBody };

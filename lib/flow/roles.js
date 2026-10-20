'use strict';
// Per-role Ollama options for the local pipeline (docs/TUNING.md).
// A saved model role (dashboard / POST /api/models/roles) WINS field by field; the tuned values below are only the
// fallback for fields the saved role leaves empty. think defaults to false; a saved think:true on the coder or repair
// role is honoured but produces a warning (9B models spent tens of seconds reasoning per edit, tasks #3-#29).
const cfg = require('../../config');

const SAMPLING = { top_p: 0.9, top_k: 20, repeat_penalty: 1.05 };
// pipeline role -> saved model role (lib/models.js ROLES). The reader has no saved role yet.
const DB_ROLE = { planner: 'planning', coder: 'coding', repair: 'debugging', review: 'review', merge: 'coding' };
const OPTION_KEYS = ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_predict', 'seed'];

function table() {
  const ctx = cfg.LOCAL_NUM_CTX;
  return {
    reader: { num_ctx: 8192, num_predict: 512, temperature: 0.1, seed: 42, ...SAMPLING },
    planner: { num_ctx: Math.min(12288, ctx), num_predict: 1536, temperature: 0.2, seed: 42, ...SAMPLING },
    coder: { num_ctx: ctx, num_predict: cfg.LOCAL_NUM_PREDICT, temperature: 0.1, seed: 42, ...SAMPLING },
    repair: { num_ctx: ctx, num_predict: cfg.LOCAL_NUM_PREDICT, temperature: 0.3, seed: 7, top_p: 0.95, top_k: 20, repeat_penalty: 1.0 },
    review: { num_ctx: Math.min(12288, ctx), num_predict: 1024, temperature: 0.2, seed: 42, ...SAMPLING },
    merge: { num_ctx: ctx, num_predict: cfg.LOCAL_NUM_PREDICT, temperature: 0, seed: 42, ...SAMPLING },
  };
}

const ROLES = Object.keys(table());

/** The saved role row ({ model, options, source }) for a pipeline role, or null (no DB role, unknown role, or no DB in reach). */
function saved(role) {
  const r = DB_ROLE[role];
  if (!r) return null;
  try {
    const e = require('../models').effective(r);
    return e && e.source === 'role' ? e : null;
  } catch { return null; }
}

/** Ollama `options` for a role: saved role values win, tuned fallback fills the gaps. Unknown role -> coder. `think` is not in here (see thinkFor). */
function optionsFor(role, { savedRole } = {}) {
  const t = table();
  const out = { ...(t[role] || t.coder) };
  const s = savedRole !== undefined ? savedRole : saved(role);
  const o = (s && s.options) || {};
  for (const k of OPTION_KEYS) if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
  return out;
}

/** think for a role: the saved value when set, else false. */
function thinkFor(role, { savedRole } = {}) {
  const s = savedRole !== undefined ? savedRole : saved(role);
  const v = s && s.options ? s.options.think : undefined;
  return v === undefined || v === null || v === '' ? false : v;
}

/** Warning text when the coder or repair role thinks, else null. */
function thinkWarning(role, opts) {
  if (role !== 'coder' && role !== 'repair') return null;
  const v = thinkFor(role, opts);
  if (v === false) return null;
  return `warning: saved '${DB_ROLE[role]}' role has think:${JSON.stringify(v)} - the ${role} will reason before every edit (slow on 9B models, the cause of tasks #3-#29 being cancelled); clear it in Models -> roles unless you want this`;
}

/** Top-level /api/chat fields for a role: options, think, keep_alive. */
function chatFields(role, opts) {
  return { think: thinkFor(role, opts), keep_alive: cfg.OLLAMA_KEEP_ALIVE, options: optionsFor(role, opts) };
}

/** Model for a role: a saved role model wins when installed (or when `installed` is not given); else the chain (repair = second entry). */
function modelFor(role, installed, { savedRole } = {}) {
  const have = new Set(installed || []);
  const s = savedRole !== undefined ? savedRole : saved(role);
  if (s && s.model && s.model !== 'auto' && (!installed || have.has(s.model))) return s.model;
  const chain = (cfg.V2_LOCAL_MODELS || []).filter((m) => !installed || have.has(m));
  if (role === 'repair' && chain.length > 1) return chain[1];
  return chain[0] || null;
}

/** Local fallback chain: saved coder model, saved repair model, then ORCH_V2_LOCAL_MODELS (deduplicated). */
function localChain(installed) {
  const out = [];
  for (const m of [modelFor('coder', installed), modelFor('repair', installed), ...(cfg.V2_LOCAL_MODELS || [])]) if (m && !out.includes(m)) out.push(m);
  return out;
}

module.exports = { ROLES, DB_ROLE, optionsFor, thinkFor, thinkWarning, chatFields, modelFor, localChain };

'use strict';
// Per-role Ollama options for the v2 pipeline (docs/TUNING.md). Thinking is off for every role: the 9B models spent
// tens of seconds reasoning before each edit and those runs were cancelled by hand (tasks #3-#29).
// The coder has a fixed seed so the same step gives the same edit; the repair role uses a different seed so a retry is not a copy.
const cfg = require('../../config');

const SAMPLING = { top_p: 0.9, top_k: 20, repeat_penalty: 1.05 };

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

/** Ollama `options` for a role (a fresh object). Unknown role -> coder. */
function optionsFor(role) {
  const t = table();
  return { ...(t[role] || t.coder) };
}

/** Top-level /api/chat fields for a role: options, think:false, keep_alive. */
function chatFields(role) {
  return { think: false, keep_alive: cfg.OLLAMA_KEEP_ALIVE, options: optionsFor(role) };
}

/** Model for a role: repair uses the second local model in the chain when there is one. */
function modelFor(role, installed) {
  const have = new Set(installed || []);
  const chain = (cfg.V2_LOCAL_MODELS || []).filter((m) => !installed || have.has(m));
  if (role === 'repair' && chain.length > 1) return chain[1];
  return chain[0] || null;
}

module.exports = { ROLES, optionsFor, chatFields, modelFor };

'use strict';
// Model management on top of the Ollama adapter: status, installed list (capabilities), roles + option validation against /api/show,
// catalog with fit classes, and (disabled unless ORCH_ALLOW_MODEL_PULL=1) pull/delete orchestration. Nothing here downloads by itself.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('../config');
const store = require('./db');
const ollama = require('./ollama');
const registry = require('./registry');
const jobs = require('./jobs');
const select = require('./model-select');
const { bad, conflict, forbidden } = require('./errors');

// 'embedding' is allowed by the DB schema (v5) but deliberately NOT listed here until something consumes it (M6)
const ROLES = ['coding', 'planning', 'requirements', 'review', 'debugging', 'documentation', 'routing', 'memory', 'chat', 'image', 'video', 'audio', 'document'];
// which roles have a local consumer today (the others are stored/validated only: plan/review run on Cursor)
const CONSUMERS = { coding: 'aider (local engine)', routing: 'task router', memory: 'memory proposals', chat: 'dashboard chat', image: 'image questions (vision, else tesseract text)', video: 'video frames', audio: 'whisper tool preset', document: 'long-document answers' };
const OPTION_KEYS = ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_predict', 'seed', 'think'];
const CTX_WARN = 16384, CTX_MAX = 32768;

function diskFreeBytes() {
  if (process.env.ORCH_TEST_DISK_FREE !== undefined && process.env.NODE_ENV !== 'production') return Number(process.env.ORCH_TEST_DISK_FREE);
  for (const p of [path.join(os.homedir(), '.ollama'), os.homedir()]) {
    try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { /* next */ }
  }
  return null;
}
const stripPrefix = (m) => String(m || '').replace(/^ollama(_chat)?\//, '');

// ------------------------------------------------------------------ status / installed
async function status() {
  const v = await ollama.version();
  return {
    reachable: v.ok, version: v.ok ? v.version : null, error: v.ok ? null : { code: v.code, message: v.message },
    base_url: ollama.baseUrl, loopback_only: !cfg.OLLAMA_ALLOW_REMOTE, blocked: ollama.blocked,
    ram_bytes: os.totalmem(), disk_free_bytes: diskFreeBytes(), pull_enabled: cfg.ALLOW_MODEL_PULL,
    pull_note: cfg.ALLOW_MODEL_PULL ? null : 'downloads disabled - enable later',
    default_model: defaultModel().model, default_source: defaultModel().source, coding_model: effective('coding').model,
  };
}

/** Installed models with capabilities/context_length (falling back to /api/show when /api/tags lacks them) + loaded flag + roles using each. */
async function installed({ fresh = false } = {}) {
  const l = await ollama.listModels({ fresh });
  if (!l.ok) return l;
  const ps = await ollama.ps();
  const loaded = new Set(ps.ok ? ps.models.map((m) => m.name) : []);
  const eff = ROLES.map((r) => [r, effective(r)]);
  const dm = defaultModel();
  const models = [];
  for (const m of l.models) {
    let { capabilities, context_length } = m, parameters = null, thinking_values = null, show_error = null;
    const s = await ollama.show(m.name, { fresh });
    if (s.ok) { capabilities = capabilities || s.capabilities; context_length = context_length || s.context_length; parameters = s.parameters; thinking_values = s.thinking_values; }
    else show_error = s.message;
    const in_use_by = eff.filter(([, e]) => e.model === m.name).map(([r, e]) => ({ role: r, source: e.source }));
    const running = ps.ok ? ps.models.find((x) => x.name === m.name) || null : null; // 'running now' details (ctx in use, GPU share, expiry)
    models.push({ ...m, capabilities: capabilities || [], context_length: context_length || null, defaults: parameters, thinking_values, show_error, loaded: loaded.has(m.name), running, in_use_by, is_default: dm.model === m.name });
  }
  return { ok: true, models, loaded: ps.ok ? ps.models : [] };
}

// ------------------------------------------------------------------ roles
function defaultModel() {
  const kv = store.kvGet('ollama.default_model');
  if (kv) return { model: kv, source: 'setting' };
  return { model: cfg.LLM_MODEL, source: 'config' };
}
/** Synchronous (DB only, no network): what a consumer of `role` should use right now. */
function effective(role) {
  if (!ROLES.includes(role)) throw bad(`unknown role '${role}' (roles: ${ROLES.join(', ')})`);
  const row = store.listModelRoles().find((r) => r.role === role);
  if (row) return { role, model: row.model, options: row.options || {}, source: 'role', updated_at: row.updated_at };
  if (role === 'audio') return { role, model: 'whisper', options: {}, source: 'config' };
  const kv = store.kvGet('ollama.default_model');
  if (kv) return { role, model: kv, options: {}, source: 'setting' };
  if (role === 'coding') return { role, model: stripPrefix(cfg.MODEL), options: {}, source: 'config' };
  return { role, model: cfg.LLM_MODEL, options: {}, source: 'config' };
}

/** Async choice for a role. `effective()` stays synchronous. 'auto' is resolved here and never pulls. routing and memory stay on their fixed model. */
async function resolve(role, ctx = {}) {
  if (!ROLES.includes(role)) throw bad(`unknown role '${role}' (roles: ${ROLES.join(', ')})`);
  const e = effective(role);
  const blank = { score_table: [], alternatives: [], swap: { needed: false, from: null, to: null, est_ms: null }, fit: null, warnings: [], missing: null, suggestion: null };
  if (role === 'routing' || role === 'memory') return { ...e, ...blank, rule: 'explicit', reason: [`${role} stays on its fixed model`] };
  if (ctx.explicit && ctx.explicit !== 'auto') return { role, model: ctx.explicit, source: 'explicit', ...blank, rule: 'explicit', reason: [`explicit choice ${ctx.explicit}`] };
  const wantAuto = ctx.conversationModel === 'auto' || e.model === 'auto';
  if (!wantAuto) return { ...e, ...blank, rule: 'explicit', reason: [`${role} role is ${e.model}`] };
  const inst = await installed({ fresh: true });
  if (!inst.ok) return { role, model: null, source: 'auto', ...blank, rule: 'none', reason: [`Ollama is not reachable (${inst.message})`] };
  const cat = loadCatalog();
  const byName = new Map(cat.models.map((m) => [m.name, m]));
  const installedModels = inst.models.map((m) => {
    const c = byName.get(m.name) || {};
    const bytes = m.size || (c.weights_gb ? Math.round(c.weights_gb * 1e9) : 0);
    return { name: m.name, capabilities: m.capabilities || [], context_length: m.context_length, weights_gb: c.weights_gb || (m.size ? m.size / 1e9 : null), strengths: c.strengths || [], fit: fitClass(bytes) };
  });
  const loadMs = {};
  for (const m of installedModels) { const v = Number(store.kvGet(`ollama.load_ms.${m.name}`)); if (Number.isFinite(v) && v > 0) loadMs[m.name] = v; }
  const suggestions = cat.models.filter((m) => !installedModels.some((i) => i.name === m.name)).map((m) => ({ name: m.name, weights_gb: m.weights_gb, capabilities_expected: m.capabilities_expected || [] }));
  const sel = select.selectModel({
    taskKind: ctx.taskKind || (role === 'coding' ? 'code_edit' : 'chat_text'),
    needs: ctx.needs || {}, difficulty: ctx.difficulty || 'simple', installed: installedModels,
    loaded: (inst.loaded || []).map((m) => m.name),
    roles: { role: e.model === 'auto' ? null : e.model, default: defaultModel().model },
    prefs: { taskRunning: !!ctx.taskRunning, ramBytes: os.totalmem(), loadMs, suggestions },
  });
  return { role, source: 'auto', options: e.options || {}, ...sel };
}

function noteLoadMs(model, ms) {
  if (!model || !Number.isFinite(ms) || ms <= 0) return;
  store.kvSet(`ollama.load_ms.${model}`, String(Math.round(ms)));
}
/** The model argument for aider: unchanged config value unless a role/default was set explicitly. */
function aiderModelArg() {
  const e = effective('coding');
  if (e.model === 'auto') return cfg.MODEL; // the live choice is models.resolve(); this sync label stays the configured model
  return e.source === 'config' ? cfg.MODEL : `ollama_chat/${e.model}`;
}
/** Contents of aider's --model-settings-file for the coding role's options, or null (nothing configured = no file = aider default behaviour). */
function aiderSettingsYaml() {
  const e = effective('coding');
  const o = e.options || {};
  const keys = ['num_ctx', 'temperature', 'top_p', 'top_k', 'repeat_penalty', 'num_predict', 'seed'].filter((k) => o[k] !== undefined);
  if (!keys.length) return null;
  const name = e.source === 'config' ? cfg.MODEL : `ollama_chat/${e.model}`;
  return `- name: ${name}\n  extra_params:\n${keys.map((k) => `    ${k}: ${Number(o[k])}`).join('\n')}\n`;
}

function listRoles() {
  return ROLES.map((r) => ({ ...effective(r), consumer: CONSUMERS[r] || null, wired: !!CONSUMERS[r] }));
}

const isInt = (v) => Number.isInteger(v);
/**
 * Validate a model + options for a role against the REAL installed model (/api/tags + /api/show). Returns {ok, errors[], warnings[], options, model_info}.
 * Never saves anything.
 */
async function validateRole(role, model, options = {}, { allowLargeCtx = false } = {}) {
  const errors = [], warnings = [];
  if (!ROLES.includes(role)) return { ok: false, errors: [`unknown role '${role}' (roles: ${ROLES.join(', ')})`], warnings, options: {} };
  if (model === 'auto') {
    if (role === 'routing' || role === 'memory') return { ok: false, errors: ["'auto' does not cover the routing or memory roles"], warnings, options: {} };
    const l = await ollama.listModels({ fresh: true });
    const standIn = l.ok ? l.models.find((m) => (m.capabilities || []).includes('completion')) : null;
    if (!standIn) return { ok: true, errors: [], warnings: ["'auto' will be chosen from installed models at use time; nothing is downloaded"], options: {}, model_info: { name: 'auto' } };
    const v = await validateRole(role, standIn.name, options, { allowLargeCtx });
    if (!v.ok) return v;
    return { ...v, warnings: [...v.warnings, `'${role}' is auto: a model is chosen from what is installed when it is used`], model_info: { ...(v.model_info || {}), name: 'auto' } };
  }
  if (typeof model !== 'string' || !ollama.validName(model)) return { ok: false, errors: [`invalid model name '${String(model).slice(0, 60)}'`], warnings, options: {} };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return { ok: false, errors: ['options must be an object'], warnings, options: {} };
  if (role === 'audio') {
    if (model !== 'whisper') return { ok: false, errors: ["the audio role is a tool preset: set the model to 'whisper' (the binary plus a model file you already have), not an Ollama model"], warnings, options: {} };
    const tools = require('./media-tools').detect();
    if (!tools.whisper.found) warnings.push('whisper is not installed; speech stays attached and is reported as transcriber not installed. Install hint: brew install whisper-cpp');
    if (!process.env.ORCH_WHISPER_MODEL) warnings.push('ORCH_WHISPER_MODEL is unset; point it at a ggml file you already have. Nothing is downloaded.');
    return { ok: true, errors: [], warnings, options: {}, model_info: { name: 'whisper', tool: true } };
  }
  const l = await ollama.listModels({ fresh: true });
  if (!l.ok) return { ok: false, errors: [`cannot validate: Ollama ${l.code === 'unreachable' ? 'is not reachable' : 'error'} (${l.message})`], warnings, options: {}, unreachable: true };
  const inst = l.models.find((m) => m.name === model);
  if (!inst) return { ok: false, errors: [`model '${model}' is not installed (installed: ${l.models.map((m) => m.name).join(', ') || 'none'}); downloads are disabled`], warnings, options: {} };
  const s = await ollama.show(model, { fresh: true });
  if (!s.ok) return { ok: false, errors: [`cannot read model details: ${s.message}`], warnings, options: {} };
  const caps = s.capabilities || [], ctx = s.context_length;
  if (!caps.includes('completion')) errors.push(`model '${model}' has no 'completion' capability (capabilities: ${caps.join(', ') || 'none'}); it cannot be used as a text model for role '${role}'`);
  if ((role === 'image' || role === 'video') && !caps.includes('vision')) errors.push(`role '${role}' needs the 'vision' capability from the installed model; '${model}' has ${caps.join(', ') || 'none'}`);
  if (role === 'document' && !(ctx >= 8192)) errors.push(`role 'document' needs context_length >= 8192 (this model has ${ctx || 'unknown'})`);
  const fit = fitClass(inst.size || 0);
  if (role === 'image' || role === 'video' || role === 'document') {
    if (fit === 'too_large') errors.push(`model '${model}' is too large for this machine`);
    if (fit === 'tight') warnings.push(`model '${model}' is a tight fit; keep num_ctx small and do not load another model`);
  }
  const out = {};
  for (const [k, v] of Object.entries(options)) {
    if (!OPTION_KEYS.includes(k)) { errors.push(`unknown option '${k}' (allowed: ${OPTION_KEYS.join(', ')})`); continue; }
    if (v === null || v === undefined || v === '') continue; // empty = use the model's own default
    switch (k) {
      case 'num_ctx':
        if (!isInt(v) || v < 512) { errors.push('num_ctx must be an integer >= 512'); break; }
        if (ctx && v > ctx) { errors.push(`num_ctx ${v} exceeds the model's context length (${ctx})`); break; }
        if (v > CTX_MAX && !allowLargeCtx) { errors.push(`num_ctx ${v} > ${CTX_MAX}: the KV cache would not fit in memory on this Mac (pass allow_large_ctx:true to override)`); break; }
        if (v > CTX_WARN) warnings.push(`num_ctx ${v} > ${CTX_WARN}: large KV cache, may be slow / use a lot of RAM on 16 GB`);
        out[k] = v; break;
      case 'temperature': if (typeof v !== 'number' || v < 0 || v > 2) errors.push('temperature must be a number 0..2'); else out[k] = v; break;
      case 'top_p': if (typeof v !== 'number' || v < 0 || v > 1) errors.push('top_p must be a number 0..1'); else out[k] = v; break;
      case 'top_k': if (!isInt(v) || v < 0) errors.push('top_k must be an integer >= 0'); else out[k] = v; break;
      case 'repeat_penalty': if (typeof v !== 'number' || v < 0.5 || v > 2) errors.push('repeat_penalty must be a number 0.5..2'); else out[k] = v; break;
      case 'num_predict': if (!isInt(v) || (v < 1 && v !== -1) || v > 131072) errors.push('num_predict must be an integer 1..131072 (or -1)'); else out[k] = v; break;
      case 'seed': if (!isInt(v) || v < 0) errors.push('seed must be an integer >= 0'); else out[k] = v; break;
      case 'think':
        if (!caps.includes('thinking')) { errors.push(`'think' is not supported by '${model}' (no 'thinking' capability)`); break; }
        if (typeof v === 'boolean') { out[k] = v; break; }
        if (typeof v === 'string' && Array.isArray(s.thinking_values) && s.thinking_values.includes(v)) { out[k] = v; break; }
        errors.push(`think must be true/false${s.thinking_values ? ` or one of ${s.thinking_values.join('/')}` : ''}`); break;
      default: break;
    }
  }
  if (out.think !== undefined && out.think !== false && (role === 'routing' || role === 'memory')) warnings.push(`role '${role}' expects strict JSON answers; thinking mode makes them slower and can break the format`);
  if (options.think !== undefined && role === 'coding') warnings.push("'think' has no effect for the coding role (aider does not pass it)");
  if (!CONSUMERS[role]) warnings.push(`role '${role}' is stored but has no local consumer yet (planning/review run on Cursor); it is applied when a local feature uses it`);
  return { ok: errors.length === 0, errors, warnings, options: errors.length ? {} : out,
    model_info: { name: model, capabilities: caps, context_length: ctx, defaults: s.parameters, thinking_values: s.thinking_values, size: inst.size } };
}

async function setRole(role, model, options, flags) {
  const v = await validateRole(role, model, options, flags);
  if (!v.ok) throw bad(v.errors.join('; '), { validation: v });
  store.setModelRole(role, model, v.options);
  return { ...effective(role), consumer: CONSUMERS[role] || null, warnings: v.warnings };
}
function clearRole(role) {
  if (!ROLES.includes(role)) throw bad(`unknown role '${role}'`);
  store.clearModelRole(role);
  return effective(role);
}
async function setDefault(model) {
  if (model === null || model === '') { store.kvDel('ollama.default_model'); return defaultModel(); }
  if (model === 'auto') throw bad("'auto' is a role or conversation value, not the global default");
  const v = await validateRole('coding', model, {});
  if (!v.ok) throw bad(v.errors.join('; '), { validation: v });
  store.kvSet('ollama.default_model', model);
  return defaultModel();
}

// ------------------------------------------------------------------ chat defaults + LLM info
const KV_BYTES_PER_ELEMENT = 2; // f16 KV cache (Ollama default)
/**
 * Estimated KV-cache bytes per context token from the /api/show model_info subset (see ollama.js). Only layers with full attention keep a KV cache
 * (hybrid models such as qwen35: block_count / full_attention_interval); bytes = layers * kv_heads * (key_length + value_length) * 2 (f16).
 * An ESTIMATE (excludes recurrent/SSM state and runtime overhead); null when the fields are missing.
 */
function kvBytesPerToken(mi) {
  if (!mi || !Number.isFinite(mi.block_count) || mi.block_count <= 0) return null;
  const avg = (v) => (Array.isArray(v) ? (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null) : v);
  const heads = avg(mi.head_count), kvHeads = avg(mi.head_count_kv) ?? heads;
  if (!Number.isFinite(kvHeads) || kvHeads <= 0) return null;
  let key = mi.key_length, val = mi.value_length ?? mi.key_length;
  if (!Number.isFinite(key) && Number.isFinite(mi.embedding_length) && Number.isFinite(heads) && heads > 0) { key = mi.embedding_length / heads; val = val ?? key; }
  if (!Number.isFinite(key) || !Number.isFinite(val)) return null;
  const layers = Number.isFinite(mi.full_attention_interval) && mi.full_attention_interval > 0 ? Math.floor(mi.block_count / mi.full_attention_interval) : mi.block_count;
  return Math.round(layers * kvHeads * (key + val) * KV_BYTES_PER_ELEMENT);
}

/** What the dashboard chat uses when a conversation does not override it: role `chat` -> else the coding role's model; num_ctx 16384 (one shared value), thinking off. */
function chatDefaults() {
  const row = effective('chat');
  const fromRole = row.source === 'role';
  const model = fromRole ? row.model : effective('coding').model;
  const options = fromRole ? { ...row.options } : {};
  const sampling = {};
  for (const k of ['temperature', 'top_p', 'top_k', 'repeat_penalty', 'seed', 'num_predict']) if (options[k] !== undefined) sampling[k] = options[k];
  return { model, source: fromRole ? 'role:chat' : 'coding role / default model', options, num_ctx: Number.isInteger(options.num_ctx) ? options.num_ctx : cfg.CHAT_NUM_CTX,
    think: options.think !== undefined ? options.think : false, sampling };
}

/** Everything the Chat page's model card shows (read-only; never loads a model): model facts, what is running now, roles using it, KV estimate. */
async function llmInfo(modelName, { numCtx } = {}) {
  const defaults = chatDefaults();
  const name = modelName || defaults.model;
  if (!ollama.validName(name)) throw bad(`invalid model name '${String(name).slice(0, 60)}'`);
  const st = await status();
  const configured = Number.isInteger(numCtx) && numCtx > 0 ? numCtx : defaults.num_ctx;
  const out = { status: { reachable: st.reachable, version: st.version, base_url: st.base_url, error: st.error }, model_name: name, model: null, running: null, ctx: { max: null, configured, in_use: null },
    roles_using: ROLES.map((r) => [r, effective(r)]).filter(([, e]) => e.model === name).map(([r, e]) => ({ role: r, source: e.source })), kv_estimate: null, chat_defaults: defaults };
  if (!st.reachable) return out;
  const l = await ollama.listModels();
  const inst = l.ok ? l.models.find((m) => m.name === name) : null;
  if (!inst) return { ...out, error: l.ok ? `model '${name}' is not installed` : l.message, installed: l.ok ? l.models.map((m) => m.name) : [] };
  const s = await ollama.show(name);
  const ps = await ollama.ps();
  const run = ps.ok ? ps.models.find((m) => m.name === name) || null : null;
  const ctxMax = (s.ok && s.context_length) || inst.context_length || null;
  const perTok = s.ok ? kvBytesPerToken(s.model_info) : null;
  out.model = { name, size: inst.size, family: inst.family, parameter_size: inst.parameter_size, quantization: inst.quantization, capabilities: (s.ok && s.capabilities.length ? s.capabilities : inst.capabilities) || [],
    thinking_values: s.ok ? s.thinking_values : null, sampling_defaults: s.ok ? s.parameters : {}, system: s.ok ? s.system : null, license: s.ok ? s.license_head : null, model_info: s.ok ? s.model_info : null };
  out.running = run;
  out.ctx = { max: ctxMax, configured, in_use: run ? run.context_length : null };
  out.kv_estimate = perTok ? { bytes_per_token: perTok, configured_bytes: perTok * configured, in_use_bytes: run && run.context_length ? perTok * run.context_length : null, note: 'estimate for full-attention layers only (f16 KV cache); verify with `ollama ps`' } : null;
  out.installed = true;
  return out;
}

// ------------------------------------------------------------------ catalog + fit
function fitClass(bytes, ramBytes = os.totalmem()) {
  if (!bytes) return 'unknown';
  if (bytes <= 0.35 * ramBytes) return 'recommended';
  if (bytes <= 0.60 * ramBytes) return 'tight';
  return 'too_large';
}
const FIT_LABEL = { recommended: 'fits comfortably', tight: 'tight: small num_ctx, nothing else loaded', too_large: 'too large for this Mac', unknown: 'size unknown' };

function loadCatalog() { return JSON.parse(fs.readFileSync(path.join(__dirname, 'model-catalog.json'), 'utf8')); }

async function catalog() {
  const cat = loadCatalog();
  const l = await ollama.listModels();
  const have = new Set(l.ok ? l.models.map((m) => m.name) : []);
  const ram = os.totalmem(), free = diskFreeBytes();
  return {
    verified_at: cat.verified_at, note: cat._note, ram_bytes: ram, disk_free_bytes: free,
    download_enabled: cfg.ALLOW_MODEL_PULL, download_note: cfg.ALLOW_MODEL_PULL ? null : 'downloads disabled - enable later',
    models: cat.models.map((m) => {
      const bytes = Math.round(m.weights_gb * 1e9), fit = fitClass(bytes, ram);
      return { name: m.name, kind: m.kind, roles: m.roles, note: m.note, weights_bytes: bytes, weights_gb: m.weights_gb, strengths: m.strengths || [], capabilities_expected: m.capabilities_expected || [], fit, fit_label: FIT_LABEL[fit], installed: have.has(m.name),
        disk_ok: free === null ? null : free >= bytes * 1.25 + 5e9, can_download: cfg.ALLOW_MODEL_PULL && !have.has(m.name) && fit !== 'too_large' && (free === null || free >= bytes * 1.25 + 5e9) };
    }),
  };
}

// ------------------------------------------------------------------ pull / delete (disabled unless ORCH_ALLOW_MODEL_PULL=1)
const DISABLED = 'downloads disabled - enable later (set ORCH_ALLOW_MODEL_PULL=1 and restart)';
async function startPull(name, { confirm_size_bytes } = {}) {
  if (!cfg.ALLOW_MODEL_PULL) throw forbidden(DISABLED, { code: 'disabled' });
  if (!ollama.validName(name)) throw bad(`invalid model name '${String(name).slice(0, 60)}'`);
  if (jobs.running('pull').length) throw conflict('a model download is already running');
  const have = await ollama.listModels({ fresh: true });
  if (have.ok && have.models.some((m) => m.name === name)) throw conflict(`model '${name}' is already installed`);
  const v = await registry.verify(name, { fresh: true });
  if (!v.ok) throw bad(`cannot verify '${name}' in the registry: ${v.message}; nothing was downloaded`, { code: v.code });
  if (!v.exists) throw bad(`'${name}' does not exist in the registry`);
  const size = v.total_bytes || v.weights_bytes;
  if (!Number.isFinite(confirm_size_bytes) || confirm_size_bytes !== size) throw bad(`confirm_size_bytes must echo the verified download size (${size}); you sent ${confirm_size_bytes}`, { verified_bytes: size });
  const fit = fitClass(v.weights_bytes);
  if (fit === 'too_large') throw bad(`'${name}' (${(v.weights_bytes / 1e9).toFixed(1)} GB) is too large for this Mac (${(os.totalmem() / 1e9).toFixed(0)} GB RAM)`);
  const free = diskFreeBytes();
  if (free !== null && free < size * 1.25 + 5e9) throw bad(`not enough free disk: need ~${((size * 1.25 + 5e9) / 1e9).toFixed(1)} GB, have ${(free / 1e9).toFixed(1)} GB`);
  const job = jobs.create('pull', `Download ${name}`, { name, size_bytes: size });
  const ac = new AbortController(); job._cancel = () => ac.abort();
  jobs.start(job); jobs.setPhase(job, 'downloading', 1);
  ollama.pull(name, { signal: ac.signal, onProgress: (p) => { if (p.percent !== null) jobs.setPhase(job, p.status || 'downloading', p.percent); if (p.status && !/^pulling [0-9a-f]{6}/.test(p.status)) jobs.log(job, p.status); } })
    .then((r) => { if (r.ok) jobs.finish(job, 'done', { result: { name } }); else jobs.finish(job, job.cancelled || r.code === 'aborted' ? 'cancelled' : 'failed', { error: r.message, code: r.code }); })
    .catch((e) => jobs.finish(job, 'failed', { error: e.message }));
  return jobs.view(job);
}
async function deleteModel(name, confirm) {
  if (!cfg.ALLOW_MODEL_PULL) throw forbidden(DISABLED, { code: 'disabled' });
  if (!ollama.validName(name)) throw bad('invalid model name');
  if (confirm !== name) throw bad(`confirmation required: send {"confirm": "${name}"}`);
  const users = ROLES.map((r) => effective(r)).filter((e) => e.model === name && e.source !== 'config').map((e) => e.role);
  if (store.kvGet('ollama.default_model') === name) users.push('default');
  if (users.length) throw conflict(`'${name}' is assigned to ${users.join(', ')}; reassign first`);
  if (name === effective('coding').model || name === cfg.LLM_MODEL) throw conflict(`'${name}' is the configured default model; reassign first`);
  const r = await ollama.deleteModel(name);
  if (!r.ok) throw bad(r.message);
  return { deleted: name };
}

module.exports = { status, installed, diskFreeBytes, ROLES, CONSUMERS, OPTION_KEYS, effective, resolve, noteLoadMs, listRoles, validateRole, setRole, clearRole, setDefault, defaultModel,
  aiderModelArg, aiderSettingsYaml, kvBytesPerToken, chatDefaults, llmInfo, catalog, fitClass, startPull, deleteModel, stripPrefix };

'use strict';
// Cursor CLI helpers: cached status/models, and the stream-json -> readable-lines parser.
const { execFile } = require('node:child_process');
const cfg = require('../config');
const { PATH } = require('./proc');

const env = () => ({ ...process.env, PATH, NO_COLOR: '1' });
function exec(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(cfg.CURSOR_BIN, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: env() },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || ''), err: String(stderr || ''), error: err ? err.message : null }));
    if (child.stdin) child.stdin.end(); // same as `< /dev/null`
  });
}

const cache = { status: null, models: null, version: null };
const fresh = (c, ttl) => c && Date.now() - c.at < ttl;

async function getStatus({ force = false } = {}) {
  if (!force && fresh(cache.status, cfg.CURSOR_STATUS_TTL_MS)) return { ...cache.status.v, cached: true };
  const r = await exec(['status', '--format', 'json'], 20000);
  let v;
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.out);
      v = { installed: true, logged_in: !!j.isAuthenticated, email: j.userInfo?.email || null, status: j.status || null };
    } catch { v = { installed: true, logged_in: false, error: 'could not parse `agent status` output' }; }
  } else {
    const missing = /ENOENT/.test(r.error || '');
    v = { installed: !missing, logged_in: false, error: missing ? `${cfg.CURSOR_BIN} not found` : (r.err || r.error || '').trim().slice(0, 300) };
  }
  if (cache.version === null && v.installed) { const ver = await exec(['--version'], 10000); cache.version = ver.code === 0 ? ver.out.trim() : ''; }
  v = { ...v, version: cache.version || null, checked_at: new Date().toISOString() };
  cache.status = { at: Date.now(), v };
  return { ...v, cached: false };
}

/** `agent --list-models` -> [{id, name, default?, current?}] */
function parseModels(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').trim();
    const m = line.match(/^([A-Za-z0-9][\w.\-\[\]=,]*) - (.+)$/);
    if (!m) continue;
    out.push({ id: m[1], name: m[2].replace(/\s+/g, ' ').trim() });
  }
  return out;
}
async function getModels({ force = false } = {}) {
  if (!force && fresh(cache.models, cfg.CURSOR_MODELS_TTL_MS)) return { ...cache.models.v, cached: true };
  const r = await exec(['--list-models'], 45000);
  let v;
  if (r.code === 0) {
    const models = parseModels(r.out);
    v = models.length ? { ok: true, models, checked_at: new Date().toISOString() } : { ok: false, models: [], error: 'no models parsed from `agent --list-models`' };
  } else v = { ok: false, models: [], error: (r.err || r.error || '').trim().slice(0, 300) };
  if (v.ok) cache.models = { at: Date.now(), v };
  return { ...v, cached: false };
}
/** Synchronous peek at the cached model ids (null when never loaded). */
const cachedModelIds = () => (cache.models ? cache.models.v.models.map((m) => m.id) : null);

// ------------------------------------------------------------ stream-json parser
const clip = (s, n = 300) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const TOOL_NAMES = { editToolCall: 'edit', readToolCall: 'read', shellToolCall: 'shell', grepToolCall: 'grep', globToolCall: 'glob', lsToolCall: 'ls', deleteToolCall: 'delete', todoToolCall: 'todo', createPlanToolCall: 'createPlan' };

function describeTool(tc) {
  const key = Object.keys(tc || {}).find((k) => /ToolCall$/.test(k)) || Object.keys(tc || {})[0];
  if (!key) return { name: 'tool', detail: '' };
  const body = tc[key] || {};
  const a = body.args || {};
  const name = TOOL_NAMES[key] || key.replace(/ToolCall$/, '');
  const detail = a.path || a.command || a.pattern || a.globPattern || a.targetDirectory || a.query || '';
  return { name, detail: String(detail), body };
}

/**
 * Stateful parser: feed(rawLine) -> [{kind, message}]. Raw lines are kept elsewhere (log file); this produces
 * the human-readable task_events. Partial text deltas are merged into one line per assistant/thinking segment.
 */
class StreamParser {
  // plan: the full plan body of a `--mode plan` run (createPlan tool args). The final `result` of a plan run is often only the
  // assistant preamble ("I'll trace how ..."), so storing `result` alone lost the plan (swap-relook task #7: 353 chars).
  // fullText: every complete assistant segment, in order (fallback when no createPlan call arrives).
  constructor() { this.text = ''; this.think = ''; this.result = null; this.model = null; this.sessionId = null; this.errors = 0; this.plan = null; this.segments = []; this.deltaSegs = []; }
  get fullText() { return (this.segments.length ? this.segments : this.deltaSegs).join('\n\n').trim(); } // complete segments supersede their deltas
  _flushText() { const t = this.text.trim(); this.text = ''; if (t) this.deltaSegs.push(t); return t ? [{ kind: 'cursor', message: `assistant: ${clip(t, 1500)}` }] : []; }
  _flushThink() { const t = this.think.trim(); this.think = ''; return t ? [{ kind: 'cursor', message: `thinking: ${clip(t, 400)}` }] : []; }
  feed(line) {
    let j;
    try { j = JSON.parse(line); } catch { return [{ kind: 'cursor', message: `(unparsed) ${clip(line, 500)}` }]; }
    const out = [];
    switch (j.type) {
      case 'system':
        if (j.subtype === 'init') { this.model = j.model; this.sessionId = j.session_id; out.push({ kind: 'cursor', message: `session started: model=${j.model} permissionMode=${j.permissionMode} cwd=${j.cwd}` }); }
        break;
      case 'thinking':
        if (j.subtype === 'delta') this.think += j.text || '';
        else if (j.subtype === 'completed') out.push(...this._flushThink());
        break;
      case 'assistant': {
        const t = (j.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        const isDelta = j.timestamp_ms !== undefined && j.model_call_id === undefined;
        if (isDelta) this.text += t;
        else { this.text = ''; if (t.trim()) { this.segments.push(t.trim()); out.push({ kind: 'cursor', message: `assistant: ${clip(t, 1500)}` }); } } // complete segment supersedes its deltas
        break;
      }
      case 'tool_call': {
        out.push(...this._flushThink(), ...this._flushText());
        const { name, detail, body } = describeTool(j.tool_call);
        if (name === 'createPlan') { const p = body && body.args && typeof body.args.plan === 'string' ? body.args.plan : ''; if (p.trim().length >= (this.plan || '').length) this.plan = p.trim() || this.plan; }
        if (name === 'createPlan' && j.subtype === 'started') out.push({ kind: 'cursor', message: `tool createPlan: ${this.plan ? this.plan.length : 0} chars` });
        else if (j.subtype === 'started') out.push({ kind: 'cursor', message: `tool ${name}: ${clip(detail, 200)}` });
        else if (j.subtype === 'completed') {
          const r = body?.result || {};
          if (r.success) {
            const s = r.success;
            const bits = [];
            if (s.linesAdded !== undefined) bits.push(`+${s.linesAdded}/-${s.linesRemoved}`);
            if (s.exitCode !== undefined) bits.push(`exit ${s.exitCode}`);
            out.push({ kind: 'cursor', message: `tool ${name} ok${bits.length ? ' (' + bits.join(', ') + ')' : ''}` });
          } else if (r.error || r.rejected || r.failure) { this.errors++; out.push({ kind: 'error', message: `tool ${name} failed: ${clip(JSON.stringify(r.error || r.rejected || r.failure), 300)}` }); }
          else out.push({ kind: 'cursor', message: `tool ${name} completed` });
        }
        break;
      }
      case 'result': {
        out.push(...this._flushThink(), ...this._flushText());
        this.result = j;
        const u = j.usage || {};
        out.push({ kind: j.is_error ? 'error' : 'cursor', message: `result: ${j.subtype}${j.is_error ? ' (is_error)' : ''} in ${Math.round((j.duration_ms || 0) / 1000)}s; tokens in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'}` });
        break;
      }
      case 'user': break; // echo of our prompt
      default: out.push({ kind: 'cursor', message: `event ${j.type}${j.subtype ? '/' + j.subtype : ''}` });
    }
    return out;
  }
  flush() { return [...this._flushThink(), ...this._flushText()]; }
}

module.exports = { getStatus, getModels, cachedModelIds, StreamParser, parseModels };

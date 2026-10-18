'use strict';
// Task router: local LLM (your local model via Ollama's OpenAI-compatible endpoint) suggests {service, confidence, difficulty, needs_thinking, reason}.
// The reply is schema-validated; invalid / low-confidence -> keyword matching over the service map. The result is only a SUGGESTION:
// the human confirms or overrides it at approve-start (unless the project setting route_apply=auto, which still waits for approve-start).
const cfg = require('../config');
const store = require('./db');
const context = require('./context');
const settings = require('./settings');
const llm = require('./llm');
const models = require('./models');

const DIFFICULTIES = ['simple', 'complex'];
const STOP = new Set('the a an and or of to in on for with from by at as is are be this that it its into out add fix make update change new use using need needs should when then than not no yes all any each per via do does did can will would'.split(' '));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
const words = (s) => (String(s).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w));
const COMPLEX_RE = /\b(refactor\w*|migrat\w*|architect\w*|redesign\w*|design|cross[- ]service|across (?:all |both |multiple |the )?(?:services|modules|packages)|all services|both services|multiple services|end[- ]to[- ]end|security|vulnerab\w*|performance|optimi[sz]\w*|investigate|root cause|debug\w*|intermittent|race condition|concurren\w*|transaction\w*|rewrite|trade-?offs?|strategy|why\b)/i;

/** Hand-written schema check of the model's JSON. Returns {ok, value} or {ok:false, error}. */
function validateRouting(j, services) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: 'reply is not a JSON object' };
  let service = j.service;
  if (service === undefined) return { ok: false, error: "missing 'service'" };
  if (service === null || service === '' || (typeof service === 'string' && /^(none|null|n\/a|unknown|cross-service|multiple)$/i.test(service.trim()))) service = null;
  else if (typeof service !== 'string') return { ok: false, error: "'service' must be a string or null" };
  else {
    const want = service.trim().toLowerCase();
    const hit = services.find((s) => s.name.toLowerCase() === want || s.path.toLowerCase() === want);
    if (!hit) return { ok: false, error: `unknown service '${service}'` };
    service = hit.name;
  }
  let c = j.confidence;
  if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) c = Number(c);
  if (typeof c !== 'number' || !Number.isFinite(c)) return { ok: false, error: "'confidence' must be a number" };
  if (c > 1 && c <= 100) c /= 100;
  if (c < 0 || c > 1) return { ok: false, error: "'confidence' out of range 0..1" };
  const difficulty = typeof j.difficulty === 'string' ? j.difficulty.trim().toLowerCase() : '';
  if (!DIFFICULTIES.includes(difficulty)) return { ok: false, error: "'difficulty' must be simple|complex" };
  let nt = j.needs_thinking;
  if (nt === 'true') nt = true; else if (nt === 'false') nt = false;
  if (typeof nt !== 'boolean') return { ok: false, error: "'needs_thinking' must be boolean" };
  if (typeof j.reason !== 'string' || !j.reason.trim()) return { ok: false, error: "'reason' must be a non-empty string" };
  return { ok: true, value: { service, confidence: Math.round(c * 100) / 100, difficulty, needs_thinking: nt, reason: j.reason.trim().slice(0, 500) } };
}

/** Keyword fallback: score services by overlap of task words with service name/path (x3) and description / map section / notes (x1). */
function keywordRoute(services, title, prompt, mapMd) {
  const taskWords = new Set(words(`${title} ${prompt}`).map(stem));
  const scored = services.map((s) => {
    const nameWords = new Set(words(`${s.name.replace(/[-_.]/g, ' ')} ${s.path.replace(/[\/\-_.]/g, ' ')}`).map(stem));
    const sec = mapMd ? context.sectionFor(mapMd, s.name) : null;
    const descWords = new Set(words(`${s.description} ${s.notes} ${sec ? sec.text.slice(0, 800) : ''}`).map(stem));
    const hits = { name: [], desc: [] };
    for (const w of nameWords) if (taskWords.has(w)) hits.name.push(w);
    for (const w of descWords) if (taskWords.has(w) && !nameWords.has(w)) hits.desc.push(w);
    return { name: s.name, score: hits.name.length * 3 + hits.desc.length, hits };
  }).sort((a, b) => b.score - a.score);
  const [top, second] = [scored[0], scored[1]];
  const mentioned = scored.filter((s) => s.hits.name.length).length;
  const text = `${title} ${prompt}`;
  const complexHit = COMPLEX_RE.test(text) || mentioned >= 2 || text.length > 1500;
  let service = null, confidence = 0, why;
  if (!top || top.score === 0) why = 'no service words matched';
  else if (second && second.score === top.score) { confidence = 0.3; why = `ambiguous: ${top.name} and ${second.name} tie (${top.score})`; }
  else { service = top.name; confidence = Math.min(0.9, 0.4 + 0.5 * (top.score - (second ? second.score : 0)) / top.score); why = `matched ${[...top.hits.name, ...top.hits.desc].join(', ')}`; }
  return { service, confidence: Math.round(confidence * 100) / 100, difficulty: complexHit ? 'complex' : 'simple', needs_thinking: complexHit, reason: `keyword match: ${why}`, scores: scored.slice(0, 5).map((s) => ({ name: s.name, score: s.score })) };
}

function buildPrompt(project, services, mapMd, title, prompt) {
  const names = services.map((s) => s.name);
  const map = mapMd.length > cfg.ROUTER_SERVICES_MAX_CHARS ? mapMd.slice(0, cfg.ROUTER_SERVICES_MAX_CHARS) + '\n[... truncated]' : mapMd;
  const system = `You route software tasks. Reply with ONE JSON object and nothing else:
{"service": <one of ${JSON.stringify(names)} or null>, "confidence": <number 0..1>, "difficulty": "simple"|"complex", "needs_thinking": <true|false>, "reason": "<one short sentence>"}
- service: the single service the task mostly belongs to. Use null if the task spans several services or you cannot tell.
- confidence: how sure you are about the service.
- difficulty: "simple" = small, local, well-specified edit (one function/file, clear expected result). "complex" = touches several files or services, needs investigation, design decisions, debugging an unknown cause, security or performance reasoning.
- needs_thinking: true when the task needs real design thinking or investigation rather than a mechanical edit.
Never invent a service name.`;
  const meta = services.map((s) => `- ${s.name}${s.type && s.type !== 'other' ? ` [${s.type}${s.stack ? '/' + s.stack : ''}]` : ''}${s.path && s.path !== '.' ? ` (subdir ${s.path})` : ''}${s.description ? `: ${String(s.description).slice(0, 200)}` : ''}`).join('\n');
  const user = `PROJECT: ${project.name}${project.description ? ` - ${String(project.description).slice(0, 300)}` : ''}\n\nSERVICES:\n${meta}\n\nSERVICE MAP:\n${map}\n\nTASK TITLE: ${title}\nTASK:\n${String(prompt).slice(0, 3000)}\n\nJSON:`;
  return { system, user };
}

/** Policy: map difficulty/needs_thinking to engine settings (per-project settings override env defaults). */
function policyFor(project, r) {
  const st = settings.effective(project);
  const complex = r.difficulty === 'complex' || r.needs_thinking;
  const engine = complex ? st.complex_engine : st.simple_engine;
  return {
    engine,
    allow_escalation: !complex && engine === 'auto',
    plan_first: complex && engine === 'cursor' && !!st.plan_first_complex,
    rule: complex ? `needs_thinking/complex -> ${engine}${engine === 'cursor' && st.plan_first_complex ? ' (plan first)' : ''}` : `simple -> ${engine}${engine === 'auto' ? ' (local first, escalation allowed)' : ''}`,
  };
}

/** Pure routing computation (no DB writes). */
async function computeRoute({ project, services, title, prompt }) {
  const active = services.filter((s) => !s.archived);
  const mapMd = context.servicesMdEffective(project, services);
  const out = { llm: null, keyword: null, fallback_reason: null };
  const { system, user } = buildPrompt(project, active, mapMd, title, prompt);
  const role = models.effective('routing');
  const r = await llm.chatJson({ system, user, api: cfg.ROUTER_API, maxTokens: 300, model: role.model, options: role.options });
  out.llm = { model: role.model, role_source: role.source, options: role.options, api: cfg.ROUTER_API, ms: r.ms, prompt_tokens: r.prompt_tokens, completion_tokens: r.completion_tokens, raw: String(r.raw || '').slice(0, 1500), error: r.error || null, valid: false };
  let v = null;
  if (r.ok) { const c = validateRouting(r.json, active); if (c.ok) { v = c.value; out.llm.valid = true; } else out.llm.error = `schema: ${c.error}`; }
  out.keyword = keywordRoute(active, title, prompt, mapMd);
  let sug;
  if (v && (v.service === null || v.confidence >= cfg.ROUTER_MIN_CONFIDENCE)) {
    sug = { ...v, source: 'llm' };
  } else {
    out.fallback_reason = v ? `low confidence (${v.confidence} < ${cfg.ROUTER_MIN_CONFIDENCE}) for service '${v.service}'` : out.llm.error || 'llm unavailable';
    const k = out.keyword;
    const complex = k.difficulty === 'complex' || (v && (v.difficulty === 'complex' || v.needs_thinking)); // conservative: either says complex
    sug = { service: k.service, confidence: k.confidence, difficulty: complex ? 'complex' : 'simple', needs_thinking: !!(k.needs_thinking || (v && v.needs_thinking)), reason: `${k.reason}${v ? ` (llm said: ${v.service} @${v.confidence}: ${v.reason})` : ''}`, source: 'keyword' };
  }
  if (!active.length) sug.service = null;
  const svc = sug.service ? active.find((s) => s.name === sug.service) : null;
  sug.service_id = svc ? svc.id : null;
  // multi-service hint: the model (or the keywords) says the task spans several services -> UI offers "create a sequence" (one task per service/repo)
  const kscores = (out.keyword.scores || []).filter((x) => x.score > 0);
  const spansWords = /\b(both|all services|across|cross[- ]service|multiple services|each service|every service|end[- ]to[- ]end)\b/i.test(`${title} ${prompt}`);
  sug.multi_service = active.length > 1 && !svc && (sug.source === 'llm' || (kscores.length >= 2 && spansWords));
  if (sug.multi_service) {
    sug.candidates = kscores.slice(0, 4).map((x) => x.name);
    sug.hint = 'this looks like it touches several services: create a sequence (POST /api/projects/:id/groups, dependency "independent" across repositories) with one step per service instead of one task';
  }
  sug.policy = policyFor(project, sug);
  out.suggestion = sug;
  return out;
}

/** Route a stored task: writes routing_json/routing_state/routing_source + a `route` event; may apply (project route_apply=auto). Never throws. */
async function routeTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) return;
  const ev = (m) => store.addEvent(taskId, 'route', m);
  try {
    const project = store.getProject(task.project_id);
    const services = store.listServices(project.id);
    const req = (task.routing && task.routing.request) || { service: true, engine: true };
    const res = await computeRoute({ project, services, title: task.title, prompt: task.prompt });
    const s = res.suggestion;
    const routing = { request: req, ...res, at: new Date().toISOString() };
    store.updateFields(taskId, { routing_json: JSON.stringify(routing), routing_source: s.source, routing_state: 'done' });
    ev(`routing suggestion (${s.source}${res.fallback_reason ? ', fallback: ' + res.fallback_reason : ''}): service=${s.service || '-'} confidence=${s.confidence} difficulty=${s.difficulty} needs_thinking=${s.needs_thinking}; policy: ${s.policy.rule}; reason: ${s.reason}`);
    if (res.llm) ev(`llm: ${res.llm.model} via ${res.llm.api} in ${res.llm.ms}ms, prompt_tokens=${res.llm.prompt_tokens ?? '?'}${res.llm.error ? ', problem: ' + res.llm.error : ''}`);
    if (settings.effective(project).route_apply === 'auto') {
      const f = applySuggestion(task, routing, req);
      if (Object.keys(f).length) { store.updateFields(taskId, f); ev(`route_apply=auto: suggestion applied to the task (${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(', ')}); it still needs your approve-start`); }
    }
  } catch (e) {
    store.updateFields(taskId, { routing_state: 'failed' });
    ev(`routing failed: ${e.message}`);
  }
}

/** Fields to set on a task from a routing suggestion, honouring which dimensions were requested. */
function applySuggestion(task, routing, req = routing.request || { service: true, engine: true }) {
  const s = routing.suggestion, f = {};
  if (req.service) f.service_id = s.service_id || null;
  if (req.engine) {
    f.engine = s.policy.engine; f.allow_escalation = s.policy.allow_escalation; f.plan_first = s.policy.plan_first && s.policy.engine === 'cursor';
    if (s.policy.engine !== 'local' && !task.model) f.model = cfg.CURSOR_MODEL;
  }
  return f;
}

module.exports = { computeRoute, routeTask, applySuggestion, policyFor, validateRouting, keywordRoute };

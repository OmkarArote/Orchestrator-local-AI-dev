'use strict';
// Cross-repo Features (M5): a thin parent over a task_group (gate 'contract') whose steps live in different projects/services.
//   provider step (1) -> contract artifact -> consumer steps (2..n); every step is an ordinary task that keeps ALL existing gates
//   (start approval, plan-first, escalation, human merge). Nothing here starts, merges or pushes anything by itself.
// Contract-first: an `api_contract` artifact must be APPROVED by a human before any step may run. When the provider reaches review a
//   deterministic `api_actual` is extracted from its diff (no LLM) and compared with the contract; a difference is a *drift* that a human
//   must accept (promotes the actual to the contract) before consumers start. Consumers get the contract (+ the provider's actual) in
//   their context bundle. Merge order: a consumer cannot be merged before its provider is merged; the only way around is a typed reason
//   that is recorded in task_artifacts (kind 'notes') + approvals + events.
const crypto = require('node:crypto');
const store = require('./db');

const MAX_STEPS = 8;
const MAX_CONTRACT = 40000;
const MIN_OVERRIDE_REASON = 8;
const FINISHED = ['done', 'failed', 'rejected'];
const ACTIVE = ['awaiting_approval', 'approved', 'running', 'checking', 'awaiting_plan', 'awaiting_escalation'];

class FeatureError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || null; } }
const bad = (m) => new FeatureError(400, m);
const conflict = (m, extra) => new FeatureError(409, m, extra);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} chars]` : s);

// ---------------------------------------------------------------- contract extraction (deterministic, from the provider's diff)
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const normPath = (p) => {
  let x = String(p).trim().split('?')[0].replace(/:[A-Za-z_][\w]*/g, '{}').replace(/\{[^}/]*\}/g, '{}').replace(/<[^>/]*>/g, '{}');
  if (x.length > 1) x = x.replace(/\/+$/, '');
  return x.replace(/\/{2,}/g, '/');
};
const endpointKey = (e) => `${e.method} ${normPath(e.path)}`;

/** Split a unified diff into [{file, added: [lines]}]. */
function diffFiles(diff) {
  const files = [];
  let cur = null;
  for (const line of String(diff).split('\n')) {
    const h = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (h) { cur = { file: h[2], added: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return files;
}

const RE_EXPRESS = /\b(?:app|router|server|api|fastify|route|routes|r|bp|blueprint)\w*\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])(\/[^'"`]*)\2/i;
const RE_PYDEC = /@\s*\w+\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*(['"])(\/[^'"]*)\2([^)]*)/i;
const RE_SPRING = /@\s*(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?\{?\s*"([^"]*)"/;
const RE_GO = /\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"(\/[^"]*)"/;
const RE_NEXT = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/;

function endpointsOfLine(line) {
  const out = [];
  let m;
  if ((m = line.match(RE_EXPRESS))) out.push({ method: m[1].toUpperCase(), path: m[3] });
  else if ((m = line.match(RE_PYDEC))) {
    if (m[1].toLowerCase() === 'route') {
      const ms = m[4].match(/methods\s*=\s*[\[(]([^\])]*)/i);
      const list = ms ? (ms[1].match(/[A-Za-z]+/g) || []).map((x) => x.toUpperCase()).filter((x) => METHODS.includes(x)) : ['GET'];
      for (const method of list.length ? list : ['GET']) out.push({ method, path: m[3] });
    } else out.push({ method: m[1].toUpperCase(), path: m[3] });
  } else if ((m = line.match(RE_SPRING))) out.push({ method: m[1].toUpperCase(), path: m[2].startsWith('/') ? m[2] : '/' + m[2] });
  else if ((m = line.match(RE_GO))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  return out;
}
const isSpecFile = (f) => /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f);
const isSchemaFile = (f) => isSpecFile(f) || /\.(proto|graphql|gql)$/i.test(f) || /(^|\/)(schema|schemas|types|dto|dtos|models?|contracts?)(\/|\.[a-z]+$)/i.test(f);

/** Extract "the API as actually implemented" from a unified diff. Returns { text, endpoints[], files[], truncated }. */
function extractFromDiff(diff, meta = {}) {
  const files = diffFiles(diff);
  const eps = new Map();
  const add = (method, p, file) => { const e = { method, path: p, file }; const k = endpointKey(e); if (!eps.has(k)) eps.set(k, e); };
  for (const f of files) {
    if (isSpecFile(f.file)) { // OpenAPI: yaml path keys + method keys, or json "/path": {
      let curPath = null;
      for (const l of f.added) {
        let m;
        if ((m = l.match(/^\s{0,4}["']?(\/[^\s"':]*)["']?\s*:\s*\{?\s*$/))) { curPath = m[1]; continue; }
        if (curPath && (m = l.match(/^\s*["']?(get|post|put|patch|delete|head|options)["']?\s*:\s*\{?\s*$/i))) add(m[1].toUpperCase(), curPath, f.file);
      }
    }
    for (const l of f.added) for (const e of endpointsOfLine(l)) add(e.method, e.path, f.file);
    if (/(^|\/)(route|app\/.*\/route)\.(t|j)sx?$/.test(f.file)) for (const l of f.added) { const m = l.match(RE_NEXT); if (m) add(m[1], '/' + f.file.replace(/^.*?app\//, '').replace(/\/?route\.(t|j)sx?$/, ''), f.file); }
  }
  const endpoints = [...eps.values()];
  const lines = [`# API as implemented (extracted from the provider's diff${meta.task ? `: task #${meta.task}` : ''}${meta.branch ? `, branch ${meta.branch}` : ''}${meta.range ? `, ${meta.range}` : ''})`, '',
    'Deterministic extraction (no LLM); added lines only. Treat it as a hint of what the provider really built.', '', '## Endpoints'];
  if (endpoints.length) for (const e of endpoints) lines.push(`- ${e.method} ${e.path}   (${e.file})`);
  else lines.push('- (no HTTP route declarations recognised in the added lines)');
  const schema = files.filter((f) => isSchemaFile(f.file) && f.added.length);
  if (schema.length) {
    lines.push('', '## Contract / schema files changed');
    for (const f of schema.slice(0, 8)) lines.push(`### ${f.file}`, '```', clip(f.added.slice(0, 60).join('\n'), 2500), '```');
  }
  lines.push('', '## Changed files');
  for (const f of files.slice(0, 40)) lines.push(`- ${f.file} (+${f.added.length})`);
  if (files.length > 40) lines.push(`- ... ${files.length - 40} more`);
  if (meta.truncated) lines.push('', '(the diff was truncated at the size cap; later files may be missing)');
  return { text: lines.join('\n').slice(0, MAX_CONTRACT), endpoints, files: files.map((f) => f.file), truncated: !!meta.truncated };
}

/** Endpoints mentioned in a (free-form) contract text: "METHOD /path" occurrences. */
function contractEndpoints(text) {
  const out = new Map();
  const re = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[\s|`'":*]*?(\/[^\s`'"),;|<>]*|<[^>]*>)/gi;
  let m;
  while ((m = re.exec(String(text)))) {
    if (!m[2].startsWith('/')) continue;
    const e = { method: m[1].toUpperCase(), path: m[2] };
    out.set(endpointKey(e), e);
  }
  return out;
}

/** Compare the approved contract with the extracted actual. comparable=false when the contract names no endpoint (free-form text). */
function compare(contractText, actual) {
  const want = contractEndpoints(contractText);
  const have = new Map(actual.endpoints.map((e) => [endpointKey(e), e]));
  if (!want.size) return { comparable: false, drift: false, missing: [], extra: [] };
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  return { comparable: true, drift: missing.length > 0 || extra.length > 0, missing, extra };
}

// ---------------------------------------------------------------- artifacts
function nextVersion(fid, kind) { return store.listArtifacts(fid, kind).reduce((m, a) => Math.max(m, a.version), 0) + 1; }
function addArtifact(fid, kind, content, { task_id = null, status = 'proposed', source = 'human' } = {}) {
  const id = store.addArtifact({ feature_id: fid, task_id, kind, version: nextVersion(fid, kind), content, sha256: sha(content), status, source });
  return store.getArtifact(id);
}
function contractState(fid) {
  const list = store.listArtifacts(fid, 'api_contract');
  const approved = [...list].reverse().find((a) => a.status === 'approved') || null;
  const proposed = [...list].reverse().find((a) => a.status === 'proposed' && (!approved || a.version > approved.version)) || null;
  return { approved, proposed, versions: list.length, ok: !!approved && !proposed };
}
function latestActual(fid) { return [...store.listArtifacts(fid, 'api_actual')].reverse().find((a) => a.status !== 'superseded') || null; }
function overrides(fid) {
  return store.listArtifacts(fid, 'notes').map((a) => { try { return { id: a.id, at: a.created_at, ...JSON.parse(a.content) }; } catch { return null; } }).filter((x) => x && x.type === 'merge_order_override');
}

// ---------------------------------------------------------------- structure helpers
const steps = (f) => (f.group_id ? store.groupTasks(f.group_id) : []);
const provider = (f) => steps(f).find((t) => t.feature_role === 'provider') || null;
const consumers = (f) => steps(f).filter((t) => t.feature_role === 'consumer');
const driftOf = (f) => (f.plan && f.plan.drift && !f.plan.drift.resolved ? f.plan.drift : null);

/** The runner's scheduler gate for feature steps. null = not a feature step (fall through to the sequence logic). */
function gateState(task) {
  if (!task.feature_id) return null;
  const f = store.getFeature(task.feature_id);
  if (!f) return null;
  if (f.status === 'cancelled') return { state: 'blocked', why: `feature #${f.id} was cancelled` };
  const c = contractState(f.id);
  if (!c.approved) return { state: 'wait' };
  if (c.proposed) return { state: 'wait' }; // a newer contract version is waiting for approval: nothing new starts until the human decides
  if (task.feature_role !== 'consumer') return { state: 'ready' };
  const p = provider(f);
  if (!p) return { state: 'blocked', why: `feature #${f.id} has no provider step any more` };
  if (['failed', 'rejected'].includes(p.status)) return { state: 'blocked', why: `provider step #${p.id} (${p.service_name}) is ${p.status}` };
  if (driftOf(f)) return { state: 'wait' };
  if (p.supervised) return { state: 'wait' };
  return ['review', 'done'].includes(p.status) ? { state: 'ready' } : { state: 'wait' };
}

/** Why a consumer cannot be merged yet (null = fine). The provider must be merged (status done) first. */
function mergeGuard(task) {
  if (!task.feature_id || task.feature_role !== 'consumer') return null;
  const f = store.getFeature(task.feature_id);
  if (!f) return null;
  const p = provider(f);
  if (!p || store.mergedToDefault(p)) return null;
  return { feature_id: f.id, provider_task_id: p.id, provider_status: p.status, provider_service: p.service_name,
    message: `merge order: consumer step #${task.id} cannot be merged before its provider step #${p.id} (${p.service_name}, status '${p.status}') is merged` };
}

function recordOverride(task, guard, reason, who = 'human') {
  const content = JSON.stringify({ type: 'merge_order_override', task_id: task.id, provider_task_id: guard.provider_task_id, provider_status: guard.provider_status, reason, by: who });
  const a = addArtifact(task.feature_id, 'notes', content, { task_id: task.id, status: 'approved', source: 'human' });
  store.addEvent(task.id, 'system', `MERGE-ORDER OVERRIDE by human: merged before provider step #${guard.provider_task_id} (${guard.provider_status}); reason: ${reason}`);
  refresh(task.feature_id);
  return a;
}

// ---------------------------------------------------------------- status
function derive(f) {
  if (f.status === 'cancelled') return 'cancelled';
  const st = steps(f);
  if (!st.length) return 'draft';
  if (st.some((t) => ['failed', 'rejected'].includes(t.status))) return 'failed';
  if (driftOf(f)) return 'contract_drift';
  if (st.every((t) => t.status === 'done')) return 'done';
  const c = contractState(f.id);
  if (st.every((t) => t.status === 'pending')) return c.ok ? 'planned' : 'contract_pending';
  if (st.some((t) => ACTIVE.includes(t.status))) return 'running';
  if (st.some((t) => t.status === 'review')) return 'review';
  return c.ok ? 'running' : 'contract_pending';
}
function refresh(fid) {
  const f = store.getFeature(fid);
  if (!f) return null;
  const s = derive(f);
  if (s !== f.status) store.updateFeature(fid, { status: s });
  return store.getFeature(fid);
}

// ---------------------------------------------------------------- actions
/** Create a feature + its steps (all pending). `validateStep(body)` is server.js's validateTask (project/service/engine checks); `usable(service)` enforces authorized roots. */
function create(body, { validateStep, usable }) {
  const owner = store.getProject(Number(body.project_id));
  if (!owner) throw bad(`project ${body.project_id} not found`);
  if (owner.archived) throw conflict(`project '${owner.name}' is archived`);
  const title = String(body.title ?? '').trim();
  if (!title || title.length > 200) throw bad('title required (max 200 chars)');
  const brief = String(body.brief ?? '').trim().slice(0, 8000);
  if (!Array.isArray(body.steps) || body.steps.length < 2 || body.steps.length > MAX_STEPS) throw bad(`steps must be an array of 2..${MAX_STEPS} (step 1 = provider, the rest = consumers)`);
  const contract = body.contract === undefined || body.contract === null ? '' : String(body.contract);
  if (contract.length > MAX_CONTRACT) throw bad(`contract too long (max ${MAX_CONTRACT} chars)`);
  const specs = [];
  const seen = new Set();
  for (let i = 0; i < body.steps.length; i++) {
    const s = body.steps[i];
    if (!s || typeof s !== 'object') throw bad(`step ${i + 1}: object expected`);
    const sb = { ...s, project_id: s.project_id ?? owner.id };
    if (sb.service_id === undefined || sb.service_id === null || String(sb.service_id).trim() === '' || ['auto', 'none'].includes(String(sb.service_id))) throw bad(`step ${i + 1}: service_id required (a feature step names its exact service)`);
    const v = validateStep(sb);
    if (v.error) { const e = bad(`step ${i + 1}: ${v.error}`); if (v.status) e.status = v.status; throw e; }
    if (v.route_requested) throw bad(`step ${i + 1}: engine auto-route is not available in features; choose local, cursor or auto`);
    const svc = store.getService(v.service_id);
    try { usable(svc); } catch (e) { throw conflict(`step ${i + 1}: service '${svc.name}' is not usable: ${e.message}`); }
    if (seen.has(v.service_id)) throw bad(`step ${i + 1}: service '${svc.name}' is used twice; a feature step per service`);
    seen.add(v.service_id);
    specs.push(v);
  }
  const fid = store.createFeature({ project_id: owner.id, title, brief, status: 'contract_pending', plan: {} });
  const gid = store.createGroup({ project_id: owner.id, title: `Feature #${fid}: ${title}`.slice(0, 200), dependency: 'independent', feature_id: fid, gate: 'contract' });
  store.updateFeature(fid, { group_id: gid });
  const ids = [];
  specs.forEach((v, i) => {
    const tid = store.createTask({ ...v, group_id: gid, step_no: i + 1, feature_id: fid, feature_role: i === 0 ? 'provider' : 'consumer' });
    ids.push(tid);
    store.addEvent(tid, 'system', `task created as ${i === 0 ? 'PROVIDER' : 'CONSUMER'} step ${i + 1} of cross-repo feature #${fid} '${title}' (status: pending; needs the contract approved and a start approval)`);
  });
  if (contract.trim()) addArtifact(fid, 'api_contract', contract.trim(), { status: 'proposed', source: 'human' });
  return { id: fid, task_ids: ids };
}

function mustGet(id) { const f = store.getFeature(Number(id)); if (!f) throw new FeatureError(404, 'feature not found'); return f; }
function mustBeOpen(f) { if (f.status === 'cancelled') throw conflict('feature is cancelled'); if (derive(f) === 'done') throw conflict('feature is already done'); }

function saveContract(f, content) {
  mustBeOpen(f);
  const text = String(content ?? '').trim();
  if (!text) throw bad('contract text required');
  if (text.length > MAX_CONTRACT) throw bad(`contract too long (max ${MAX_CONTRACT} chars)`);
  const cur = contractState(f.id);
  if (cur.proposed) store.setArtifactStatus(cur.proposed.id, 'superseded'); // a newer draft replaces the unapproved one
  const a = addArtifact(f.id, 'api_contract', text, { status: 'proposed', source: 'human' });
  for (const t of steps(f)) store.addEvent(t.id, 'system', `feature #${f.id}: contract v${a.version} proposed; steps that have not started wait until a human approves it`);
  refresh(f.id);
  return a;
}
function approveContract(f, version) {
  mustBeOpen(f);
  const cur = contractState(f.id);
  const target = version ? store.listArtifacts(f.id, 'api_contract').find((a) => a.version === Number(version)) : cur.proposed;
  if (!target) throw conflict(version ? `contract v${version} not found` : 'no proposed contract to approve');
  if (target.status !== 'proposed') throw conflict(`contract v${target.version} is ${target.status}`);
  if (cur.approved) store.setArtifactStatus(cur.approved.id, 'superseded');
  store.setArtifactStatus(target.id, 'approved');
  for (const t of steps(f)) store.addEvent(t.id, 'system', `feature #${f.id}: contract v${target.version} APPROVED by human`);
  refresh(f.id);
  return store.getArtifact(target.id);
}
/** The provider's implementation differs from the contract and the human accepts the actual as the new contract. */
function acceptActual(f) {
  mustBeOpen(f);
  const act = latestActual(f.id);
  if (!act) throw conflict('no extracted actual API yet (the provider has not reached review)');
  const cur = contractState(f.id);
  if (cur.proposed) store.setArtifactStatus(cur.proposed.id, 'superseded');
  if (cur.approved) store.setArtifactStatus(cur.approved.id, 'superseded');
  const a = addArtifact(f.id, 'api_contract', act.content, { task_id: act.task_id, status: 'approved', source: 'extracted' });
  store.setArtifactStatus(a.id, 'approved');
  const plan = { ...f.plan }; if (plan.drift) plan.drift = { ...plan.drift, resolved: 'accepted_actual', resolved_at: new Date().toISOString() };
  store.updateFeature(f.id, { plan });
  for (const t of steps(f)) store.addEvent(t.id, 'system', `feature #${f.id}: provider's actual API accepted as contract v${a.version} by human (drift resolved)`);
  refresh(f.id);
  return a;
}
/** Human keeps the contract as-is despite drift and tells the provider side to fix it later: resolves the block explicitly, with a reason. */
function ignoreDrift(f, reason) {
  mustBeOpen(f);
  const why = String(reason ?? '').trim();
  if (why.length < MIN_OVERRIDE_REASON) throw bad(`a typed reason is required (at least ${MIN_OVERRIDE_REASON} characters)`);
  if (!driftOf(f)) throw conflict('no unresolved drift');
  const plan = { ...f.plan, drift: { ...f.plan.drift, resolved: 'ignored', reason: why, resolved_at: new Date().toISOString() } };
  store.updateFeature(f.id, { plan });
  addArtifact(f.id, 'notes', JSON.stringify({ type: 'drift_ignored', reason: why, drift: f.plan.drift }), { status: 'approved' });
  for (const t of steps(f)) store.addEvent(t.id, 'system', `feature #${f.id}: contract drift IGNORED by human: ${why}`);
  refresh(f.id);
}

/** Start approval for the whole feature (one click = approve-start of every pending step, like a sequence). Cursor steps need the CLI. */
async function start(f, reason, { cursorStatus }) {
  mustBeOpen(f);
  const owner = store.getProject(f.project_id);
  if (!owner || owner.archived) throw conflict('owner project is archived or missing');
  const c = contractState(f.id);
  if (!c.approved) throw conflict('approve the contract first (contract-first: nothing starts without an approved contract)');
  if (c.proposed) throw conflict(`contract v${c.proposed.version} is waiting for approval; approve or replace it first`);
  const pending = steps(f).filter((t) => t.status === 'pending');
  if (!pending.length) throw conflict('no pending steps in this feature');
  for (const t of pending) { const p = store.getProject(t.project_id); if (!p || p.archived) throw conflict(`project '${p ? p.name : t.project_id}' of step #${t.id} is archived`); }
  if (pending.some((t) => t.engine === 'cursor')) {
    const st = await cursorStatus();
    if (!st.installed || !st.logged_in) throw conflict(`cursor CLI unavailable: ${st.error || 'not logged in'}`);
  }
  for (const t of pending) {
    if (!store.transition(t.id, 'pending', 'approved')) continue;
    store.addApproval(t.id, 'start', 'approved', `feature #${f.id} start approved${reason ? ': ' + reason : ''}`);
    store.addEvent(t.id, 'system', `start approved by human with feature #${f.id}; ${t.feature_role === 'provider' ? 'runs first' : 'waits for the provider to reach review with a matching contract'} (plan-first / escalation / merge gates unchanged)`);
  }
  return refresh(f.id);
}

/** Re-queue a failed/rejected step as a NEW pending task (the old one is kept as history, superseded); dependants that were "not run" are re-queued too. */
function retryStep(f, taskId) {
  mustBeOpen(f);
  const t = store.featureTasks(f.id).find((x) => x.id === Number(taskId));
  if (!t) throw new FeatureError(404, 'step not found in this feature');
  if (t.superseded_by) throw conflict('step was already replaced');
  if (!['failed', 'rejected'].includes(t.status)) throw conflict(`only failed/rejected steps can be retried (status '${t.status}')`);
  const dup = (src) => {
    const nid = store.createTask({ ...src, files: src.files || [], group_id: src.group_id, step_no: src.step_no, feature_id: f.id, feature_role: src.feature_role, route_requested: false, routing_source: 'manual' });
    store.updateFields(src.id, { superseded_by: nid });
    store.addEvent(nid, 'system', `retry of step #${src.id} in feature #${f.id} (status: pending, awaiting start approval; the old task is kept as history)`);
    store.addEvent(src.id, 'system', `replaced by retry step #${nid}`);
    return nid;
  };
  const made = [dup(t)];
  if (t.feature_role === 'provider') {
    for (const c of consumers(f)) if (['failed', 'rejected'].includes(c.status) && /not run:/.test(c.result_summary || '')) made.push(dup(c));
    const plan = { ...f.plan }; delete plan.drift; store.updateFeature(f.id, { plan });
  }
  refresh(f.id);
  return made;
}

function cancel(f, reason) {
  const why = String(reason ?? '').trim();
  if (!why) throw bad('reason required');
  if (f.status === 'cancelled') throw conflict('feature is already cancelled');
  const left = [];
  for (const t of steps(f)) {
    if (t.status === 'pending' || t.status === 'approved') {
      if (store.transition(t.id, t.status, 'rejected')) {
        store.updateFields(t.id, { result_summary: `rejected before start (feature #${f.id} cancelled): ${why}` });
        store.addApproval(t.id, 'start', 'rejected', why);
        store.addEvent(t.id, 'system', `feature #${f.id} cancelled by human: ${why}`);
      }
    } else if (!FINISHED.includes(t.status)) left.push(t.id);
  }
  store.updateFeature(f.id, { status: 'cancelled', plan: { ...f.plan, cancelled: { reason: why, at: new Date().toISOString(), still_active: left } } });
  return { left_active: left };
}

// ---------------------------------------------------------------- hooks used by the runner
/** Provider reached review: extract the actual API from its diff, store it, compare with the approved contract (drift blocks consumers until a human decides). */
async function onTaskReview(task) {
  try {
    const t = store.getTask(task.id);
    if (!t || !t.feature_id || t.feature_role !== 'provider') return null;
    const f = store.getFeature(t.feature_id);
    if (!f || f.status === 'cancelled') return null;
    const d = await require('./git-ops').taskDiff(t);
    const ex = extractFromDiff(d.diff || '', { task: t.id, branch: t.branch, range: d.note, truncated: d.truncated });
    for (const a of store.listArtifacts(f.id, 'api_actual')) if (a.status !== 'superseded') store.setArtifactStatus(a.id, 'superseded');
    const art = addArtifact(f.id, 'api_actual', ex.text, { task_id: t.id, status: 'proposed', source: 'extracted' });
    const c = contractState(f.id);
    const cmp = c.approved ? compare(c.approved.content, ex) : { comparable: false, drift: false, missing: [], extra: [] };
    const plan = { ...f.plan, last_compare: { ...cmp, actual_version: art.version, contract_version: c.approved ? c.approved.version : null } };
    if (cmp.drift) {
      plan.drift = { missing: cmp.missing, extra: cmp.extra, contract_version: c.approved.version, actual_version: art.version, task_id: t.id };
      store.addEvent(t.id, 'system', `CONTRACT DRIFT in feature #${f.id}: provider did not implement ${cmp.missing.length ? cmp.missing.join(', ') : '(nothing missing)'}; extra: ${cmp.extra.join(', ') || '(none)'}. Consumers wait until a human accepts the actual API as the contract (or ignores the drift with a reason)`);
    } else {
      delete plan.drift;
      store.addEvent(t.id, 'system', `feature #${f.id}: provider's API extracted (${ex.endpoints.length} endpoint(s))${cmp.comparable ? ' and matches the approved contract' : '; the contract names no endpoints, so no automatic comparison'}; consumers may start`);
    }
    store.updateFeature(f.id, { plan });
    refresh(f.id);
    return { artifact: art.id, drift: cmp.drift };
  } catch (e) { try { store.addEvent(task.id, 'error', `feature hook failed (continuing): ${e.message}`); } catch { /* none */ } return null; }
}
/** Parts for the context bundle of a feature step: the approved contract (+ for consumers the provider's extracted actual). */
function contextParts(task) {
  if (!task.feature_id) return [];
  const f = store.getFeature(task.feature_id);
  if (!f) return [];
  const c = contractState(f.id);
  const out = [];
  const role = task.feature_role === 'provider' ? 'You are the PROVIDER: implement exactly this contract in your service.' : 'You are a CONSUMER: integrate against this contract; do not change the provider service.';
  const other = steps(f).filter((t) => t.id !== task.id).map((t) => `${t.feature_role} #${t.id} ${t.project_name}/${t.service_name}`).join('; ');
  out.push({ title: `FEATURE #${f.id}: ${f.title}`, source: `feature #${f.id}`, share: 0.2, body: `${f.brief ? f.brief + '\n\n' : ''}${role}\nOther steps: ${other || '-'}` });
  if (c.approved) out.push({ title: `API CONTRACT (v${c.approved.version}, approved by a human)`, source: `feature #${f.id} contract artifact`, share: 0.3, body: c.approved.content });
  if (task.feature_role === 'consumer') {
    const a = latestActual(f.id);
    if (a) out.push({ title: "PROVIDER'S IMPLEMENTATION (extracted from its diff)", source: `feature #${f.id} api_actual v${a.version}`, share: 0.25, body: a.content });
  }
  return out;
}

// ---------------------------------------------------------------- views
const stepView = (t, f) => {
  const g = task_guard(t);
  return { id: t.id, step_no: t.step_no, role: t.feature_role, project_id: t.project_id, project: t.project_name, service_id: t.service_id, service: t.service_name,
    title: t.title, status: t.status, engine: t.engine, engine_used: t.engine_used, plan_first: !!t.plan_first, plan_state: t.plan_state, branch: t.branch, head_sha: t.head_sha,
    summary: t.result_summary, gate: gateState(t), merge_blocked: g ? { provider_task_id: g.provider_task_id, provider_status: g.provider_status, message: g.message } : null, feature_id: f.id };
};
const task_guard = (t) => mergeGuard(t);

function view(f0, { full = false } = {}) {
  const f = refresh(f0.id) || f0;
  const st = steps(f);
  const c = contractState(f.id);
  const base = { id: f.id, project_id: f.project_id, title: f.title, brief: f.brief, status: f.status, created_at: f.created_at, updated_at: f.updated_at, group_id: f.group_id,
    steps: st.map((t) => stepView(t, f)), contract: { approved_version: c.approved ? c.approved.version : null, proposed_version: c.proposed ? c.proposed.version : null, ok: c.ok },
    drift: driftOf(f), cancelled: f.plan.cancelled || null };
  if (!full) return base;
  const art = (a) => ({ id: a.id, kind: a.kind, version: a.version, status: a.status, source: a.source, task_id: a.task_id, sha256: a.sha256, created_at: a.created_at, approved_at: a.approved_at, content: a.content });
  const p = provider(f);
  const history = store.featureTasks(f.id).filter((t) => t.superseded_by).map((t) => ({ id: t.id, step_no: t.step_no, role: t.feature_role, status: t.status, superseded_by: t.superseded_by }));
  return { ...base,
    contracts: store.listArtifacts(f.id, 'api_contract').map(art), actuals: store.listArtifacts(f.id, 'api_actual').map(art),
    last_compare: f.plan.last_compare || null, overrides: overrides(f.id), history,
    merge_order: st.map((t) => ({ task_id: t.id, step_no: t.step_no, role: t.feature_role, service: t.service_name, status: t.status,
      merged: store.mergedToDefault(t), order_ok: t.feature_role !== 'consumer' || !p || store.mergedToDefault(p), blocked_by: t.feature_role === 'consumer' && p && !store.mergedToDefault(p) ? p.id : null,
      overridden: overrides(f.id).some((o) => o.task_id === t.id) })),
    graph: { nodes: st.map((t) => ({ id: t.id, role: t.feature_role, label: `${t.project_name}/${t.service_name}`, status: t.status })),
      edges: p ? consumers(f).map((t) => ({ from: p.id, to: t.id, kind: 'contract' })) : [] } };
}

module.exports = { FeatureError, MIN_OVERRIDE_REASON, extractFromDiff, contractEndpoints, compare, endpointKey, normPath, contractState, latestActual, overrides,
  gateState, mergeGuard, recordOverride, derive, refresh, create, mustGet, saveContract, approveContract, acceptActual, ignoreDrift, start, retryStep, cancel, onTaskReview, contextParts, view, steps };

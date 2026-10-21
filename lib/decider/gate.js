'use strict';
// Scope gate. One noul per candidate file, one route choice, one risk score.
const cfg = require('../../config');
const { decide } = require('./index');
const { labelOf, band, capOf } = require('./confidence');

const STRICT = 'Reply again for ONLY the question ids in this request. A noul answer is {"p": a number from 0 to 1}. A choice answer is {"choice": one listed option, "probs": {"option": a number from 0 to 1}}. A score answer is {"value": an integer inside min..max, "p": a number from 0 to 1}. Do not omit a question and do not return null.';

const ROUTES = ['local-small', 'local-ornith', 'split', 'cursor'];

function summaryOf(index, filePath) {
  if (!index) return '';
  const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '(root)';
  const mod = (index.modules || []).find((m) => m.path === dir);
  const names = (index.symbols || []).filter((s) => s.path === filePath).map((s) => s.name).slice(0, 8);
  return [mod && mod.summary, names.length ? names.join(', ') : ''].filter(Boolean).join(' ').slice(0, 240);
}

function questionsFor(prompt, files) {
  const lines = (files || []).map((f) => `- ${f.path}: ${f.summary || 'no summary'}`);
  const state = [`Task: ${String(prompt || '').slice(0, 4000)}`, 'Candidate files:', ...lines].join('\n');
  const questions = (files || []).map((f) => ({ id: `in_scope:${f.path}`, type: 'noul', text: `Is ${f.path} in scope for this task?` }));
  questions.push({ id: 'route', type: 'choice', text: 'Which route should run this task?', options: ROUTES });
  questions.push({ id: 'risk', type: 'score', text: 'Risk of this change, 0 safe to 3 dangerous.', min: 0, max: 3 });
  return { state, questions };
}

function modelForRoute(route, installed) {
  const want = route === 'local-small' ? 'qwen2.5-coder' : route === 'local-ornith' ? 'ornith' : null;
  if (!want) return null;
  return (installed || []).find((m) => m === want || String(m).startsWith(`${want}:`)) || null;
}

function scoreItem(question, answers, { backend, cap, retried }) {
  const got = labelOf(question, answers && answers[question.id]);
  const limit = capOf(backend, cap);
  const confidence = got.invalid || limit == null ? got.confidence : Math.min(got.confidence, limit);
  const how = got.invalid ? 'invalid' : band(confidence);
  const item = {
    id: question.id,
    type: question.type,
    label: got.label,
    value: got.label,
    confidence,
    band: how,
    invalid: !!got.invalid,
    retried: !!retried,
    backend: backend || null,
  };
  if (question.id.startsWith('in_scope:')) item.file = question.id.slice('in_scope:'.length);
  return item;
}

function worst(items) {
  if (items.some((it) => it.invalid)) return 'invalid';
  if (items.some((it) => it.band === 'escalate')) return 'escalate';
  if (items.some((it) => it.band === 'ask')) return 'ask';
  return 'act';
}

/**
 * @returns {Promise<{action:string, files:string[], excluded:string[], route:string|null, risk:number|null, confidence:number, backend:string|null, items:object[], model:string|null, error?:string}>}
 */
async function run({ prompt, files, decideFn, installed, fallbackCap } = {}) {
  const ask = decideFn || decide;
  const cap = fallbackCap == null ? cfg.DECIDER_FALLBACK_CAP : fallbackCap;
  const { state, questions } = questionsFor(prompt, files);
  let judged = await ask(state, questions);
  let answers = { ...(judged.answers || {}) };
  let items = questions.map((q) => scoreItem(q, answers, { backend: judged.backend, cap, retried: false }));
  const missing = items.filter((it) => it.invalid).map((it) => it.id);
  if (missing.length) {
    const again = questions.filter((q) => missing.includes(q.id));
    const second = await ask(`${state}\n\n${STRICT}\nQuestion ids: ${missing.join(', ')}`, again);
    const merged = { ...answers, ...(second.answers || {}) };
    const backend = second.backend || judged.backend;
    items = questions.map((q) => scoreItem(q, merged, { backend: missing.includes(q.id) ? backend : judged.backend, cap, retried: missing.includes(q.id) }));
    answers = merged;
    judged = { ...judged, answers: merged, backend: judged.backend || second.backend, confidence: second.confidence ?? judged.confidence, error: second.error || judged.error, tokens: (judged.tokens || 0) + (second.tokens || 0) };
  }
  const approved = [];
  const excluded = [];
  for (const file of files || []) {
    const it = items.find((x) => x.id === `in_scope:${file.path}`);
    if (!it) continue;
    if (it.band === 'act' && it.label === true) approved.push(file.path);
    else if (it.band === 'act' && it.label === false) excluded.push(file.path);
    else if (it.band === 'ask' && it.label === true) approved.push(file.path);
  }
  const routeItem = items.find((it) => it.id === 'route');
  const riskItem = items.find((it) => it.id === 'risk');
  const action = worst(items);
  const limit = capOf(judged.backend, cap);
  const confidence = limit == null ? (judged.confidence || 0) : Math.min(judged.confidence || 0, limit);
  const base = {
    files: approved,
    excluded,
    route: routeItem && !routeItem.invalid ? routeItem.label : null,
    risk: riskItem && !riskItem.invalid ? riskItem.label : null,
    confidence,
    backend: judged.backend,
    model: null,
    items,
    tokens: judged.tokens || 0,
    error: judged.error,
    fallback: judged.fallback || null,
  };
  if (action === 'invalid') return { ...base, action, error: judged.error || 'invalid answer' };
  if (action === 'escalate') return { ...base, action, files: [], route: 'cursor' };
  if (base.route === 'cursor' && routeItem && routeItem.band === 'act') {
    return { ...base, action: 'escalate', route: 'cursor' };
  }
  return { ...base, action, model: modelForRoute(base.route, installed) };
}

module.exports = { ROUTES, summaryOf, questionsFor, modelForRoute, run };

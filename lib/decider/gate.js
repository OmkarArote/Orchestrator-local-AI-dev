'use strict';
// Scope gate. One noul per candidate file, one route choice, one risk score.
const cfg = require('../../config');
const { decide } = require('./index');
const { labelOf, band } = require('./confidence');

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

/**
 * @returns {Promise<{action:string, files:string[], excluded:string[], route:string|null, risk:number|null, confidence:number, backend:string|null, items:object[], model:string|null, error?:string}>}
 */
async function run({ prompt, files, decideFn, installed } = {}) {
  const act = cfg.DECIDER_ACT;
  const ask = cfg.DECIDER_ASK;
  const { state, questions } = questionsFor(prompt, files);
  const judged = await (decideFn || decide)(state, questions);
  const items = [];
  const approved = [];
  const excluded = [];
  let action = 'act';
  const bump = (next) => {
    if (next === 'escalate') action = 'escalate';
    else if (next === 'ask' && action !== 'escalate') action = 'ask';
  };
  for (const file of files || []) {
    const q = questions.find((x) => x.id === `in_scope:${file.path}`);
    const got = labelOf(q, judged.answers && judged.answers[q.id]);
    const how = band(got.confidence, act, ask);
    items.push({ id: q.id, file: file.path, type: 'noul', label: got.label, confidence: got.confidence, band: how });
    if (how === 'act' && got.label === true) approved.push(file.path);
    else if (how === 'act' && got.label === false) excluded.push(file.path);
    else if (how === 'ask' && got.label === true) approved.push(file.path);
    bump(how);
  }
  const routeQ = questions.find((q) => q.id === 'route');
  const routeGot = labelOf(routeQ, judged.answers && judged.answers.route);
  const routeBand = band(routeGot.confidence, act, ask);
  items.push({ id: 'route', type: 'choice', label: routeGot.label, confidence: routeGot.confidence, band: routeBand });
  bump(routeBand);
  const riskQ = questions.find((q) => q.id === 'risk');
  const riskGot = labelOf(riskQ, judged.answers && judged.answers.risk);
  const riskBand = band(riskGot.confidence, act, ask);
  items.push({ id: 'risk', type: 'score', label: riskGot.label, confidence: riskGot.confidence, band: riskBand });
  bump(riskBand);
  const route = routeBand === 'act' ? routeGot.label : (action === 'escalate' ? 'cursor' : routeGot.label);
  if (action === 'escalate') {
    return { action, files: [], excluded, route: 'cursor', risk: riskGot.label, confidence: judged.confidence || 0, backend: judged.backend, model: null, items, error: judged.error, tokens: judged.tokens || 0 };
  }
  if (route === 'cursor' && routeBand === 'act') {
    return { action: 'escalate', files: approved, excluded, route: 'cursor', risk: riskGot.label, confidence: judged.confidence || 0, backend: judged.backend, model: null, items, tokens: judged.tokens || 0 };
  }
  return {
    action,
    files: approved,
    excluded,
    route: route || null,
    risk: riskGot.label,
    confidence: judged.confidence || 0,
    backend: judged.backend,
    model: modelForRoute(route, installed),
    items,
    tokens: judged.tokens || 0,
    error: judged.error,
  };
}

module.exports = { ROUTES, summaryOf, questionsFor, modelForRoute, run };

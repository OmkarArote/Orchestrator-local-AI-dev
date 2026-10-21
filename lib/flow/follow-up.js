'use strict';
// A follow-up is another iteration of the same task, on the branch it already has.
const fs = require('node:fs');
const path = require('node:path');
const store = require('../db');
const { git } = require('../proc');

function request(task, instruction) {
  const text = String(instruction || '').trim();
  if (!text) return { ok: false, status: 400, message: 'instruction required' };
  if (text.length > 8000) return { ok: false, status: 400, message: 'instruction too long (max 8000)' };
  if (!task || !['review', 'done'].includes(task.status)) return { ok: false, status: 409, message: `cannot request changes: status is '${task ? task.status : 'missing'}'` };
  if (task.supervised) return { ok: false, status: 409, message: 'task is supervised: release it before requesting changes' };
  if (!task.branch) return { ok: false, status: 409, message: 'task has no branch' };
  const iteration = (Number(task.iteration) || 1) + 1;
  store.addEvent(task.id, 'followup', JSON.stringify({ phase: 'followup', iteration, instruction: text.slice(0, 4000) }));
  if (!store.transition(task.id, task.status, 'approved', { iteration })) return { ok: false, status: 409, message: 'status changed' };
  return { ok: true, iteration, branch: task.branch, message: `follow-up iteration ${iteration} approved on ${task.branch}` };
}

function walk(n, out) {
  out.push([n.kind, n.status, n.reason].filter(Boolean).join(' '));
  for (const c of n.children || []) walk(c, out);
  return out;
}

async function promptFor(task, ctx) {
  const events = store.eventsAfter(task.id, 0, 5000);
  const last = [...events].reverse().find((e) => e.kind === 'followup');
  let instruction = '';
  try { instruction = JSON.parse((last && last.message) || '{}').instruction || ''; } catch { instruction = ''; }
  const base = (task && task.base_ref) || (ctx && ctx.defaultBranch) || 'HEAD';
  let stat = '';
  let current = '';
  if (ctx && ctx.wt) {
    stat = ((await git(ctx.wt, ['diff', '--stat', `${base}...HEAD`])).out || '').trim();
    const names = ((await git(ctx.wt, ['diff', '--name-only', `${base}...HEAD`])).out || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    current = names.map((name) => {
      let body = '';
      try { body = fs.readFileSync(path.join(ctx.wt, name), 'utf8').slice(0, 2000); } catch { body = '(unreadable)'; }
      return `Current ${name}:\n${body}`;
    }).join('\n\n');
  }
  const tree = require('./lineage').buildLineage({ task, events }).tree;
  return [
    `Follow-up iteration ${task.iteration} on branch ${task.branch}. Stay on this branch. Apply only this instruction:`,
    instruction,
    `Previous plan:\n${(task && task.plan_text) || '(none)'}`,
    `Lineage:\n${walk(tree, []).join('\n').slice(0, 2000)}`,
    `Diff stat against ${base}:\n${stat || '(none)'}`,
    current,
    `Original task:\n${(task && task.prompt) || ''}`,
  ].filter(Boolean).join('\n\n').slice(0, 12000);
}

async function classify(instruction, { decideFn, fallbackCap } = {}) {
  const cfg = require('../../config');
  const { decide } = require('../decider');
  const { labelOf, band, capOf } = require('../decider/confidence');
  const q = { id: 'needs_code_change', type: 'noul', text: 'Does this follow-up require a code change? A question about what already happened is no.' };
  const ask = decideFn || ((state, questions) => decide(state, questions));
  const state = `Follow-up instruction:\n${String(instruction || '').slice(0, 4000)}`;
  let judged = await ask(state, [q]);
  let got = labelOf(q, judged.answers && judged.answers.needs_code_change);
  let retried = false;
  if (got.invalid) {
    retried = true;
    const second = await ask(`${state}\n\nReply with needs_code_change as {"p": a number from 0 to 1}. Do not omit it.`, [q]);
    judged = {
      ...judged,
      answers: second.answers || judged.answers,
      backend: second.backend || judged.backend,
      fallback: second.fallback || judged.fallback,
      error: second.error || judged.error,
      confidence: second.confidence ?? judged.confidence,
    };
    got = labelOf(q, second.answers && second.answers.needs_code_change);
  }
  const limit = capOf(judged.backend, fallbackCap == null ? cfg.DECIDER_FALLBACK_CAP : fallbackCap);
  const confidence = got.invalid || limit == null ? got.confidence : Math.min(got.confidence, limit);
  const how = got.invalid ? 'invalid' : band(confidence);
  const item = { id: q.id, type: 'noul', label: got.label, value: got.label, confidence, band: how, invalid: !!got.invalid, retried, backend: judged.backend || null };
  if (how !== 'act') return { action: how === 'invalid' ? 'invalid' : 'ask', item, backend: judged.backend || null, fallback: judged.fallback || null, error: judged.error || null };
  return { action: got.label === true ? 'edit' : 'answer', item, backend: judged.backend || null, fallback: judged.fallback || null };
}

async function answer(task, ctx, { chat } = {}) {
  const context = await promptFor(task, ctx);
  let snippets = '';
  if (ctx && ctx.service) {
    try {
      const last = [...store.eventsAfter(task.id, 0, 5000)].reverse().find((e) => e.kind === 'followup');
      let instruction = '';
      try { instruction = JSON.parse((last && last.message) || '{}').instruction || ''; } catch { instruction = ''; }
      const hits = require('../index/build').search(ctx.service.id, instruction).hits.slice(0, 5);
      snippets = hits.map((h) => `${h.path}: ${h.name || ''}`).join('\n');
    } catch { snippets = ''; }
  }
  const user = [context, snippets ? `Retrieved snippets:\n${snippets}` : ''].filter(Boolean).join('\n\n').slice(0, 12000);
  const talk = chat || ((body) => require('../ollama').chat('ollama', body));
  const r = await talk({
    model: 'ornith:9b',
    stream: false,
    think: false,
    messages: [
      { role: 'system', content: 'Answer the question about this task. Do not edit files and do not propose a diff.' },
      { role: 'user', content: user },
    ],
  });
  const text = (r && r.content) || (r && r.message) || 'no answer';
  return { ok: !!(r && r.ok !== false), text: String(text).slice(0, 8000) };
}

module.exports = { request, promptFor, classify, answer };

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

module.exports = { request, promptFor };

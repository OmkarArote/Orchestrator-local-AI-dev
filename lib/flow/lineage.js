'use strict';
// Build a task lineage tree from task_events. task_plans is optional and unused until schema v7.

function unpack(message) {
  if (!message || message[0] !== '{') return null;
  try {
    const o = JSON.parse(message);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}

function node(kind, extra = {}) {
  const n = { kind, status: extra.status || null, reason: extra.reason || null, engine: extra.engine || null, model: extra.model || null, file: extra.file || null, check: extra.check || null, ms: extra.ms ?? null, sha: extra.sha || null, children: extra.children || [] };
  if (extra.note) n.note = extra.note;
  if (extra.rule) n.rule = extra.rule;
  if (extra.fallback) n.fallback = extra.fallback;
  if (Array.isArray(extra.items) && extra.items.length) n.items = extra.items;
  return n;
}

/**
 * @param {{task: object, events: object[], plan?: object|null}} input
 * plan is accepted for the v7 task_plans row and ignored when null.
 */
function buildLineage({ task, events, plan = null }) {
  const rows = events || [];
  const plans = [];
  const steps = new Map();
  const escalations = [];
  const followups = [];
  const merges = [];
  const extras = [];
  const stepOf = (file, model) => {
    const key = file || '(task)';
    if (!steps.has(key)) steps.set(key, node('step', { file: key, model: model || null, status: 'running', children: [] }));
    const s = steps.get(key);
    if (model && !s.model) s.model = model;
    return s;
  };
  for (const e of rows) {
    const j = unpack(e.message) || {};
    if (e.kind === 'plan' || j.phase === 'plan') {
      const plainModel = /planner\s+\S+\s+(\S+?):/.exec(e.message || '');
      plans.push(node('plan', { engine: j.engine || (/cursor/i.test(e.message || '') ? 'cursor' : null), model: j.model || (plainModel && plainModel[1]) || null, status: j.status || 'ok', reason: j.reason || null, ms: j.ms ?? null, sha: j.sha || null }));
    } else if (e.kind === 'attempt' || j.phase === 'attempt') {
      const step = stepOf(j.file, j.model);
      step.children.push(node(j.repair ? 'repair' : 'attempt', { status: j.status || null, reason: j.reason || null, engine: j.engine || null, model: j.model || null, file: j.file || null, check: j.check || null, ms: j.ms ?? null, sha: j.sha || null }));
      if (j.status) step.status = j.status;
      if (j.sha) step.sha = j.sha;
      if (j.check) step.check = j.check;
    } else if (e.kind === 'escalation' || j.phase === 'escalation') {
      const esc = node('escalation', { status: j.status || 'running', reason: (j.reasons && j.reasons[0]) || j.reason || null, engine: j.to || j.engine || null, model: j.model || null, ms: j.ms ?? null, sha: j.sha || null });
      if (j.file) stepOf(j.file, j.model).children.push(esc);
      else escalations.push(esc);
    } else if (e.kind === 'route' && (j.phase === 'route' || /^route\s+\S+:/.test(e.message || ''))) {
      const plain = /^route\s+([^:]+):/.exec(e.message || '');
      plans.push(node('route', { engine: j.engine || (/Cursor/.test(e.message || '') ? 'cursor' : null), model: j.model || null, status: 'ok', reason: (j.reasons && j.reasons[0]) || j.reason || (plain && plain[1]) || null, rule: j.rule || null }));
    } else if (e.kind === 'followup' || j.phase === 'followup') {
      followups.push(node('followup', { status: 'ok', reason: j.iteration ? `iteration ${j.iteration}` : null }));
    } else if (e.kind === 'merge' || j.phase === 'merge') {
      merges.push(node('merge', {
        status: j.status || null,
        reason: j.cursor_task_id ? `cursor #${j.cursor_task_id}` : (j.reason || null),
        sha: j.sha || j.target_sha || null,
        engine: j.role || null,
        model: j.target || null,
      }));
    } else if (e.kind === 'retrieval' || j.phase === 'retrieval') {
      const list = Array.isArray(j.chunks) ? j.chunks : [];
      extras.push(node('retrieval', {
        status: j.status || 'ok',
        reason: j.reason || `${list.length} chunk(s), ~${j.tokens || 0} tokens`,
        note: list.map((c) => `${c.path}:${c.start}-${c.end} ${c.why || ''}`.trim()).join('\n') || null,
      }));
    } else if (e.kind === 'decision' || j.phase === 'decision') {
      extras.push(node('decision', { status: j.status || j.action || 'ok', reason: j.reason || j.action || null, engine: j.backend || j.engine || null, model: j.model || null, note: j.note || null, fallback: j.fallback || null, items: j.items || null }));
    } else if (e.kind === 'guard' || j.phase === 'guard') {
      extras.push(node('guard', { status: j.status || 'blocked', reason: j.reason || null, file: j.file || null }));
    } else if (e.kind === 'iteration' || j.phase === 'iteration') {
      extras.push(node('iteration', { status: j.status || null, reason: j.reason || j.tool || null, engine: j.engine || null, model: j.model || null, ms: j.ms ?? null }));
    } else if (e.kind === 'git' && /committed ([0-9a-f]{7,})/.test(e.message)) {
      const sha = /committed ([0-9a-f]{7,})/.exec(e.message)[1];
      const last = [...steps.values()].pop();
      if (last && !last.sha) last.sha = sha;
    }
  }
  if (!plans.length && plan && plan.steps) {
    plans.push(node('plan', { engine: plan.engine || null, model: plan.model || null, status: 'ok' }));
  }
  const planNode = plans.find((p) => p.kind === 'plan') || node('plan', { status: plans.length ? 'ok' : null });
  for (const x of extras) planNode.children.push(x);
  for (const r of plans) if (r !== planNode) planNode.children.push(r);
  for (const s of steps.values()) planNode.children.push(s);
  for (const esc of escalations) planNode.children.push(esc);
  for (const f of followups) planNode.children.push(f);
  for (const m of merges) planNode.children.push(m);
  const root = node('task', { status: task && (task.display_status || task.status), model: task && (task.model_used || task.model) || null, sha: task && task.head_sha || null, children: [planNode] });
  root.label = task ? `#${task.id} ${task.title || ''}`.trim() : 'task';
  return { task_id: task ? task.id : null, status: task && (task.display_status || task.status), title: task && task.title, source: plan ? 'events+plan' : 'events', tree: root };
}

module.exports = { buildLineage, unpack };

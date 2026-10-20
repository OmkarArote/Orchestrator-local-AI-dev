'use strict';
// M41 lineage: the tree is derived from task_events. No schema change.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { buildLineage } = require('../lib/flow/lineage');

const ev = (kind, message) => ({ kind, message });

describe('M41 lineage builder', () => {
  it('nests the plan, the step, a repair, and the escalation chain under the task', () => {
    const tree = buildLineage({
      task: { id: 7, title: 'fix greet', status: 'review', head_sha: 'abc1234def' },
      events: [
        ev('route', 'route files: multi-file prompt (src/a.js, lib/b.js) → Cursor planner'),
        ev('plan', JSON.stringify({ phase: 'plan', engine: 'cursor', model: 'auto', status: 'ok' })),
        ev('attempt', JSON.stringify({ phase: 'attempt', file: 'src/a.js', engine: 'local', model: 'ornith:9b', status: 'failed', reason: 'no_edit', check: 'FAILED', ms: 12 })),
        ev('attempt', JSON.stringify({ phase: 'attempt', file: 'src/a.js', engine: 'local', model: 'ornith:9b', status: 'failed', repair: true, check: 'FAILED', ms: 20 })),
        ev('escalation', JSON.stringify({ phase: 'escalation', to: 'local2', model: 'qwen3.5:9b', reasons: ['verify_failed>=2'], file: 'src/a.js', status: 'running' })),
        ev('escalation', JSON.stringify({ phase: 'escalation', to: 'cursor', model: null, reasons: ['verify_failed>=2'], file: 'src/a.js', status: 'ok' })),
        ev('git', 'committed abc1234 on ai/task-7: 1 file changed'),
      ],
    });
    assert.equal(tree.source, 'events');
    assert.equal(tree.tree.kind, 'task');
    assert.equal(tree.tree.status, 'review');
    const plan = tree.tree.children[0];
    assert.equal(plan.kind, 'plan');
    assert.equal(plan.engine, 'cursor');
    assert.equal(plan.model, 'auto');
    assert.ok(plan.children.some((n) => n.kind === 'route' && n.reason === 'files'));
    const step = plan.children.find((n) => n.kind === 'step' && n.file === 'src/a.js');
    assert.ok(step);
    assert.equal(step.sha, 'abc1234');
    assert.ok(step.children.some((n) => n.kind === 'repair'));
    assert.deepEqual(step.children.filter((n) => n.kind === 'escalation').map((n) => n.model || n.engine), ['qwen3.5:9b', 'cursor']);
  });

  it('places a rolled-back merge, and the escalation models, where the timeline can read them', () => {
    const tree = buildLineage({
      task: { id: 9, status: 'review', title: 't' },
      events: [
        ev('attempt', JSON.stringify({ phase: 'attempt', file: 'a.txt', engine: 'local', model: 'ornith:9b', status: 'failed' })),
        ev('escalation', JSON.stringify({ phase: 'escalation', to: 'local2', model: 'qwen3.5:9b', file: 'a.txt', status: 'running' })),
        ev('escalation', JSON.stringify({ phase: 'escalation', to: 'cursor', file: 'a.txt', status: 'ok' })),
        ev('merge', JSON.stringify({ phase: 'merge', status: 'merge_rolled_back', role: 'dev', target: 'dev', cursor_task_id: 12, target_sha: 'abc1234' })),
      ],
    });
    const plan = tree.tree.children[0];
    const step = plan.children.find((n) => n.kind === 'step');
    assert.deepEqual(step.children.map((n) => n.model || n.engine), ['ornith:9b', 'qwen3.5:9b', 'cursor']);
    const merge = plan.children.find((n) => n.kind === 'merge');
    assert.equal(merge.status, 'merge_rolled_back');
    assert.equal(merge.reason, 'cursor #12');
    assert.equal(merge.sha, 'abc1234');
    assert.equal(merge.engine, 'dev');
  });

  it('labels the source events+plan when a plan row is passed, without reading a new table', () => {
    const tree = buildLineage({ task: { id: 1, status: 'review', title: 't' }, events: [], plan: { steps: [{ file: 'a.js' }], engine: 'local', model: 'ornith:9b' } });
    assert.equal(tree.source, 'events+plan');
    assert.equal(tree.tree.children[0].engine, 'local');
    assert.equal(tree.tree.children[0].model, 'ornith:9b');
  });
});

describe('M41 lineage API', () => {
  it('GET /api/tasks/:id/lineage returns the tree for a v2 task that reached review', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(S.work, 'm41'), { 'a.txt': 'a\n' });
      await S.addProject(repo, 'm41', 'true');
      const created = await S.post('/do', { service: 'm41', prompt: 'edit a.txt', title: 'lineage', files: ['a.txt'], check_cmd: 'true' });
      const t = await S.waitStatus(created.id, 'review');
      const lin = await S.get(`/tasks/${t.id}/lineage`);
      assert.equal(lin.source, 'events');
      assert.equal(lin.tree.kind, 'task');
      assert.equal(lin.tree.status, 'review');
      const plan = lin.tree.children[0];
      assert.equal(plan.kind, 'plan');
      assert.ok(plan.children.some((n) => n.kind === 'step' || n.kind === 'attempt' || (n.children || []).some((c) => c.kind === 'attempt' || c.kind === 'step')));
      const flat = JSON.stringify(plan);
      assert.match(flat, /attempt|step/);
      assert.equal(fs.existsSync(path.join(S.base, 'stub-aider.log')) || /cursor/.test(flat), true);
    } finally { await S.stop(); }
  });
});

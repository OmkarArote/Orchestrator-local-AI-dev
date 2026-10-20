'use strict';
// M3: multi-file detection. v1 warns and stays local. v2 routes engine auto to the Cursor planner. No schema change.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { isMultiFile } = require('../lib/flow/plan');

const evs = async (S, id) => S.get(`/tasks/${id}/events`);
const aiderCount = (S) => {
  const p = path.join(S.base, 'stub-aider.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0;
};
const cursorLog = (S) => {
  const p = path.join(S.base, 'stub-agent.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

describe('M33 isMultiFile', () => {
  it('is true for two prompt paths, resolved identifiers, hits in more than two directories, or difficulty complex', () => {
    assert.equal(isMultiFile('edit src/a.js').multi, false);
    assert.equal(isMultiFile('edit src/a.js and lib/b.js').multi, true);
    assert.deepEqual(isMultiFile('edit src/a.js and lib/b.js').paths, ['src/a.js', 'lib/b.js']);
    const named = isMultiFile('update product and order', { index: ['src/models/product.js', 'src/services/order.js', 'src/app.js'] });
    assert.equal(named.multi, true);
    assert.deepEqual(named.paths, ['src/models/product.js', 'src/services/order.js']);
    assert.equal(isMultiFile('fix the bug', { files: ['a/x.js', 'b/y.js', 'c/z.js'] }).multi, true);
    assert.equal(isMultiFile('fix the bug', { files: ['a/x.js', 'a/y.js', 'b/z.js'] }).multi, false);
    assert.equal(isMultiFile('edit a.js', { difficulty: 'complex' }).reason, 'files');
    assert.equal(isMultiFile('edit a.js', { route: { difficulty: 'complex' } }).multi, true);
    assert.equal(isMultiFile('rename a local variable').multi, false);
  });
});

describe('M33 multi-file routing', () => {
  const prompt = 'edit src/a.js and lib/b.js';
  async function boot(flow) {
    const S = await startServer({ env: { ORCH_FLOW: flow } });
    const repo = makeRepo(path.join(S.work, 'm33'), { 'src/a.js': 'a\n', 'lib/b.js': 'b\n' });
    const P = await S.addProject(repo, 'm33', 'true');
    return { S, P };
  }

  it('v1 only warns and still runs aider, even when escalation is allowed', async () => {
    const { S, P } = await boot('v1');
    try {
      const t = await S.runToReview(P.id, { title: 'v1', prompt, engine: 'auto', allow_escalation: true });
      const events = await evs(S, t.id);
      assert.ok(events.some((e) => e.kind === 'system' && /WARNING: multi-file prompt \(src\/a\.js, lib\/b\.js\)/.test(e.message)));
      assert.equal(events.some((e) => e.kind === 'route'), false);
      assert.equal(aiderCount(S) > 0, true);
      assert.doesNotMatch(cursorLog(S), /mode=plan/);
      assert.equal(t.status, 'review');
    } finally { await S.stop(); }
  });

  it('v2 keeps a 2-file prompt local (no Cursor planner); ORCH_V2_LOCAL_FAILS_BEFORE_CURSOR=0 restores the Cursor planner', async () => {
    const { S, P } = await boot('v2');
    try {
      const n = aiderCount(S);
      const t = await S.runToReview(P.id, { title: 'v2', prompt, engine: 'auto', allow_escalation: true }, 'review');
      const events = await evs(S, t.id);
      assert.ok(aiderCount(S) > n, 'aider ran');
      assert.doesNotMatch(cursorLog(S), /mode=force/, 'no Cursor edit run (the stub Ollama gives no plan JSON, so only the plan falls back after the local retry)');
      assert.ok(events.some((e) => e.kind === 'route' && /route local: 2 file\(s\) fit one local pass/.test(e.message)));
      assert.equal(t.status, 'review');
    } finally { await S.stop(); }
    const S2 = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_V2_LOCAL_FAILS_BEFORE_CURSOR: '0' } });
    try {
      const P2 = await S2.addProject(makeRepo(path.join(S2.work, 'm33b'), { 'src/a.js': 'a\n', 'lib/b.js': 'b\n' }), 'm33b', 'true');
      const n = aiderCount(S2);
      const t = await S2.runToReview(P2.id, { title: 'v2', prompt, engine: 'auto', allow_escalation: true }, 'review');
      const events = await evs(S2, t.id);
      assert.equal(aiderCount(S2), n);
      assert.match(cursorLog(S2), /mode=plan/);
      assert.ok(events.some((e) => e.kind === 'route' && /route files:/.test(e.message)));
      assert.ok(t.plan_text);
    } finally { await S2.stop(); }
  });

  it('v2 splits a prompt naming more than 3 files into a pending stacked sequence and runs nothing', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_SPLIT_AUTORUN: '0' } });
    try {
      const files = { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'lib/c.js': 'c\n', 'lib/d.js': 'd\n' };
      const P = await S.addProject(makeRepo(path.join(S.work, 'm33c'), files), 'm33c', 'true');
      const n = aiderCount(S);
      const t = await S.runToReview(P.id, { title: 'big', prompt: 'edit src/a.js, src/b.js, lib/c.js and lib/d.js', engine: 'auto', allow_escalation: true }, 'failed');
      assert.equal(aiderCount(S), n, 'aider never started');
      assert.doesNotMatch(cursorLog(S), /mode=/);
      assert.match(t.result_summary, /^split into sequence #\d+: #\d+, #\d+/);
      const parts = (await S.get('/tasks')).filter((x) => /big - part \d\/2/.test(x.title));
      assert.equal(parts.length, 2);
      for (const p of parts) { assert.equal(p.status, 'pending'); assert.ok(p.files.length <= 3); assert.ok(p.group_id); }
      assert.deepEqual(parts.flatMap((p) => p.files).sort(), Object.keys(files).sort());
    } finally { await S.stop(); }
  });

  it('a single-file auto prompt does not warn and does not open the planner', async () => {
    const { S, P } = await boot('v1');
    try {
      const t = await S.runToReview(P.id, { title: 'one', prompt: 'edit src/a.js', files: ['src/a.js'], engine: 'auto' });
      const events = await evs(S, t.id);
      assert.equal(events.some((e) => /multi-file prompt/.test(e.message)), false);
      assert.doesNotMatch(cursorLog(S), /mode=plan/);
    } finally { await S.stop(); }
  });
});

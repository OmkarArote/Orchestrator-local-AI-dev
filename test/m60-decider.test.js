'use strict';
// Scope gate. Laya when it is up, ornith when it is not. The coder only keeps approved files. Off by default.
require('./helpers/temp-env');
process.env.ORCH_LAYA_AUTOSTART = '0';
const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');
const { labelOf, band } = require('../lib/decider/confidence');
const { decide } = require('../lib/decider/index');
const { run, questionsFor } = require('../lib/decider/gate');
const laya = require('../lib/decider/laya');
const { revertOutside } = require('../lib/decider/revert');

const VISIT = 'src/visit.service.js';
const BOOK = 'src/book.service.js';

function answers({ visit = 0.95, book = 0.05, route = 'local-small', routeP = 0.95, risk = 1, riskP = 0.95 } = {}) {
  return {
    ok: true,
    answers: {
      [`in_scope:${VISIT}`]: { p: visit },
      [`in_scope:${BOOK}`]: { p: book },
      route: { choice: route, probs: { 'local-small': route === 'local-small' ? routeP : 0.01, 'local-ornith': route === 'local-ornith' ? routeP : 0.01, split: route === 'split' ? routeP : 0.01, cursor: route === 'cursor' ? routeP : 0.01 } },
      risk: { value: risk, p: riskP },
    },
    confidence: Math.min(visit, routeP, riskP),
  };
}

describe('decider bands', () => {
  it('scores a yes, a no, a choice and a score, and bands them', () => {
    const noul = { id: 'a', type: 'noul', text: 'in?' };
    assert.equal(labelOf(noul, { p: 0.95 }).label, true);
    assert.equal(labelOf(noul, { p: 0.95 }).confidence, 0.95);
    assert.equal(labelOf(noul, { p: 0.1 }).label, false);
    assert.ok(labelOf(noul, { p: 0.1 }).confidence >= 0.9);
    const choice = { id: 'route', type: 'choice', options: ['local-small', 'cursor'] };
    assert.equal(labelOf(choice, { choice: 'local-small', probs: { 'local-small': 0.7 } }).confidence, 0.7);
    assert.equal(labelOf({ type: 'score', min: 0, max: 3 }, { value: 4, p: 0.9 }).label, null);
    assert.equal(band(0.95), 'act');
    assert.equal(band(0.7), 'ask');
    assert.equal(band(0.4), 'escalate');
  });

  it('uses ornith when Laya is down, and Laya when the sidecar answers', async () => {
    const down = await decide('state', [{ id: 'route', type: 'choice', text: 'r', options: ['cursor'] }], {
      layaDecide: async () => ({ ok: false, error: 'down' }),
      ornithDecide: async () => ({ ok: true, answers: { route: { choice: 'cursor', probs: { cursor: 0.91 } } }, confidence: 0.91, model: 'ornith:9b' }),
    });
    assert.equal(down.backend, 'ornith');
    const up = await decide('state', [], {
      layaDecide: async () => ({ ok: true, answers: { a: { p: 0.99 } }, confidence: 0.99 }),
      ornithDecide: async () => { throw new Error('should not run'); },
    });
    assert.equal(up.backend, 'laya');
  });

  it('talks to a fake sidecar and does not start Python when autostart is off', async () => {
    process.env.ORCH_LAYA_AUTOSTART = '0';
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ ok: true, model_loaded: true }));
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        assert.equal(body.questions[0].type, 'noul');
        res.end(JSON.stringify({ answers: { 'in_scope:a.js': { p: 0.97 } }, confidence: 0.97, backend: 'laya' }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.ORCH_LAYA_PORT = String(server.address().port);
    try {
      const got = await laya.decide('task', [{ id: 'in_scope:a.js', type: 'noul', text: 'in?' }]);
      assert.equal(got.ok, true);
      assert.equal(got.answers['in_scope:a.js'].p, 0.97);
      const dead = await laya.health();
      assert.equal(dead.ok, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.ORCH_LAYA_PORT;
    }
  });
});

describe('scope gate', () => {
  const files = [{ path: VISIT, summary: 'visit checkout' }, { path: BOOK, summary: 'books' }];

  it('keeps only the high-confidence file', async () => {
    const gate = await run({ prompt: 'checkout', files, decideFn: async () => ({ ...answers(), backend: 'laya' }), installed: ['qwen2.5-coder:7b', 'ornith:9b'] });
    assert.equal(gate.action, 'act');
    assert.deepEqual(gate.files, [VISIT]);
    assert.deepEqual(gate.excluded, [BOOK]);
    assert.equal(gate.route, 'local-small');
    assert.equal(gate.model, 'qwen2.5-coder:7b');
    assert.equal(gate.backend, 'laya');
  });

  it('asks when a probability sits between the thresholds', async () => {
    const gate = await run({ prompt: 'checkout', files, decideFn: async () => ({ ...answers({ visit: 0.7 }), backend: 'ornith' }) });
    assert.equal(gate.action, 'ask');
    assert.ok(gate.files.includes(VISIT));
  });

  it('escalates when the route is not confident', async () => {
    const gate = await run({ prompt: 'checkout', files, decideFn: async () => ({ ...answers({ routeP: 0.4 }), backend: 'ornith' }) });
    assert.equal(gate.action, 'escalate');
    assert.equal(gate.route, 'cursor');
    assert.deepEqual(gate.files, []);
    const qs = questionsFor('checkout', files);
    assert.equal(qs.questions.filter((q) => q.type === 'noul').length, 2);
    assert.ok(qs.state.includes('visit checkout'));
  });
});

describe('revert outside scope', () => {
  it('drops a file the gate did not approve', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rev-')));
    const repo = makeRepo(dir, { 'a.js': 'a\n', 'b.js': 'b\n' });
    fs.writeFileSync(path.join(repo, 'a.js'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'c.js'), 'new\n');
    const dropped = await revertOutside(repo, ['a.js']);
    assert.deepEqual(dropped.reverted, ['c.js']);
    assert.equal(fs.readFileSync(path.join(repo, 'a.js'), 'utf8'), 'changed\n');
    assert.equal(fs.existsSync(path.join(repo, 'c.js')), false);
    git(repo, 'checkout', '--', '.');
  });
});

function gateReply(user, spec) {
  const text = String(user || '');
  if (text.includes('"type":"noul"') || text.includes('in_scope:') || text.includes('scope judge')) {
    return JSON.stringify({
      answers: {
        [`in_scope:${VISIT}`]: { p: spec.visit },
        [`in_scope:${BOOK}`]: { p: spec.book },
        route: { choice: 'local-small', probs: { 'local-small': spec.routeP, 'local-ornith': 0.01, split: 0.01, cursor: 0.02 } },
        risk: { value: 1, p: 0.95 },
      },
      confidence: spec.visit,
    });
  }
  return JSON.stringify({ steps: [{ id: '1', file: VISIT, intent: 'keep dto', acceptance: 'returns dto' }], risk: { files: 1 } });
}

describe('decider on a v2 task', () => {
  const repoFiles = {
    [VISIT]: 'export function checkOut(dto) { return dto; }\n',
    [BOOK]: 'export function editBook() { return 1; }\n',
  };

  it('does not pause when the flag is off', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '0', ORCH_LAYA_AUTOSTART: '0' } });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), repoFiles);
      const { id } = await S.addProject(repo, 'off', 'true');
      const task = await S.runToReview(id, { title: 'off', prompt: `Edit ${VISIT} checkOut.`, engine: 'auto' });
      assert.equal(task.status, 'review');
      assert.notEqual(task.routing_state, 'gate');
    } finally { await S.stop(); }
  });

  it('pauses between 0.60 and 0.90 and continues after approve-gate', async () => {
    const S = await startServer({
      env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '1', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: '9' },
    });
    S.fake.state.chatReply = (_u, _b, user) => gateReply(user, { visit: 0.72, book: 0.04, routeP: 0.93 });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), repoFiles);
      const { id } = await S.addProject(repo, 'ask', 'true');
      const created = await S.createTask(id, { title: 'ask', prompt: `Edit checkOut in ${VISIT}. Leave the book file alone.`, files: [VISIT, BOOK], engine: 'auto' });
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const task = await S.waitFor(async () => {
        const t = await S.get(`/tasks/${created.id}`);
        return ['awaiting_approval', 'review', 'failed'].includes(t.status) ? t : null;
      }, { timeout: 20000, what: 'gate pause' });
      if (task.status !== 'awaiting_approval') {
        const ev = await S.get(`/tasks/${task.id}/events`);
        assert.fail(`${task.status} ${task.result_summary || ''}\n${ev.map((e) => `${e.kind}: ${e.message}`).join('\n')}`);
      }
      assert.equal(task.routing_state, 'gate');
      assert.equal(task.routing.backend, 'ornith');
      const lin = await S.get(`/tasks/${task.id}/lineage`);
      assert.match(JSON.stringify(lin.tree), /decision/);
      const next = await S.post(`/tasks/${task.id}/approve-gate`, {});
      assert.equal(next.status, 'approved');
      const done = await S.waitStatus(task.id, 'review');
      assert.equal(done.status, 'review');
    } finally { await S.stop(); }
  });

  it('does not call the local coder when confidence is below 0.60', async () => {
    const S = await startServer({
      env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '1', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: '9' },
    });
    S.fake.state.chatReply = (_u, _b, user) => gateReply(user, { visit: 0.95, book: 0.05, routeP: 0.4 });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), repoFiles);
      const { id } = await S.addProject(repo, 'low', 'true');
      const task = await S.runToReview(id, { title: 'low', prompt: `Edit checkOut in ${VISIT}.`, engine: 'auto' });
      assert.equal(task.status, 'review');
      const events = await S.get(`/tasks/${task.id}/events`);
      const decision = events.map((e) => e.message).find((m) => m.includes('"phase":"decision"'));
      assert.match(decision, /escalate/);
      const log = path.join(S.base, 'stub-aider.log');
      const aider = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      assert.equal(aider.includes('visit.service'), false);
    } finally { await S.stop(); }
  });
});

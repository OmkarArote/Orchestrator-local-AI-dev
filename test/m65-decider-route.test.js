'use strict';
// A null decider answer pauses. Ornith cannot auto-act. A split stays local in parts of at most 3.
require('./helpers/temp-env');
process.env.ORCH_LAYA_AUTOSTART = '0';
const http = require('node:http');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');
const { run } = require('../lib/decider/gate');
const { choose } = require('../lib/routing/decide');

const FILE = 'src/a.js';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); }
    });
  });
}

describe('invalid answers and the ornith cap', () => {
  const files = [{ path: FILE, summary: 'a' }];

  it('retries a null route and risk once, then returns invalid', async () => {
    let calls = 0;
    const gate = await run({
      prompt: 'edit a',
      files,
      decideFn: async (_state, questions) => {
        calls += 1;
        const answers = { [`in_scope:${FILE}`]: { p: 0.96 } };
        if (calls > 1) {
          assert.ok(questions.some((q) => q.id === 'route'));
          assert.ok(questions.every((q) => q.id === 'route' || q.id === 'risk'));
        }
        return { ok: true, answers, confidence: 0.96, backend: 'laya' };
      },
    });
    assert.equal(calls, 2);
    assert.equal(gate.action, 'invalid');
    assert.equal(gate.route, null);
    assert.ok(gate.items.find((it) => it.id === 'route' && it.invalid && it.retried));
    assert.ok(gate.items.find((it) => it.id === 'risk' && it.invalid));
  });

  it('stores an ornith confidence above 0.90 capped at 0.85 and asks', async () => {
    const gate = await run({
      prompt: 'edit a',
      files,
      decideFn: async () => ({
        ok: true,
        backend: 'ornith',
        confidence: 0.97,
        answers: {
          [`in_scope:${FILE}`]: { p: 0.97 },
          route: { choice: 'local-small', probs: { 'local-small': 0.97, 'local-ornith': 0.01, split: 0.01, cursor: 0.01 } },
          risk: { value: 1, p: 0.97 },
        },
      }),
    });
    assert.equal(gate.action, 'ask');
    assert.equal(gate.backend, 'ornith');
    assert.ok(gate.items.every((it) => it.confidence <= 0.85));
    assert.equal(gate.items.find((it) => it.id === 'route').confidence, 0.85);
  });

  it('does not promote split to cursor because of file count', () => {
    const stayed = choose({ from: 'split', files: 13, tokens: 100, localFails: 0 });
    assert.equal(stayed.route, 'split');
    assert.match(stayed.reasons.join(' '), /files 13/);
  });
});

describe('routing off Cursor', () => {
  it('pauses a null route and risk and does not call Cursor', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '1', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: '9' } });
    S.fake.state.chatReply = (_u, _b, user) => {
      if (!user.includes('"type":"noul"')) return JSON.stringify({ steps: [] });
      return JSON.stringify({ answers: { [`in_scope:${FILE}`]: { p: 0.96 } }, confidence: 0.2 });
    };
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { [FILE]: 'exports.a = 1;\n' });
      const { id } = await S.addProject(repo, 'null', 'true');
      const created = await S.createTask(id, { title: 'null', prompt: `Edit ${FILE}.`, files: [FILE], engine: 'auto' });
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const task = await S.waitStatus(created.id, ['awaiting_approval', 'review', 'failed']);
      assert.equal(task.status, 'awaiting_approval');
      assert.equal(task.routing_state, 'gate');
      const events = await S.get(`/tasks/${task.id}/events`);
      const decision = events.map((e) => e.message).find((m) => m.includes('"phase":"decision"'));
      assert.match(decision, /invalid/);
      assert.match(decision, /retried/);
      const log = path.join(S.base, 'stub-agent.log');
      const cursor = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      assert.equal(cursor.includes('mode='), false);
      const chats = S.fake.state.requests.filter((r) => r.path === '/api/chat' && JSON.stringify(r.body).includes('route'));
      assert.equal(chats.length, 2);
    } finally { await S.stop(); }
  });

  it('splits 13 pinned files into parts of at most 3 and does not call Cursor', async () => {
    const names = Array.from({ length: 13 }, (_x, i) => `src/f${String(i).padStart(2, '0')}.js`);
    const laya = await listen(async (req, res) => {
      const body = await readBody(req);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
      const answers = {};
      for (const q of body.questions || []) {
        if (q.type === 'noul') answers[q.id] = { p: 0.97 };
        if (q.id === 'route') answers.route = { choice: 'split', probs: { split: 0.97, 'local-small': 0.01, 'local-ornith': 0.01, cursor: 0.01 } };
        if (q.id === 'risk') answers.risk = { value: 1, p: 0.97 };
      }
      res.end(JSON.stringify({ answers, confidence: 0.97 }));
    });
    const S = await startServer({
      env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '1', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: String(laya.port) },
    });
    S.fake.state.chatReply = () => JSON.stringify({
      targetBranch: null,
      steps: [{ id: '1', file: names[0], intent: 'touch', acceptance: 'ok', estLines: 1 }],
      risk: { files: 1, crossModule: false, contract: false, estDiff: 1 },
    });
    try {
      const repoFiles = Object.fromEntries(names.map((n) => [n, 'exports.n = 1;\n']));
      const repo = makeRepo(path.join(S.work, 'api'), repoFiles);
      const { id } = await S.addProject(repo, 'split', 'true');
      const created = await S.createTask(id, { title: 'thirteen', prompt: 'Touch the pinned files.', files: names, engine: 'auto' });
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const task = await S.waitStatus(created.id, ['failed', 'review', 'awaiting_approval']);
      assert.equal(task.status, 'failed');
      assert.equal(task.routing_state, 'split');
      const parts = (await S.get(`/tasks?project_id=${id}`)).filter((t) => t.id !== task.id);
      assert.ok(parts.length >= 5, `expected parts, got ${parts.length}`);
      assert.ok(parts.every((p) => (p.files || []).length <= 3 && (p.files || []).length > 0));
      assert.ok(parts.some((p) => p.status === 'approved' || p.status === 'running' || p.status === 'review'));
      const log = path.join(S.base, 'stub-agent.log');
      const cursor = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      assert.equal(cursor.includes('mode='), false);
      const events = await S.get(`/tasks/${task.id}/events`);
      assert.ok(events.some((e) => e.kind === 'route' && e.message.includes('"engine":"split"') && e.message.includes('"rule":"decider"')));
    } finally { await S.stop(); await laya.close(); }
  });

  it('answers a question follow-up locally with no commit and no Cursor', async () => {
    const laya = await listen(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
      res.end(JSON.stringify({ answers: { needs_code_change: { p: 0.04 } }, confidence: 0.96 }));
    });
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '0', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: String(laya.port) } });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'base\n' });
      const { id } = await S.addProject(repo, 'ask', 'true');
      const first = await S.runToReview(id, { title: 'edit', prompt: 'change a.txt', files: ['a.txt'], engine: 'auto' });
      const head = first.head_sha;
      const cursorBefore = fs.existsSync(path.join(S.base, 'stub-agent.log')) ? fs.readFileSync(path.join(S.base, 'stub-agent.log'), 'utf8') : '';
      const aiderBefore = fs.existsSync(path.join(S.base, 'stub-aider.log')) ? fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8') : '';
      S.fake.state.chatReply = (_u, _b, user) => (user.includes('Do not edit files') ? 'The null route paused the task. No code was changed.' : 'not the answer');
      await S.post(`/tasks/${first.id}/follow-up`, { instruction: 'why did this go to Cursor?' });
      const second = await S.waitStatus(first.id, ['review', 'awaiting_approval', 'failed']);
      assert.equal(second.status, 'review');
      assert.equal(second.head_sha, head);
      assert.match(second.result_summary, /No code was changed/);
      const cursorAfter = fs.existsSync(path.join(S.base, 'stub-agent.log')) ? fs.readFileSync(path.join(S.base, 'stub-agent.log'), 'utf8') : '';
      const aiderAfter = fs.existsSync(path.join(S.base, 'stub-aider.log')) ? fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8') : '';
      assert.equal(cursorAfter, cursorBefore);
      assert.equal(aiderAfter, aiderBefore);
      const lin = await S.get(`/tasks/${first.id}/lineage`);
      assert.match(JSON.stringify(lin.tree), /needs_code_change/);
    } finally { await S.stop(); await laya.close(); }
  });

  it('names the ornith fallback when Laya is down', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_DECIDER: '1', ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: '9' } });
    S.fake.state.chatReply = (_u, _b, user) => {
      if (!user.includes('"type":"noul"')) return JSON.stringify({ steps: [] });
      return JSON.stringify({
        answers: {
          [`in_scope:${FILE}`]: { p: 0.7 },
          route: { choice: 'local-small', probs: { 'local-small': 0.7, 'local-ornith': 0.1, split: 0.1, cursor: 0.1 } },
          risk: { value: 1, p: 0.7 },
        },
        confidence: 0.7,
      });
    };
    try {
      const status = await S.get('/decider/status');
      assert.equal(status.backend, 'ornith');
      assert.equal(status.laya, false);
      assert.equal(status.ornith, true);
      await S.waitFor(() => (S.logs().includes('[startup] decider ornith') ? true : null), { what: 'startup decider log' });
      const repo = makeRepo(path.join(S.work, 'api'), { [FILE]: 'exports.a = 1;\n' });
      const { id } = await S.addProject(repo, 'health', 'true');
      const created = await S.createTask(id, { title: 'health', prompt: `Edit ${FILE}.`, files: [FILE], engine: 'auto' });
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const task = await S.waitStatus(created.id, 'awaiting_approval');
      const events = await S.get(`/tasks/${task.id}/events`);
      const decision = events.map((e) => e.message).find((m) => m.includes('"phase":"decision"'));
      assert.match(decision, /ornith/);
      assert.match(decision, /fallback/);
      const lin = await S.get(`/tasks/${task.id}/lineage`);
      assert.match(JSON.stringify(lin.tree), /fallback/);
    } finally { await S.stop(); }
  });
});

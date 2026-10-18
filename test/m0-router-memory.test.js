'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

describe('M0 router (fake Ollama) and memory proposals', () => {
  let S, repo, P, svcWeb, svcApi;
  const reply = (obj) => { S.fake.state.chatReply = () => (typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'rt'), { 'api/pyproject.toml': '[p]\n', 'api/app.py': 'x=1\n', 'web/go.mod': 'module web\n', 'web/main.go': 'package main\n' });
    P = await S.addProject(repo, 'rt', 'true');
    svcApi = await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'api', description: 'python backend api endpoints' });
    svcWeb = await S.post(`/projects/${P.id}/services`, { name: 'web', path: 'web', description: 'web frontend pages and ui' });
  });
  after(async () => { await S.stop(); });

  it('LLM suggestion used when valid and confident', async () => {
    reply({ service: 'web', confidence: 0.9, difficulty: 'simple', needs_thinking: false, reason: 'ui' });
    const r = await S.post(`/projects/${P.id}/route`, { prompt: 'change the page title' });
    assert.equal(r.suggestion.source, 'llm');
    assert.equal(r.suggestion.service, 'web');
    assert.equal(r.suggestion.service_id, svcWeb.id);
    assert.equal(r.suggestion.policy.engine, 'auto');
    assert.equal(r.suggestion.policy.allow_escalation, true);
  });

  it('complex task -> complex_engine policy (cursor, plan first)', async () => {
    reply({ service: 'api', confidence: 0.8, difficulty: 'complex', needs_thinking: true, reason: 'design' });
    const r = await S.post(`/projects/${P.id}/route`, { prompt: 'redesign the api' });
    assert.equal(r.suggestion.policy.engine, 'cursor');
    assert.equal(r.suggestion.policy.plan_first, true);
  });

  it('low confidence / garbage / http error -> keyword fallback', async () => {
    reply({ service: 'api', confidence: 0.1, difficulty: 'simple', needs_thinking: false, reason: 'unsure' });
    let r = await S.post(`/projects/${P.id}/route`, { prompt: 'fix the web page title' });
    assert.equal(r.suggestion.source, 'keyword');
    assert.equal(r.suggestion.service, 'web');
    reply('this is not json at all');
    r = await S.post(`/projects/${P.id}/route`, { prompt: 'fix the python api endpoints' });
    assert.equal(r.suggestion.source, 'keyword');
    assert.equal(r.suggestion.service, 'api');
    reply('__HTTP500__');
    r = await S.post(`/projects/${P.id}/route`, { prompt: 'fix the web ui' });
    assert.equal(r.suggestion.source, 'keyword');
    assert.match(r.llm.error, /HTTP 500/);
    reply({ service: 'nonexistent', confidence: 0.99, difficulty: 'simple', needs_thinking: false, reason: 'x' });
    r = await S.post(`/projects/${P.id}/route`, { prompt: 'fix the web ui' });
    assert.equal(r.suggestion.source, 'keyword');
  });

  it('service=auto on task creation: routed, then approve-start with use_routing applies it', async () => {
    reply({ service: 'web', confidence: 0.95, difficulty: 'simple', needs_thinking: false, reason: 'ui' });
    const t = await S.post('/tasks', { project_id: P.id, title: 'auto svc', prompt: 'change web page', service_id: 'auto', engine: 'auto-route' });
    assert.equal(t.route_requested, true);
    const routed = await S.waitFor(async () => { const x = await S.get(`/tasks/${t.id}`); return x.routing_state === 'done' ? x : null; }, { what: 'routing done' });
    assert.equal(routed.routing.suggestion.service, 'web');
    assert.equal((await S.post(`/tasks/${t.id}/reroute`, {})).routing_state, 'routing');
    await S.waitFor(async () => (await S.get(`/tasks/${t.id}`)).routing_state === 'done', { what: 'reroute done' });
    const a = await S.post(`/tasks/${t.id}/approve-start`, { use_routing: true, service_id: svcWeb.id, engine: 'local' });
    assert.equal(a.service_id, svcWeb.id);
    assert.equal(a.engine, 'local');
    await S.waitStatus(t.id, ['review', 'failed']);
  });
});

describe('M0 memory proposals', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'mem'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'mem', 'true');
  });
  after(async () => { await S.stop(); });

  it('proposal is created after review, edited, approved -> appended to MEMORY.md; reject keeps memory unchanged', async () => {
    const t = await S.runToReview(P.id, { title: 'mem task', prompt: 'edit', files: ['hello.txt'] });
    const prop = await S.waitFor(async () => (await S.get(`/memory-proposals?project_id=${P.id}&status=pending`))[0], { what: 'memory proposal' });
    assert.equal(prop.task_id, t.id);
    assert.match(prop.text, /fake memory note/);
    assert.equal((await S.get(`/projects/${P.id}/context`)).files.find((f) => f.name === 'MEMORY.md').exists, false);
    const upd = await S.post(`/memory-proposals/${prop.id}/update`, { text: '- edited note about conventions' });
    assert.match(upd.text, /edited note/);
    const ap = await S.post(`/memory-proposals/${prop.id}/approve`, {});
    assert.equal(ap.status, 'approved');
    const mem = (await S.get(`/projects/${P.id}/context`)).files.find((f) => f.name === 'MEMORY.md');
    assert.match(mem.content, /edited note about conventions/);
    assert.match(mem.content, new RegExp(`task #${t.id}`));
    assert.equal((await S.post(`/memory-proposals/${prop.id}/approve`, {}, { allowFail: true })).status, 409);
    const t2 = await S.runToReview(P.id, { title: 'mem task 2', prompt: 'edit', files: ['hello.txt'] });
    const p2 = await S.waitFor(async () => (await S.get(`/memory-proposals?project_id=${P.id}&status=pending`))[0], { what: 'second proposal' });
    await S.post(`/memory-proposals/${p2.id}/reject`, { reason: 'no' });
    const mem2 = (await S.get(`/projects/${P.id}/context`)).files.find((f) => f.name === 'MEMORY.md');
    assert.doesNotMatch(mem2.content, /Remember: keep fake tests/);
    assert.ok(t2.id);
  });

  it('memory_proposals=false disables drafting; unreachable LLM never breaks the task', async () => {
    await S.post(`/projects/${P.id}/update`, { settings: { memory_proposals: false } });
    const before = (await S.get(`/memory-proposals?project_id=${P.id}`)).length;
    await S.runToReview(P.id, { title: 'nomem', prompt: 'edit', files: ['hello.txt'] });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await S.get(`/memory-proposals?project_id=${P.id}`)).length, before);
    await S.post(`/projects/${P.id}/update`, { settings: { memory_proposals: true } });
    S.fake.state.chatReply = () => '__HTTP500__';
    const t = await S.runToReview(P.id, { title: 'llm down', prompt: 'edit', files: ['hello.txt'] });
    assert.equal(t.status, 'review');
  });
});

'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { branchOf, slugify } = require('../lib/paths');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('branch naming', () => {
  it('slug + id prefix', () => {
    assert.equal(branchOf({ id: 7, title: 'Add GET /health/mongo endpoint!' }), 'ai/task-7-add-get-health-mongo-endpoint');
    assert.equal(branchOf({ id: 7, title: '???' }), 'ai/task-7');
    assert.equal(branchOf({ id: 7, title: 'x', branch: 'ai/task-7-custom' }), 'ai/task-7-custom');
    assert.equal(branchOf(5), 'ai/task-5');
    assert.ok(slugify('a'.repeat(100)).length <= 40);
    assert.match(branchOf({ id: 1, title: 'Ünïcode  título  — test' }), /^ai\/task-1-[a-z0-9-]+$/);
  });
});

describe('branch naming in a real run', () => {
  let S, repo, P;
  before(async () => { S = await startServer(); repo = makeRepo(path.join(S.work, 'app'), { 'hello.txt': 'hi\n' }); P = await S.addProject(repo, 'app', 'test -f hello.txt'); });
  after(async () => { await S.stop(); });
  it('uses id+title, and avoids a stale branch with the same name', async () => {
    const t = await S.createTask(P.id, { title: 'Edit hello', prompt: 'append', files: ['hello.txt'] });
    git(repo, 'branch', `ai/task-${t.id}-edit-hello`); // stale branch collision
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const r = await S.waitStatus(t.id, 'review');
    assert.equal(r.branch, `ai/task-${t.id}-edit-hello-2`);
    assert.ok(git(repo, 'branch', '--list', r.branch).trim());
  });
});

describe('re-run of a failed task', () => {
  let S, repo, P;
  before(async () => { S = await startServer(); repo = makeRepo(path.join(S.work, 'app'), { 'hello.txt': 'hi\n' }); P = await S.addProject(repo, 'app', 'test -f hello.txt'); });
  after(async () => { await S.stop(); });
  it('clones a failed task into a new pending task; refuses other statuses', async () => {
    const t = await S.createTask(P.id, { title: 'Edit hello', prompt: 'append', files: ['hello.txt'] });
    const early = await S.post(`/tasks/${t.id}/rerun`, {}, { allowFail: true });
    assert.equal(early.status, 409, 'pending task cannot be re-run');
    await S.post(`/tasks/${t.id}/reject-start`, { reason: 'test' });
    const r = await S.post(`/tasks/${t.id}/rerun`, {});
    assert.notEqual(r.id, t.id);
    assert.equal(r.status, 'pending');
    assert.equal(r.title, 'Edit hello'); assert.equal(r.prompt, 'append'); assert.deepEqual(r.files, ['hello.txt']);
    assert.equal(r.service_id, t.service_id); assert.equal(r.engine, t.engine);
    assert.equal(r.group_id ?? null, null);
    const ev = await S.get(`/tasks/${r.id}/events`);
    assert.ok(ev.some((e) => new RegExp(`re-run of #${t.id}`).test(e.message || e.text || JSON.stringify(e))));
    // the new task runs normally
    await S.post(`/tasks/${r.id}/approve-start`, {});
    const done = await S.waitStatus(r.id, 'review');
    assert.match(done.branch, new RegExp(`^ai/task-${r.id}-edit-hello`));
  });
});

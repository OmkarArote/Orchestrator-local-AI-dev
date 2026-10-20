'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git, sleep } = require('./helpers/harness');

describe('approve without merging into the default branch', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'app'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'app', 'true');
  });
  after(async () => { await S.stop(); });

  it('accepts a review task and leaves the default branch at its recorded sha', async () => {
    const before = git(repo, 'rev-parse', 'HEAD').trim();
    const t = await S.runToReview(P.id, { title: 'Accept only', prompt: 'append a line', files: ['hello.txt'] });
    assert.equal(t.status, 'review');
    const r = await S.post(`/tasks/${t.id}/approve`, {});
    assert.equal(r.status, 'done');
    assert.match(r.result_summary, /approved without merging into main/);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'hi\n');
    assert.ok(git(repo, 'branch', '--list', t.branch).includes(t.branch));
    assert.ok(fs.existsSync(t.worktree_path), 'worktree kept');
    const full = await S.get(`/tasks/${t.id}`);
    assert.equal(full.approvals.some((a) => a.stage === 'merge'), false);
    const events = await S.get(`/tasks/${t.id}/events`);
    assert.ok(events.some((e) => e.kind === 'system' && /without merging into main/.test(e.message)));
    assert.equal((await S.post(`/tasks/${t.id}/approve`, {}, { allowFail: true })).status, 409);
    assert.equal((await S.post(`/tasks/${t.id}/approve-merge`, {}, { allowFail: true })).status, 409);
  });

  it('a merged-dependency sequence keeps waiting until the previous step is merged', async () => {
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'wait for a real merge', dependency: 'merged', steps: [
      { title: 'first', prompt: 'edit', files: ['hello.txt'], engine: 'local', service_id: P.serviceId },
      { title: 'second', prompt: 'edit', files: ['hello.txt'], engine: 'local', service_id: P.serviceId },
    ] });
    const [s1, s2] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(s1.id, 'review');
    await S.post(`/tasks/${s1.id}/approve`, {});
    await sleep(800);
    assert.equal((await S.get(`/tasks/${s2.id}`)).status, 'approved');
    const plan = await S.get(`/groups/${g.id}/merge-plan`);
    assert.equal(plan.steps.find((s) => s.task_id === s1.id).state, 'approved');
  });
});

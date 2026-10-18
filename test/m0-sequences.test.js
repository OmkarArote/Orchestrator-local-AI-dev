'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer, makeRepo, git, sleep } = require('./helpers/harness');

describe('M0 sequences (task groups)', () => {
  let S, repo, P, sv;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'seq'), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    P = await S.addProject(repo, 'seq', 'true');
    sv = P.serviceId ? { service_id: P.serviceId } : {};
  });
  after(async () => { await S.stop(); });
  const step = (title, files, extra = {}) => ({ title, prompt: extra.prompt || 'edit', files, engine: 'local', ...sv, ...extra });

  it('stack: step 2 is cut from step 1 branch once step 1 reached review; merges in order', async () => {
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'stack seq', dependency: 'stack', steps: [step('s1', ['a.txt']), step('s2', ['b.txt'])] });
    assert.equal(g.steps.length, 2);
    const [s1, s2] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(s1.id, 'review'); const r2 = await S.waitStatus(s2.id, 'review');
    assert.equal(r2.base_ref, s1.branch || (await S.get(`/tasks/${s1.id}`)).branch);
    assert.match(r2.base_ref, new RegExp(`^ai/task-${s1.id}`));
    assert.match(git(repo, 'log', '--format=%s', r2.branch), new RegExp(`ai/task-${s1.id}`));
    assert.equal((await S.get(`/groups/${g.id}`)).steps.length, 2);
    await S.post(`/tasks/${s1.id}/approve-merge`, {});
    await S.post(`/tasks/${s2.id}/approve-merge`, {});
    assert.match(git(repo, 'show', 'HEAD:a.txt'), /edited by stub-aider/);
    assert.match(git(repo, 'show', 'HEAD:b.txt'), /edited by stub-aider/);
  });

  it('merged: step 2 waits until step 1 is merged', async () => {
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'merged seq', dependency: 'merged', steps: [step('m1', ['a.txt']), step('m2', ['b.txt'])] });
    const [s1, s2] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(s1.id, 'review');
    await sleep(1200);
    assert.equal((await S.get(`/tasks/${s2.id}`)).status, 'approved', 'step 2 must still wait');
    await S.post(`/tasks/${s1.id}/approve-merge`, {});
    await S.waitStatus(s2.id, 'review');
  });

  it('a failed step blocks the following one', async () => {
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'blocked seq', dependency: 'stack', steps: [step('f1', ['a.txt'], { prompt: 'STUB_FAIL' }), step('f2', ['b.txt'])] });
    const [s1, s2] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(s1.id, 'failed');
    const r2 = await S.waitStatus(s2.id, 'failed');
    assert.match(r2.result_summary, /not run: previous step/);
  });

  it('reject whole sequence / validation', async () => {
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'rej seq', steps: [step('r1', ['a.txt']), step('r2', ['b.txt'])] });
    assert.equal((await S.post(`/groups/${g.id}/reject`, {}, { allowFail: true })).status, 400);
    await S.post(`/groups/${g.id}/reject`, { reason: 'nope' });
    assert.ok((await S.get(`/groups/${g.id}`)).steps.every((s) => s.status === 'rejected'));
    assert.equal((await S.post(`/projects/${P.id}/groups`, { title: 'x', dependency: 'bogus', steps: [step('a', [])] }, { allowFail: true })).status, 400);
    assert.equal((await S.post(`/projects/${P.id}/groups`, { title: 'x', steps: [] }, { allowFail: true })).status, 400);
    assert.equal((await S.post(`/projects/${P.id}/groups`, { title: 'x', steps: [{ ...step('a', []), engine: 'auto-route' }] }, { allowFail: true })).status, 400);
  });
});

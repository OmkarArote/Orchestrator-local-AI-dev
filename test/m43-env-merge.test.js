'use strict';
// Merge a review task into a configured dev/uat branch from a temporary worktree. The checkout stays put. No push unless asked.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('merge into a configured branch', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'api-seva'), { 'hello.txt': 'hi\n' });
    git(repo, 'branch', 'dev');
    git(repo, 'branch', 'uat');
    P = await S.addProject(repo, 'api-seva', 'test -f hello.txt');
    await S.post(`/services/${P.serviceId}/update`, { dev_branch: 'dev', uat_branch: 'uat' });
  });
  after(async () => { await S.stop(); });

  async function reviewed() {
    const t = await S.createTask(P.id, { title: 'Edit hello', prompt: 'append a line', files: ['hello.txt'] });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    return S.waitStatus(t.id, 'review');
  }

  it('fast-forwards dev after the check, and leaves the checkout and uat alone', async () => {
    const main = git(repo, 'rev-parse', 'main').trim();
    const dev = git(repo, 'rev-parse', 'dev').trim();
    const uat = git(repo, 'rev-parse', 'uat').trim();
    const head = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    const t = await reviewed();
    const early = await S.post(`/tasks/${t.id}/push-target`, { role: 'dev' }, { allowFail: true });
    assert.equal(early.status, 409);
    const r = await S.post(`/tasks/${t.id}/merge-to`, { role: 'dev' });
    assert.equal(r.merge.ok, true);
    assert.equal(git(repo, 'rev-parse', 'main').trim(), main);
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), head);
    const devNow = git(repo, 'rev-parse', 'dev').trim();
    assert.notEqual(devNow, dev);
    assert.equal(git(repo, 'merge-base', '--is-ancestor', dev, 'dev').trim(), '');
    assert.equal(git(repo, 'rev-parse', 'uat').trim(), uat);
    const events = await S.get(`/tasks/${t.id}/events`);
    assert.equal(events.some((e) => e.kind === 'merge' && /"status":"merged"/.test(e.message)), true);
    assert.equal(events.some((e) => e.kind === 'merge' && /"status":"pushed"/.test(e.message)), false);
    const bare = path.join(S.work, 'bare.git');
    git(repo, 'init', '--bare', bare);
    git(repo, 'remote', 'add', 'origin', bare);
    const pushed = await S.post(`/tasks/${t.id}/push-target`, { role: 'dev' });
    assert.match(pushed.push, /pushed dev/);
    assert.equal(git(bare, 'rev-parse', 'dev').trim(), devNow);
  });

  it('uat without confirm does not move, and a failing check rolls back', async () => {
    const t = await reviewed();
    const uat = git(repo, 'rev-parse', 'uat').trim();
    const denied = await S.post(`/tasks/${t.id}/merge-to`, { role: 'uat' }, { allowFail: true });
    assert.equal(denied.status, 409);
    assert.equal(denied.json.needs_confirm, true);
    assert.equal(denied.json.source, t.branch);
    assert.equal(denied.json.target, 'uat');
    assert.equal(git(repo, 'rev-parse', 'uat').trim(), uat);
    await S.post(`/services/${P.serviceId}/update`, { check_cmd: 'false' });
    const dev = git(repo, 'rev-parse', 'dev').trim();
    const failed = await S.post(`/tasks/${t.id}/merge-to`, { role: 'dev' }, { allowFail: true });
    assert.equal(failed.status, 409);
    assert.equal(git(repo, 'rev-parse', 'dev').trim(), dev);
    const events = await S.get(`/tasks/${t.id}/events`);
    assert.equal(events.some((e) => e.kind === 'merge' && e.message.includes('merge_rolled_back')), true);
    await S.post(`/services/${P.serviceId}/update`, { check_cmd: 'test -f hello.txt' });
  });
});

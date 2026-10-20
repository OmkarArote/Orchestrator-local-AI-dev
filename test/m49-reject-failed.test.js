'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('reject a failed task and delete its branch', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'app'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'app', 'true');
  });
  after(async () => { await S.stop(); });

  it('deletes the task branch and worktree and leaves the default branch', async () => {
    const before = git(repo, 'rev-parse', 'HEAD').trim();
    const t = await S.runToReview(P.id, { title: 'fail', prompt: 'STUB_FAIL please', files: ['hello.txt'] }, 'failed');
    assert.ok(t.branch);
    assert.ok(git(repo, 'branch', '--list', t.branch).includes(t.branch));
    assert.equal((await S.post(`/tasks/${t.id}/reject`, {}, { allowFail: true })).status, 400);
    const r = await S.post(`/tasks/${t.id}/reject`, { reason: 'drop the failed attempt' });
    assert.equal(r.status, 'rejected');
    assert.match(r.discarded, new RegExp(`deleted branch ${t.branch}`));
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'hi\n');
    assert.equal(git(repo, 'branch', '--list', t.branch).trim(), '');
    assert.equal(fs.existsSync(t.worktree_path), false);
    assert.equal((await S.get(`/tasks/${t.id}`)).worktree_path, null);
    assert.equal((await S.post(`/tasks/${t.id}/reject`, { reason: 'again' }, { allowFail: true })).status, 409);
  });

  it('refuses to delete a branch that is not this task branch', async () => {
    const t = await S.runToReview(P.id, { title: 'keep main', prompt: 'STUB_FAIL please', files: ['hello.txt'] }, 'failed');
    const real = t.branch;
    const db = new DatabaseSync(S.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('UPDATE tasks SET branch = ? WHERE id = ?').run('main', t.id);
    db.close();
    const r = await S.post(`/tasks/${t.id}/reject`, { reason: 'must not delete main' }, { allowFail: true });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /refusing to delete 'main'/);
    assert.equal((await S.get(`/tasks/${t.id}`)).status, 'failed');
    assert.ok(git(repo, 'branch', '--list', 'main').includes('main'));
    assert.ok(git(repo, 'branch', '--list', real).includes(real));
  });

  it('does not reject a task that is still in review', async () => {
    const t = await S.runToReview(P.id, { title: 'still review', prompt: 'edit', files: ['hello.txt'] });
    const r = await S.post(`/tasks/${t.id}/reject`, { reason: 'no' }, { allowFail: true });
    assert.equal(r.status, 409);
    assert.equal((await S.get(`/tasks/${t.id}`)).status, 'review');
    assert.ok(git(repo, 'branch', '--list', t.branch).includes(t.branch));
  });
});

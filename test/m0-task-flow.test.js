'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git, fingerprint } = require('./helpers/harness');

describe('M0 task lifecycle (local engine = stub aider)', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'app'), { 'hello.txt': 'hi\n', 'other.txt': 'o\n' });
    P = await S.addProject(repo, 'app', 'test -f hello.txt');
  });
  after(async () => { await S.stop(); });

  it('validation errors', async () => {
    const bad = async (body, re) => { const r = await S.post('/tasks', { project_id: P.id, service_id: P.serviceId ?? undefined, ...body }, { allowFail: true }); assert.equal(r.status >= 400 && r.status < 500, true, JSON.stringify(body)); if (re) assert.match(r.json.error, re); };
    await bad({ prompt: 'x' }, /title/);
    await bad({ title: 't' }, /prompt/);
    await bad({ title: 't', prompt: 'p', files: ['../x'] }, /invalid file/);
    await bad({ title: 't', prompt: 'p', files: ['/etc/passwd'] }, /invalid file/);
    await bad({ title: 't', prompt: 'p', engine: 'bogus' }, /engine/);
    await bad({ title: 't', prompt: 'p', allow_escalation: true }, /allow_escalation/);
    await bad({ title: 't', prompt: 'p', plan_first: true }, /plan_first/);
    const r = await S.post('/tasks', { project_id: 9999, title: 't', prompt: 'p' }, { allowFail: true });
    assert.equal(r.status, 400);
  });

  it('pending -> approve-start -> running -> review -> diff -> approve-merge -> done', async () => {
    const before = git(repo, 'rev-parse', 'HEAD').trim();
    const t = await S.createTask(P.id, { title: 'Edit hello', prompt: 'append a line', files: ['hello.txt'] });
    assert.equal(t.status, 'pending');
    assert.equal(t.engine, 'local');
    // not startable twice / reject needs reason
    assert.equal((await S.post(`/tasks/${t.id}/reject-start`, {}, { allowFail: true })).status, 400);
    const a = await S.post(`/tasks/${t.id}/approve-start`, {});
    assert.equal(a.status, 'approved');
    assert.equal((await S.post(`/tasks/${t.id}/approve-start`, {}, { allowFail: true })).status, 409);
    const r = await S.waitStatus(t.id, 'review');
    assert.match(r.branch, new RegExp(`^ai/task-${t.id}(-[a-z0-9-]+)?$`));
    assert.match(r.head_sha, /^[0-9a-f]{40}$/);
    assert.equal(r.engine_used, 'local');
    assert.match(r.result_summary, /aider: ok/);
    assert.match(r.result_summary, /check: PASSED/);
    assert.ok(r.worktree_path && fs.existsSync(r.worktree_path));
    assert.match(fs.readFileSync(path.join(r.worktree_path, 'hello.txt'), 'utf8'), /edited by stub-aider/);
    // main untouched until merge
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'hi\n');
    assert.ok(git(repo, 'branch', '--list', `ai/task-${t.id}*`).includes(`ai/task-${t.id}`));
    const d = await S.get(`/tasks/${t.id}/diff`);
    assert.match(d.diff, /^\+edited by stub-aider/m);
    assert.match(d.stat, /hello.txt/);
    const events = await S.get(`/tasks/${t.id}/events`);
    assert.ok(events.some((e) => e.kind === 'aider' && /stub-aider: done/.test(e.message)));
    assert.ok(events.some((e) => e.kind === 'git' && /committed/.test(e.message)));
    assert.ok(events.some((e) => e.kind === 'check'  || /check/.test(e.message)));
    // merge
    assert.equal((await S.post(`/tasks/${t.id}/reject-merge`, {}, { allowFail: true })).status, 400);
    const m = await S.post(`/tasks/${t.id}/approve-merge`, { reason: 'lgtm' });
    assert.equal(m.status, 'done');
    assert.match(m.merge, /merged ai\/task-\d+[a-z0-9-]* into main/);
    assert.match(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), /edited by stub-aider/);
    assert.match(git(repo, 'log', '--oneline', '-3'), /Merge ai\/task-/);
    assert.ok(!fs.existsSync(r.worktree_path), 'worktree removed after merge');
    assert.ok(git(repo, 'branch', '--list', `ai/task-${t.id}*`).trim(), 'branch kept');
    const full = await S.get(`/tasks/${t.id}`);
    assert.deepEqual(full.approvals.map((x) => `${x.stage}:${x.decision}`), ['start:approved', 'merge:approved']);
    assert.equal((await S.post(`/tasks/${t.id}/approve-merge`, {}, { allowFail: true })).status, 409);
  });

  it('aider failure -> failed (branch/worktree kept for inspection)', async () => {
    const t = await S.runToReview(P.id, { title: 'fail', prompt: 'STUB_FAIL please', files: ['hello.txt'] }, 'failed');
    assert.match(t.result_summary, /aider: FAILED \(exit 1\)/);
  });

  it('check failure -> failed but work is committed on the branch', async () => {
    const t = await S.runToReview(P.id, { title: 'bad check', prompt: 'edit', files: ['other.txt'], check_cmd: 'exit 3' }, 'failed');
    assert.match(t.result_summary, /check: FAILED \(exit 3/);
    assert.ok(t.head_sha);
    assert.match(git(repo, 'log', '--format=%s', '-1', t.branch), /\[check failed\]/);
  });

  it('no changes -> failed', async () => {
    const t = await S.runToReview(P.id, { title: 'noop', prompt: 'STUB_NOCHANGE', files: ['hello.txt'] }, 'failed');
    assert.match(t.result_summary, /no changes/);
  });

  it('reject-start and cancel a running task', async () => {
    const t = await S.createTask(P.id, { title: 'rej', prompt: 'x' });
    const r = await S.post(`/tasks/${t.id}/reject-start`, { reason: 'nope' });
    assert.equal(r.status, 'rejected');
    const slow = await S.createTask(P.id, { title: 'slow', prompt: 'STUB_SLOW', files: ['hello.txt'] });
    await S.post(`/tasks/${slow.id}/approve-start`, {});
    await S.waitFor(async () => (await S.get(`/tasks/${slow.id}/events`)).some((e) => /engine local: aider/.test(e.message)), { what: 'aider started' });
    await S.post(`/tasks/${slow.id}/cancel`, {});
    const done = await S.waitStatus(slow.id, 'failed');
    assert.ok(done.result_summary);
    assert.equal((await S.post(`/tasks/${slow.id}/cancel`, {}, { allowFail: true })).status, 409);
  });

  it('local tasks run strictly one at a time', async () => {
    const a = await S.createTask(P.id, { title: 'seq a', prompt: 'x', files: ['hello.txt'] });
    const b = await S.createTask(P.id, { title: 'seq b', prompt: 'y', files: ['other.txt'] });
    await S.post(`/tasks/${a.id}/approve-start`, {}); await S.post(`/tasks/${b.id}/approve-start`, {});
    await S.waitStatus(a.id, 'review'); await S.waitStatus(b.id, 'review');
    const ts = async (id, re) => (await S.get(`/tasks/${id}/events`)).find((e) => e.kind === 'status' && re.test(e.message)).ts;
    const aEnd = await ts(a.id, /running -> review|running -> failed|checking -> review/), bStart = await ts(b.id, /approved -> running/);
    assert.ok(bStart >= aEnd, `b started (${bStart}) before a finished (${aEnd})`);
  });

  it('archive is refused while a task is active', async () => {
    const t = await S.createTask(P.id, { title: 'act', prompt: 'x' });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const r = await S.post(`/projects/${P.id}/archive`, {}, { allowFail: true });
    // approved/running count as active
    assert.equal(r.status, 409);
    await S.waitStatus(t.id, 'review');
  });
});

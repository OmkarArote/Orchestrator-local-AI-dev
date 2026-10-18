'use strict';
// M8: multi-service tasks = sequences whose steps target different services (repos). One task = one repo = one branch = one merge approval.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('M8 multi-service sequences', () => {
  let S, P, X, Y, sx, sy, sxSub;
  const step = (title, svc, files, extra = {}) => ({ title, prompt: extra.prompt || 'edit', files, engine: 'local', service_id: svc.id, ...extra });
  const group = (b, o) => S.api('POST', `/projects/${P.id}/groups`, b, o);
  before(async () => {
    S = await startServer();
    X = makeRepo(path.join(S.work, 'repo-x'), { 'a.txt': 'a\n', 'c.txt': 'c\n', 'lib/l.txt': 'l\n' });
    Y = makeRepo(path.join(S.work, 'repo-y'), { 'b.txt': 'b\n' });
    P = (await S.post('/projects', { name: 'multi' })).project;
    sx = (await S.post(`/projects/${P.id}/services/add-existing`, { path: X, name: 'svc-x', check_cmd: 'true' })).service;
    sy = (await S.post(`/projects/${P.id}/services/add-existing`, { path: Y, name: 'svc-y', check_cmd: 'true' })).service;
    sxSub = (await S.post(`/projects/${P.id}/services/add-existing`, { path: path.join(X, 'lib'), name: 'svc-x-lib', check_cmd: 'true' })).service;
  });
  after(async () => { await S.stop(); });

  it('cross-repo group defaults to independent; stack across repos is rejected; same-repo stack still works', async () => {
    const bad = await group({ title: 'bad stack', dependency: 'stack', steps: [step('s1', sx, ['a.txt']), step('s2', sy, ['b.txt'])] }, { allowFail: true });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /same repository/);
    assert.equal((await group({ title: 'x', dependency: 'bogus', steps: [step('s1', sx, ['a.txt'])] }, { allowFail: true })).status, 400);
    const g = await group({ title: 'cross', steps: [step('s1', sx, ['a.txt']), step('s2', sy, ['b.txt'])] });
    assert.equal(g.dependency, 'independent'); assert.equal(g.cross_repo, true); assert.equal(g.repo_count, 2);
    assert.deepEqual(g.steps.map((s) => s.service_name), ['svc-x', 'svc-y']);
    const m = await group({ title: 'cross merged', dependency: 'merged', steps: [step('s1', sx, ['a.txt']), step('s2', sy, ['b.txt'])] });
    assert.equal(m.dependency, 'merged');
    const same = await group({ title: 'same repo', steps: [step('s1', sx, ['a.txt']), step('s2', sxSub, ['lib/l.txt'])] });
    assert.equal(same.dependency, 'stack'); assert.equal(same.cross_repo, false);
    const same2 = await group({ title: 'same repo explicit', dependency: 'stack', steps: [step('s1', sx, ['a.txt']), step('s2', sxSub, ['lib/l.txt'])] });
    assert.equal(same2.dependency, 'stack');
    for (const id of [g.id, m.id, same.id, same2.id]) await S.post(`/groups/${id}/reject`, { reason: 'cleanup' });
  });

  it('A(svc-x) -> B(svc-y): branches/worktrees land in the right repos; merge plan; per-task merges', async () => {
    const g = await group({ title: 'A then B', steps: [step('A', sx, ['a.txt']), step('B', sy, ['b.txt'])] });
    const [a, b] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    const ta = await S.waitStatus(a.id, 'review'); const tb = await S.waitStatus(b.id, 'review');
    assert.match(git(X, 'branch', '--list', ta.branch), /ai\/task-/); assert.equal(git(Y, 'branch', '--list', ta.branch).trim(), '');
    assert.match(git(Y, 'branch', '--list', tb.branch), /ai\/task-/); assert.equal(git(X, 'branch', '--list', tb.branch).trim(), '');
    const wtX = git(X, 'worktree', 'list'), wtY = git(Y, 'worktree', 'list');
    assert.match(wtX, new RegExp(`/multi/svc-x/task-${a.id}`)); assert.match(wtY, new RegExp(`/multi/svc-y/task-${b.id}`));
    assert.doesNotMatch(wtX, new RegExp(`task-${b.id}`)); assert.doesNotMatch(wtY, new RegExp(`task-${a.id}`));
    assert.match(git(ta.worktree_path, 'diff', '--stat', 'main'), /a\.txt/);
    const plan = await S.get(`/groups/${g.id}/merge-plan`);
    assert.equal(plan.cross_repo, true); assert.equal(plan.all_ready, true); assert.equal(plan.repos.length, 2);
    assert.deepEqual(plan.steps.map((s) => s.state), ['ready', 'ready']); assert.match(plan.note, /no atomic cross-repository merge/i);
    await S.post(`/tasks/${a.id}/approve-merge`, {});
    assert.match(git(X, 'show', 'HEAD:a.txt'), /edited by stub-aider/); assert.doesNotMatch(git(Y, 'show', 'HEAD:b.txt'), /edited/, 'repo Y untouched by merging A');
    const mid = await S.get(`/groups/${g.id}/merge-plan`);
    assert.deepEqual(mid.steps.map((s) => s.state), ['merged', 'ready']);
    await S.post(`/tasks/${b.id}/approve-merge`, {});
    assert.match(git(Y, 'show', 'HEAD:b.txt'), /edited by stub-aider/);
    assert.deepEqual((await S.get(`/groups/${g.id}/merge-plan`)).steps.map((s) => s.state), ['merged', 'merged']);
  });

  it('partial failure: a failing step does not block independent steps; the others stay reviewable and mergeable', async () => {
    const g = await group({ title: 'partial', steps: [step('P1', sx, ['c.txt']), step('P2', sy, ['b.txt'], { prompt: 'STUB_FAIL' }), step('P3', sx, ['a.txt'])] });
    assert.equal(g.dependency, 'independent');
    const [p1, p2, p3] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(p2.id, 'failed'); await S.waitStatus(p1.id, 'review'); await S.waitStatus(p3.id, 'review');
    const plan = await S.get(`/groups/${g.id}/merge-plan`);
    assert.deepEqual(plan.steps.map((s) => s.state), ['ready', 'failed', 'ready']); assert.equal(plan.all_ready, false);
    assert.match(plan.steps[1].problem, /needs 'review'/);
    // pre-flight catches a dirty repo (read-only view), and the merge itself refuses; nothing is lost
    fs.writeFileSync(path.join(X, 'dirty.txt'), 'x');
    const dirty = await S.get(`/groups/${g.id}/merge-plan`);
    assert.equal(dirty.steps[0].state, 'blocked'); assert.match(dirty.steps[0].problem, /not clean/);
    const refused = await S.api('POST', `/tasks/${p1.id}/approve-merge`, {}, { allowFail: true });
    assert.equal(refused.status, 409);
    assert.equal((await S.get(`/tasks/${p1.id}`)).status, 'review');
    fs.rmSync(path.join(X, 'dirty.txt'));
    await S.post(`/tasks/${p1.id}/approve-merge`, {});
    // P3 touches the same file base as before; merging both in one repo works one after the other
    await S.post(`/tasks/${p3.id}/approve-merge`, {});
    assert.equal((await S.get(`/tasks/${p2.id}`)).status, 'failed', 'failed step remains failed, nothing reverted/changed');
    assert.deepEqual((await S.get(`/groups/${g.id}/merge-plan`)).steps.map((s) => s.state), ['merged', 'failed', 'merged']);
  });

  it("'merged' across repos: step 2 waits until step 1 is merged", async () => {
    const g = await group({ title: 'gate', dependency: 'merged', steps: [step('G1', sy, ['b.txt']), step('G2', sx, ['c.txt'])] });
    const [g1, g2] = g.steps;
    await S.post(`/groups/${g.id}/approve-start`, {});
    await S.waitStatus(g1.id, 'review');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(['pending', 'approved'].includes((await S.get(`/tasks/${g2.id}`)).status), 'G2 must not start before G1 is merged');
    await S.post(`/tasks/${g1.id}/approve-merge`, {});
    const r2 = await S.waitStatus(g2.id, ['review', 'failed', 'rejected'], { timeout: 40000 });
    assert.equal(r2.status, 'review', `G2 ended as ${r2.status}: ${r2.result_summary}`);
  });

  it('router: null service from the model -> multi_service hint with candidates; a single service -> no hint', async () => {
    const reply = (o) => { S.fake.state.chatReply = () => JSON.stringify(o); };
    reply({ service: null, confidence: 0.7, difficulty: 'complex', needs_thinking: false, reason: 'touches both repos' });
    const r = await S.post(`/projects/${P.id}/route`, { prompt: 'rename the field across svc-x and svc-y' });
    assert.equal(r.suggestion.service, null); assert.equal(r.suggestion.multi_service, true);
    assert.match(r.suggestion.hint, /sequence/); assert.ok(Array.isArray(r.suggestion.candidates));
    reply({ service: 'svc-y', confidence: 0.9, difficulty: 'simple', needs_thinking: false, reason: 'one' });
    const r2 = await S.post(`/projects/${P.id}/route`, { prompt: 'fix b.txt' });
    assert.equal(r2.suggestion.service, 'svc-y'); assert.equal(!!r2.suggestion.multi_service, false);
    S.fake.state.chatReply = null;
  });
});

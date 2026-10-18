'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('M0 engines: cursor (stub), escalation, plan-first, review', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'eng'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'eng', 'test -f hello.txt');
  });
  after(async () => { await S.stop(); });

  it('engine=cursor runs the stub agent in the worktree, counts the daily cap, keeps main untouched', async () => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const u0 = (await S.get('/health')).cursor_usage.used;
    const t = await S.runToReview(P.id, { title: 'cursor task', prompt: 'do it', engine: 'cursor', model: 'auto' });
    assert.equal(t.engine_used, 'cursor');
    assert.match(t.model_used || '', /stub-model-1/);
    assert.match(t.result_summary, /cursor\(auto\): ok/);
    assert.equal((await S.get('/health')).cursor_usage.used, u0 + 1);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
    const log = fs.readFileSync(S.env.STUB_LOG, 'utf8');
    assert.match(log, new RegExp(`mode=force cwd=.*${path.basename(t.worktree_path)}`));
    assert.match(log, /--sandbox","enabled"/);
    const ev = await S.get(`/tasks/${t.id}/events`);
    assert.ok(ev.some((e) => e.kind === 'cursor' && /RUNS ON CURSOR SERVERS/.test(e.message)));
  });

  it('engine=auto: local failure -> awaiting_escalation -> approve -> cursor finishes (local+cursor)', async () => {
    const t = await S.runToReview(P.id, { title: 'esc', prompt: 'STUB_FAIL', files: ['hello.txt'], engine: 'auto', allow_escalation: true }, 'awaiting_escalation');
    assert.equal(t.escalation, 'pending');
    assert.equal((await S.post(`/tasks/${t.id}/approve-merge`, {}, { allowFail: true })).status, 409);
    const used = (await S.get('/health')).cursor_usage.used;
    await S.post(`/tasks/${t.id}/approve-escalation`, { reason: 'ok' });
    const r = await S.waitStatus(t.id, 'review');
    assert.equal(r.engine_used, 'local+cursor');
    assert.equal((await S.get('/health')).cursor_usage.used, used + 1);
    assert.deepEqual((await S.get(`/tasks/${t.id}`)).approvals.map((x) => `${x.stage}:${x.decision}`), ['start:approved', 'escalate:approved']);
  });

  it('reject-escalation never invokes cursor', async () => {
    const t = await S.runToReview(P.id, { title: 'esc2', prompt: 'STUB_FAIL', files: ['hello.txt'], engine: 'auto', allow_escalation: true }, 'awaiting_escalation');
    const used = (await S.get('/health')).cursor_usage.used;
    assert.equal((await S.post(`/tasks/${t.id}/reject-escalation`, {}, { allowFail: true })).status, 400);
    const r = await S.post(`/tasks/${t.id}/reject-escalation`, { reason: 'no' });
    assert.equal(r.status, 'rejected');
    assert.equal((await S.get('/health')).cursor_usage.used, used);
  });

  it('auto without allow_escalation just fails', async () => {
    const t = await S.runToReview(P.id, { title: 'noesc', prompt: 'STUB_FAIL', files: ['hello.txt'], engine: 'auto' }, 'failed');
    assert.match(t.result_summary, /escalation not allowed/);
  });

  it('plan_first: awaiting_plan -> edit+approve -> implementation run -> review; reject-plan', async () => {
    const t = await S.runToReview(P.id, { title: 'plan', prompt: 'do it', engine: 'cursor', plan_first: true }, 'awaiting_plan');
    assert.match(t.plan_text, /stub plan/);
    const used = (await S.get('/health')).cursor_usage;
    assert.equal(used.plans >= 1, true);
    await S.post(`/tasks/${t.id}/approve-plan`, { plan: '1. edited plan' });
    const r = await S.waitStatus(t.id, 'review');
    assert.equal(r.plan_state, 'approved');
    assert.match(r.plan_text, /edited plan/);
    assert.match(r.result_summary, /approved plan/);
    const t2 = await S.runToReview(P.id, { title: 'plan2', prompt: 'do it', engine: 'cursor', plan_first: true }, 'awaiting_plan');
    const rj = await S.post(`/tasks/${t2.id}/reject-plan`, { reason: 'bad plan' });
    assert.equal(rj.status, 'rejected');
  });

  it('daily cap blocks starting cursor tasks', async () => {
    const S2 = await startServer({ env: { ORCH_CURSOR_DAILY_CAP: '1' } });
    try {
      const r2 = makeRepo(path.join(S2.work, 'cap'), { 'a.txt': 'a\n' });
      const p = await S2.addProject(r2, 'cap', 'true');
      await S2.runToReview(p.id, { title: 'one', prompt: 'x', engine: 'cursor' });
      const t = await S2.createTask(p.id, { title: 'two', prompt: 'x', engine: 'cursor' });
      const r = await S2.post(`/tasks/${t.id}/approve-start`, {}, { allowFail: true });
      assert.equal(r.status, 409);
      assert.match(r.json.error, /daily Cursor cap/);
    } finally { await S2.stop(); }
  });

  it('advisory AI review attaches review_summary (stub), never blocks', async () => {
    const t = await S.runToReview(P.id, { title: 'rev', prompt: 'do it', engine: 'cursor', ai_review: true });
    assert.match(t.review_summary, /ADVISORY AI REVIEW/);
  });
});

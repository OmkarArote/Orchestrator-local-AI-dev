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

  it('engine=cursor runs the stub agent in the worktree, counts it in the usage counters, keeps main untouched', async () => {
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

  it('no cap: N+1 cursor tasks start (legacy ORCH_CURSOR_*_CAP env is ignored with a one-time notice), counters increment', async () => {
    const S2 = await startServer({ env: { ORCH_CURSOR_DAILY_CAP: '1', ORCH_CURSOR_REVIEW_DAILY_CAP: '1' } });
    try {
      const r2 = makeRepo(path.join(S2.work, 'nocap'), { 'a.txt': 'a\n' });
      const p = await S2.addProject(r2, 'nocap', 'true');
      assert.equal((await S2.get('/health')).cursor_usage.used, 0);
      const N = 3; // the old cap was 1: tasks 2 and 3 used to be refused with 409 'daily Cursor cap'
      for (let i = 1; i <= N; i++) {
        const t = await S2.createTask(p.id, { title: `t${i}`, prompt: 'x', engine: 'cursor', ai_review: i >= 2 });
        const r = await S2.post(`/tasks/${t.id}/approve-start`, {}, { allowFail: true });
        assert.equal(r.status, 200, `cursor task ${i} must start (no cap): ${r.text}`);
        await S2.waitStatus(t.id, 'review');
        const h = (await S2.get('/health')).cursor_usage;
        assert.equal(h.tasks, i, 'legacy field: task runs today'); assert.equal(h.used, i);
        assert.equal(h.today.tasks, i); assert.equal(h.total.tasks, i);
      }
      const h = (await S2.get('/health')).cursor_usage;
      assert.deepEqual({ used: h.used, tasks: h.tasks, plans: h.plans, reviews: h.reviews }, { used: 3, tasks: 3, plans: 0, reviews: 2 }, 'reviews are no longer capped either');
      const u = await S2.get('/cursor/usage');
      assert.deepEqual(u.today, { tasks: 3, task_runs: 3, plans: 0, reviews: 2, sessions: 0, runs: 5 });
      assert.deepEqual(u.total, u.today);
      assert.equal(u.by_project.length, 1);
      assert.equal(u.by_project[0].project_id, p.id); assert.equal(u.by_project[0].name, 'nocap'); assert.equal(u.by_project[0].deleted, false);
      assert.deepEqual(u.by_project[0].today, u.today);
      assert.equal((await S2.get('/cursor/status')).usage.today.tasks, 3);
      const cfgJson = await S2.get('/config');
      assert.equal('cursor_daily_cap' in cfgJson, false); assert.equal('cursor_review_daily_cap' in cfgJson, false);
      const notices = S2.logs().split('\n').filter((l) => /\[startup\] NOTICE:.*IGNORED/.test(l));
      assert.equal(notices.length, 1, 'one-time startup notice');
      assert.match(notices[0], /ORCH_CURSOR_DAILY_CAP, ORCH_CURSOR_REVIEW_DAILY_CAP/);
      assert.ok((await S2.get(`/tasks/${(await S2.get('/tasks'))[0].id}/events`)).some((e) => e.kind === 'cursor' && /no cap/.test(e.message)));
    } finally { await S2.stop(); }
  });

  it('advisory AI review attaches review_summary (stub), never blocks', async () => {
    const t = await S.runToReview(P.id, { title: 'rev', prompt: 'do it', engine: 'cursor', ai_review: true });
    assert.match(t.review_summary, /ADVISORY AI REVIEW/);
  });
});

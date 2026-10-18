'use strict';
// M1: Cursor usage counters (db.cursorStats with an injectable `now`), approval-only guarantee (nothing spawns the agent without a click),
// and the "how many Cursor runs will this sequence start" number that replaces the old daily cap as the brake.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, makeRepo, sleep, ROOT } = require('./helpers/harness');

/** Run a snippet against a fresh temp DB through lib/db.js in a child process (config comes from env; never touches a real DB). */
function withDb(code) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-usage-')));
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt') } });
    return JSON.parse(out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('M1 db.cursorStats', () => {
  // Local-calendar-day arithmetic only (no fixed UTC offsets), so the test is timezone independent. Day D = 2026-06-15 local.
  const SETUP = `
    const s = require('./lib/db');
    const at = (d, h, m = 0) => new Date(2026, 5, d, h, m, 0).toISOString();
    const mk = (name) => { const r = s.createProjectWithService({ name }, { name: name + '-svc', path: '.', local_path: '/x/' + name }); return r; };
    const A = mk('alpha'), B = mk('beta');
    const task = (P, title) => s.createTask({ project_id: P.projectId, service_id: P.serviceId, title, prompt: 'p', files: [], engine: 'cursor' });
    const t1 = task(A, 't1'), t2 = task(A, 't2'), t3 = task(A, 't3'), t4 = task(B, 't4');
    const ins = s.db.prepare('INSERT INTO cursor_usage (task_id, kind, model, project_id, service_id, ts) VALUES (?,?,?,?,?,?)');
    const row = (t, P, kind, ts) => ins.run(t, kind, 'auto', P.projectId, P.serviceId, ts);
    row(t1, A, 'plan', at(15, 9)); row(t1, A, 'task', at(15, 10)); row(t1, A, 'review', at(15, 10, 30));   // task t1: plan + implement + review
    row(t2, A, 'task', at(15, 11)); row(t2, A, 'session', at(15, 12));
    row(t3, A, 'task', at(14, 23, 30));                                                                      // yesterday (23:30 local)
    row(t4, B, 'task', at(14, 8)); row(t4, B, 'plan', at(13, 8));
    row(t1, A, 'task', at(16, 0, 30));                                                                       // tomorrow 00:30 local: after "now"'s day
    ins.run(null, 'task', 'auto', null, null, at(15, 13)); ins.run(null, 'task', 'auto', null, null, at(12, 13)); // unattributed legacy rows
    const NOW = new Date(2026, 5, 15, 12, 0, 0);
  `;
  it('today / total / by_project for a fixed `now` (distinct tasks; plan+implement counts once; reviews and sessions separate)', () => {
    const r = withDb(SETUP + `
      const st = s.cursorStats({ now: NOW });
      console.log(JSON.stringify({ st, dayStartIsLocalMidnight: new Date(st.day_start).getTime() === new Date(2026, 5, 15).getTime() }));`);
    assert.equal(r.dayStartIsLocalMidnight, true);
    // today (15th): t1 (plan + task + review), t2 (task + session), 1 unattributed task row
    assert.deepEqual(r.st.today, { tasks: 3, task_runs: 3, plans: 1, reviews: 1, sessions: 1, runs: 5 });
    // total up to the end of the 15th: t1, t2, t3, t4 + 2 unattributed; the row on the 16th is not counted
    assert.deepEqual(r.st.total, { tasks: 6, task_runs: 6, plans: 2, reviews: 1, sessions: 1, runs: 9 });
    assert.equal(r.st.by_project.length, 3);
    const by = (n) => r.st.by_project.find((x) => x.name === n);
    assert.deepEqual(by('alpha').today, { tasks: 2, task_runs: 2, plans: 1, reviews: 1, sessions: 1, runs: 4 });
    assert.deepEqual(by('alpha').total, { tasks: 3, task_runs: 3, plans: 1, reviews: 1, sessions: 1, runs: 5 });
    assert.deepEqual(by('beta').today, { tasks: 0, task_runs: 0, plans: 0, reviews: 0, sessions: 0, runs: 0 });
    assert.deepEqual(by('beta').total, { tasks: 1, task_runs: 1, plans: 1, reviews: 0, sessions: 0, runs: 2 });
    assert.equal(by('alpha').deleted, false);
    const un = r.st.by_project.find((x) => x.project_id === null);
    assert.ok(un && un.deleted === true && un.name === null && un.total.tasks === 2 && un.today.tasks === 1);
    assert.deepEqual(r.st.by_project.map((x) => x.total.runs), [5, 2, 2], 'sorted by total runs');
    assert.equal(r.st.since, new Date(2026, 5, 12, 13).toISOString());
  });
  it('`now` moves the day boundary: yesterday / an empty past day', () => {
    const r = withDb(SETUP + `
      const y = s.cursorStats({ now: new Date(2026, 5, 14, 12) }), empty = s.cursorStats({ now: new Date(2026, 5, 1, 12) });
      console.log(JSON.stringify({ y: { today: y.today, total: y.total }, empty: { today: empty.today, total: empty.total } }));`);
    assert.deepEqual(r.y.today, { tasks: 2, task_runs: 2, plans: 0, reviews: 0, sessions: 0, runs: 2 }, 't3 (23:30) and t4 (08:00) ran on the 14th');
    assert.deepEqual(r.y.total, { tasks: 3, task_runs: 3, plans: 1, reviews: 0, sessions: 0, runs: 4 }, 'as of the end of the 14th: t3, t4 (task on the 14th + plan on the 13th) and the unattributed row of the 12th; t1/t2 (15th) are not counted yet');
    assert.deepEqual(r.empty.today, { tasks: 0, task_runs: 0, plans: 0, reviews: 0, sessions: 0, runs: 0 });
    assert.deepEqual(r.empty.total, { tasks: 0, task_runs: 0, plans: 0, reviews: 0, sessions: 0, runs: 0 });
  });
  it('recordCursorUse attributes project/service from the task; legacy view keeps used/tasks/plans/reviews; deleted projects stay counted', () => {
    const r = withDb(`
      const s = require('./lib/db');
      const P = s.createProjectWithService({ name: 'gamma' }, { name: 'g', path: '.', local_path: '/x/g' });
      const t = s.createTask({ project_id: P.projectId, service_id: P.serviceId, title: 't', prompt: 'p', files: [], engine: 'cursor' });
      s.recordCursorUse(t, 'plan', 'auto'); s.recordCursorUse(t, 'task', 'auto'); s.recordCursorUse(t, 'review', 'auto'); s.recordCursorUse(999999, 'task', 'auto');
      const rows = s.db.prepare('SELECT task_id, kind, project_id, service_id FROM cursor_usage ORDER BY id').all();
      const legacy = s.cursorUsageToday();
      const before = s.cursorStats();
      s.deleteProjectRows(P.projectId);
      const after = s.cursorStats();
      console.log(JSON.stringify({ rows, legacy, P, before: before.by_project, after: after.by_project, totals: [before.total, after.total] }));`);
    assert.deepEqual(r.rows.map((x) => [x.kind, x.project_id, x.service_id]), [['plan', r.P.projectId, r.P.serviceId], ['task', r.P.projectId, r.P.serviceId], ['review', r.P.projectId, r.P.serviceId], ['task', null, null]]);
    assert.deepEqual({ used: r.legacy.used, tasks: r.legacy.tasks, plans: r.legacy.plans, reviews: r.legacy.reviews, sessions: r.legacy.sessions }, { used: 3, tasks: 2, plans: 1, reviews: 1, sessions: 0 });
    assert.equal(r.legacy.today.tasks, 2, 'distinct tasks: the real task (plan+task) and the orphan row');
    assert.equal('cap' in r.legacy || 'remaining' in r.legacy, false, 'no cap fields any more');
    assert.deepEqual(r.totals[0], r.totals[1], 'deleting the project does not change the totals');
    assert.equal(r.before.find((x) => x.project_id === r.P.projectId).name, 'gamma');
    const gone = r.after.find((x) => x.project_id === r.P.projectId);
    assert.ok(gone && gone.deleted === true && gone.name === null && gone.total.runs === 3);
  });
});

describe('M1 Cursor stays approval-only', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer({ env: { STUB_SLEEP_MS: '50' } });
    repo = makeRepo(path.join(S.work, 'gate'), { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    P = await S.addProject(repo, 'gate', 'true');
  });
  after(async () => { await S.stop(); });
  const starts = () => (fs.existsSync(S.env.STUB_LOG) ? fs.readFileSync(S.env.STUB_LOG, 'utf8').split('\n').filter((l) => / START mode=/.test(l)) : []);
  const modes = () => starts().map((l) => /START mode=(\S+)/.exec(l)[1]);

  it('pending / awaiting_plan / awaiting_escalation tasks never spawn the agent; only approve-start, approve-plan, approve-escalation do', async () => {
    const pendingTask = await S.createTask(P.id, { title: 'idle', prompt: 'x', engine: 'cursor' });                 // stays pending
    const planTask = await S.createTask(P.id, { title: 'plan', prompt: 'x', engine: 'cursor', plan_first: true });
    const autoTask = await S.createTask(P.id, { title: 'auto', prompt: 'STUB_FAIL', files: ['a.txt'], engine: 'auto', allow_escalation: true });
    await sleep(900); // several runner polls (150 ms): nothing is approved, so nothing may run
    assert.deepEqual(modes(), [], 'no agent process for pending tasks');
    for (const t of [pendingTask, planTask, autoTask]) assert.equal((await S.get(`/tasks/${t.id}`)).status, 'pending');

    await S.post(`/tasks/${planTask.id}/approve-start`, {});                                                         // click 1: starts ONLY the read-only plan run
    await S.waitStatus(planTask.id, 'awaiting_plan');
    await S.post(`/tasks/${autoTask.id}/approve-start`, {});                                                         // local (aider stub) first; fails -> awaiting_escalation
    await S.waitStatus(autoTask.id, 'awaiting_escalation');
    await sleep(900);
    assert.deepEqual(modes(), ['plan'], 'awaiting_plan / awaiting_escalation / pending spawn nothing: only the plan run happened');
    assert.equal((await S.get(`/tasks/${pendingTask.id}`)).status, 'pending');

    await S.post(`/tasks/${planTask.id}/approve-plan`, {});                                                          // click 2
    await S.waitStatus(planTask.id, 'review');
    assert.deepEqual(modes(), ['plan', 'force']);
    await S.post(`/tasks/${autoTask.id}/approve-escalation`, {});                                                    // click 3
    await S.waitStatus(autoTask.id, 'review');
    assert.deepEqual(modes().sort(), ['force', 'force', 'plan']);
    await sleep(600);
    assert.equal(starts().length, 3, 'exactly one agent run per click; the idle pending task never ran');
    assert.equal((await S.get(`/tasks/${pendingTask.id}`)).status, 'pending');
  });

  it('sequence view reports how many Cursor runs one start approval will cause (shown in the confirm dialog); approving it starts exactly that many', async () => {
    const base = starts().length;
    const g = await S.post(`/projects/${P.id}/groups`, { title: 'fanout', dependency: 'independent', steps: [
      { title: 'c1', prompt: 'x', files: ['a.txt'], engine: 'cursor', service_id: P.serviceId },                              // 1 run
      { title: 'c2', prompt: 'x', files: ['b.txt'], engine: 'cursor', plan_first: true, ai_review: true, service_id: P.serviceId }, // plan + implementation + review = 3
      { title: 'l3', prompt: 'x', files: ['a.txt'], engine: 'local', service_id: P.serviceId },                               // 0
      { title: 'a4', prompt: 'x', files: ['b.txt'], engine: 'auto', service_id: P.serviceId },                                // 0 (escalation needs its own click)
    ] });
    assert.deepEqual(g.steps.map((s) => s.cursor_runs_on_start), [1, 3, 0, 0]);
    assert.equal(g.cursor_runs_pending, 4);
    assert.equal((await S.get(`/groups/${g.id}`)).cursor_runs_pending, 4);
    assert.equal(starts().length, base, 'creating a sequence spawns nothing');
    await S.post(`/groups/${g.id}/approve-start`, {});
    assert.equal((await S.get(`/groups/${g.id}`)).cursor_runs_pending, 0, 'nothing pending after the click');
    const [c1, c2] = g.steps;
    await S.waitStatus(c1.id, 'review'); await S.waitStatus(c2.id, 'awaiting_plan');                                  // c2 stops for plan approval (its 2 remaining runs need a 2nd click)
    for (const st of g.steps.slice(2)) await S.waitStatus(st.id, ['review', 'failed', 'done', 'awaiting_escalation']);
    assert.equal(starts().length - base, 2, 'c1 implementation + c2 plan so far; c2 implementation+review wait for approve-plan');
    await S.post(`/tasks/${c2.id}/approve-plan`, {}); await S.waitStatus(c2.id, 'review');
    assert.equal(starts().length - base, 4, 'all 4 counted runs happened, none without a click');
  });
});

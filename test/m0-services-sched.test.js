'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git, sleep } = require('./helpers/harness');

describe('M0 services (monorepo subfolders), detect, service-scoped tasks', () => {
  let S, repo, P, api, web;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'mono'), { 'api/pyproject.toml': '[p]\n', 'api/app.py': 'x=1\n', 'web/go.mod': 'module web\n', 'web/main.go': 'package main\n', 'README.md': 'r\n' });
    P = await S.addProject(repo, 'mono', 'true');
  });
  after(async () => { await S.stop(); });

  it('detect suggests subfolders; create validates names and paths', async () => {
    const d = await S.get(`/projects/${P.id}/services/detect`);
    const names = d.suggestions.map((s) => s.path).sort();
    assert.deepEqual(names, ['api', 'web']);
    api = await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'api', description: 'backend', check_cmd: 'test -f app.py' });
    web = await S.post(`/projects/${P.id}/services`, { name: 'web', path: './web/' });
    assert.equal(api.path, 'api'); assert.equal(web.path, 'web'); assert.equal(api.exists, true);
    assert.equal((await S.post(`/projects/${P.id}/services`, { name: 'API', path: 'web' }, { allowFail: true })).status, 409);
    for (const bad of [{ name: 'x', path: '../x' }, { name: 'x', path: '/etc' }, { name: '../x', path: 'web' }, { name: 'x y', path: 'web' }]) {
      const r = await S.post(`/projects/${P.id}/services`, bad, { allowFail: true });
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(bad));
    }
    const upd = await S.post(`/services/${api.id}/update`, { description: 'python backend' });
    assert.equal(upd.description, 'python backend');
    assert.equal((await S.post(`/services/${api.id}/update`, {}, { allowFail: true })).status, 400);
  });

  it('task in a service: aider runs with cwd=<worktree>/<subdir>; check runs there; service check_cmd wins', async () => {
    const t = await S.createTask(P.id, { title: 'in api', prompt: 'edit', files: ['app.py'], service_id: api.id });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const r = await S.waitStatus(t.id, 'review');
    assert.match(r.result_summary, /check: PASSED \(test -f app\.py\)/);
    const last = fs.readFileSync(S.env.STUB_AIDER_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    assert.match(last.cwd, /\/api$/);
    assert.match(git(repo, 'show', `${r.branch}:api/app.py`), /edited by stub-aider/);
    const diff = await S.get(`/tasks/${t.id}/diff`);
    assert.match(diff.diff, /api\/app\.py/);
    await S.post(`/tasks/${t.id}/approve-merge`, {});
  });

  it('archive/unarchive service; archived service rejected for new tasks; open tasks block archive', async () => {
    const t = await S.createTask(P.id, { title: 'open', prompt: 'edit', files: ['main.go'], service_id: web.id });
    assert.equal((await S.post(`/services/${web.id}/archive`, {}, { allowFail: true })).status, 409);
    await S.post(`/tasks/${t.id}/reject-start`, { reason: 'x' });
    const a = await S.post(`/services/${web.id}/archive`, {});
    assert.equal(a.archived, true);
    assert.equal((await S.post('/tasks', { project_id: P.id, title: 't', prompt: 'p', service_id: web.id }, { allowFail: true })).status, 409);
    assert.equal((await S.post(`/services/${web.id}/unarchive`, {})).archived, false);
  });
});

describe('M0 scheduler: cursor parallelism and restart recovery', () => {
  it('cursor tasks in different services run in parallel, same service never', async () => {
    const S = await startServer({ env: { STUB_SLEEP_MS: '1800' } });
    try {
      const repo = makeRepo(path.join(S.work, 'par'), { 'api/pyproject.toml': '[p]\n', 'web/go.mod': 'module w\n' });
      const P = await S.addProject(repo, 'par', 'true');
      const a = await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'api' });
      const w = await S.post(`/projects/${P.id}/services`, { name: 'web', path: 'web' });
      const mk = async (svc, title) => { const t = await S.post('/tasks', { project_id: P.id, title, prompt: 'x', engine: 'cursor', service_id: svc.id }); await S.post(`/tasks/${t.id}/approve-start`, {}); return t; };
      const [t1, t2, t3] = [await mk(a, 'a1'), await mk(w, 'w1'), await mk(a, 'a2')];
      let maxRunning = 0, bothAtOnce = false, sameSvcOverlap = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const st = await Promise.all([t1, t2, t3].map(async (t) => (await S.get(`/tasks/${t.id}`)).status));
        const run = st.map((s) => ['running', 'checking'].includes(s));
        maxRunning = Math.max(maxRunning, run.filter(Boolean).length);
        if (run[0] && run[1]) bothAtOnce = true;
        if (run[0] && run[2]) sameSvcOverlap = true;
        if (st.every((s) => s === 'review')) break;
        await sleep(60);
      }
      assert.equal(bothAtOnce, true, 'api and web cursor tasks should overlap');
      assert.equal(sameSvcOverlap, false, 'two cursor tasks in the same service must not overlap');
      for (const t of [t1, t2, t3]) await S.waitStatus(t.id, 'review', { timeout: 15000 });
    } finally { await S.stop(); }
  });

  it('restart marks in-flight tasks failed (crash recovery)', async () => {
    const S1 = await startServer({ keep: true });
    const repo = makeRepo(path.join(S1.work, 'rec'), { 'a.txt': 'a\n' });
    const P = await S1.addProject(repo, 'rec', 'true');
    const t = await S1.createTask(P.id, { title: 'slow', prompt: 'STUB_SLOW', files: ['a.txt'] });
    await S1.post(`/tasks/${t.id}/approve-start`, {});
    await S1.waitFor(async () => (await S1.get(`/tasks/${t.id}/events`)).some((e) => /engine local: aider/.test(e.message)), { what: 'aider started' });
    S1.child.kill('SIGKILL'); await sleep(300);
    const S2 = await startServer({ dbPath: S1.dbPath, keep: true });
    try {
      const r = await S2.get(`/tasks/${t.id}`);
      assert.equal(r.status, 'failed');
      assert.match(r.result_summary, /interrupted by orchestrator restart/);
    } finally { await S2.stop(); await S1.stop(); require('node:child_process').execSync(`pkill -f '[s]tub-aider.js' || true`); fs.rmSync(S1.base, { recursive: true, force: true }); fs.rmSync(S2.base, { recursive: true, force: true }); }
  });
});

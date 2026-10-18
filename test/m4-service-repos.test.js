'use strict';
// M4: the runner / git ops / context / memory work on the repo of a task's SERVICE (never a "project repo").
// Services of one project live in different repos under different parent dirs; only the repo a task targets may change.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, fingerprint, sleep, ROOT } = require('./helpers/harness');

/** Register a second repo as a service of project `pid` directly in the DB (the public add-existing endpoint arrives in M6). */
function addServiceRow(S, pid, name, repoDir, subdir = '.') {
  const d = new DatabaseSync(S.dbPath);
  try {
    d.exec('PRAGMA busy_timeout = 5000');
    const r = d.prepare("INSERT INTO services (project_id, name, path, local_path, default_branch, status, origin) VALUES (?,?,?,?,?,'active','existing')").run(pid, name, subdir, repoDir, 'main');
    return Number(r.lastInsertRowid);
  } finally { d.close(); }
}

describe('M4 two services, two repos, two parent folders', () => {
  let S, X, Y, P, sx, sy;
  before(async () => {
    S = await startServer({ env: { STUB_SLEEP_MS: '1200' } });
    X = makeRepo(path.join(S.work, 'parent-a', 'repo-x'), { 'x.txt': 'x\n' });
    Y = makeRepo(path.join(S.work, 'parent-b', 'repo-y'), { 'y.txt': 'y\n' });
    P = await S.addProject(X, 'multi', 'true');
    sx = P.serviceId;
    sy = addServiceRow(S, P.id, 'svc-y', Y);
  });
  after(async () => { await S.stop(); });

  it('a task for service Y cuts its worktree and branch in repo Y; repo X is never touched; merge lands only in Y', async () => {
    const fx = fingerprint(X), fy = fingerprint(Y);
    const t = await S.runToReview(P.id, { title: 'edit y', prompt: 'change y', files: ['y.txt'], service_id: sy });
    const wt = (await S.get(`/tasks/${t.id}`)).worktree_path;
    assert.equal(wt, path.join(S.base, 'worktrees', 'multi', 'svc-y', `task-${t.id}`), 'new layout: <worktrees>/<project.slug>/<service.name>/task-<id>');
    assert.match(git(Y, 'branch', '--list', `ai/task-${t.id}*`), /ai\/task-/);
    assert.equal(git(X, 'branch', '--list', `ai/task-${t.id}*`).trim(), '');
    assert.equal(fingerprint(X), fx, 'repo X byte-identical (HEAD, status, branches, worktrees)');
    const d = await S.get(`/tasks/${t.id}/diff`);
    assert.match(d.diff, /y\.txt/);
    assert.equal(d.service, 'svc-y');
    await S.post(`/tasks/${t.id}/approve-merge`, {});
    assert.match(git(Y, 'log', '--oneline', 'main'), /ai\/task-/);
    assert.equal(fingerprint(X), fx, 'merge did not touch X');
    assert.notEqual(fingerprint(Y), fy);
    assert.equal(fs.existsSync(wt), false, 'worktree removed after merge');
  });

  it('and the same for X (service 1)', async () => {
    const fy = fingerprint(Y);
    const t = await S.runToReview(P.id, { title: 'edit x', prompt: 'change x', files: ['x.txt'], service_id: sx });
    assert.match(git(X, 'branch', '--list', `ai/task-${t.id}*`), /ai\/task-/);
    assert.equal(fingerprint(Y), fy);
    await S.post(`/tasks/${t.id}/approve-merge`, {});
    assert.equal(fingerprint(Y), fy);
  });

  it('cursor tasks in DIFFERENT repos run in parallel; two in the same repo never overlap', async () => {
    const mk = async (svc, title) => { const t = await S.post('/tasks', { project_id: P.id, title, prompt: 'x', engine: 'cursor', service_id: svc }); await S.post(`/tasks/${t.id}/approve-start`, {}); return t; };
    const [a1, b1, a2] = [await mk(sx, 'a1'), await mk(sy, 'b1'), await mk(sx, 'a2')];
    let both = false, same = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = await Promise.all([a1, b1, a2].map(async (t) => (await S.get(`/tasks/${t.id}`)).status));
      const r = st.map((s) => ['running', 'checking'].includes(s));
      if (r[0] && r[1]) both = true;
      if (r[0] && r[2]) same = true;
      if (st.every((s) => s === 'review')) break;
      await sleep(50);
    }
    assert.equal(both, true, 'repo X and repo Y tasks overlap');
    assert.equal(same, false, 'two tasks on repo X never overlap');
    for (const t of [a1, b1, a2]) await S.waitStatus(t.id, 'review');
  });

  it('merge pre-flight reports the SERVICE repo (dirty / wrong branch) and changes nothing', async () => {
    const t = await S.runToReview(P.id, { title: 'edit y2', prompt: 'p', files: ['y.txt'], service_id: sy });
    fs.writeFileSync(path.join(Y, 'dirty.txt'), 'wip\n');
    const r = await S.raw('POST', `/api/tasks/${t.id}/approve-merge`, {});
    assert.equal(r.status, 409);
    assert.match(r.json.error, /service repo working copy is not clean/);
    fs.rmSync(path.join(Y, 'dirty.txt'));
    git(Y, 'checkout', '-q', '-b', 'other');
    const r2 = await S.raw('POST', `/api/tasks/${t.id}/approve-merge`, {});
    assert.match(r2.json.error, /service repo is on 'other', not 'main'/);
    git(Y, 'checkout', '-q', 'main');
    assert.equal((await S.get(`/tasks/${t.id}`)).status, 'review');
  });
});

describe('M4 same repo: subdir overlap rule and two projects sharing one repo', () => {
  it('"." conflicts with a subdir of the same repo; disjoint subdirs run in parallel', async () => {
    const S = await startServer({ env: { STUB_SLEEP_MS: '1500' } });
    try {
      const R = makeRepo(path.join(S.work, 'mono'), { 'api/p.txt': 'a\n', 'web/w.txt': 'w\n', 'root.txt': 'r\n' });
      const P = await S.addProject(R, 'mono', 'true');
      const api = await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'api' });
      const web = await S.post(`/projects/${P.id}/services`, { name: 'web', path: 'web' });
      assert.equal(api.local_path, R); assert.equal(api.subdir, 'api');
      const mk = async (sid, title) => { const t = await S.post('/tasks', { project_id: P.id, title, prompt: 'x', engine: 'cursor', service_id: sid }); await S.post(`/tasks/${t.id}/approve-start`, {}); return t; };
      const [ta, tw, tr] = [await mk(api.id, 'a'), await mk(web.id, 'w'), await mk(P.serviceId, 'root')];
      let aw = false, rootOverlap = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const st = await Promise.all([ta, tw, tr].map(async (t) => (await S.get(`/tasks/${t.id}`)).status));
        const r = st.map((s) => ['running', 'checking'].includes(s));
        if (r[0] && r[1]) aw = true;
        if (r[2] && (r[0] || r[1])) rootOverlap = true;
        if (st.every((s) => s === 'review')) break;
        await sleep(50);
      }
      assert.equal(aw, true); assert.equal(rootOverlap, false);
    } finally { await S.stop(); }
  });

  it('scope conflict function: same realpath (also via another project or a ./ spelling) conflicts, disjoint subdirs and other repos do not', async () => {
    const S = await startServer();
    try {
      const R = makeRepo(path.join(S.work, 'shared'), { 'a.txt': 'a\n' });
      const P1 = await S.addProject(R, 'p1', 'true');
      const d = new DatabaseSync(S.dbPath);
      d.exec("INSERT INTO projects (name, slug, path, default_branch) VALUES ('p2','p2','','')");
      const pid2 = Number(d.prepare("SELECT id FROM projects WHERE name='p2'").get().id);
      d.prepare("INSERT INTO services (project_id, name, path, local_path, default_branch, status, origin) VALUES (?, 'other-view', 'sub', ?, 'main', 'active', 'existing')").run(pid2, R + '/./');
      d.close();
      const out = require('node:child_process').execFileSync(process.execPath, ['--no-warnings', '-e', `
        const r = require('./lib/runner'); const repo = require('./lib/repo');
        const k = (p, sub) => ({ repoKey: repo.repoKeyOf({ local_path: p }), subdir: sub });
        const A = ${JSON.stringify(R)};
        console.log(JSON.stringify({
          same: r.scopesConflict(k(A, '.'), k(A + '/./', 'sub')),            // same realpath, '.' vs subdir
          disjoint: r.scopesConflict(k(A, 'api'), k(A + '/', 'web')),        // same repo, disjoint subdirs
          nested: r.scopesConflict(k(A, 'api'), k(A, 'api/v2')),              // nested subdirs
          otherRepo: r.scopesConflict(k(A, '.'), k(${JSON.stringify(R + '-other')}, '.')),
          unknown: r.scopesConflict({ repoKey: null }, k(A, 'x')) }));`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCH_DB: path.join(S.base, 'probe.db'), ORCH_LOG_DIR: path.join(S.base, 'probe-logs'), ORCH_WORKTREES: path.join(S.base, 'probe-wt') } });
      assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { same: true, disjoint: false, nested: true, otherRepo: false, unknown: true });
      assert.ok(P1.serviceId);
    } finally { await S.stop(); }
  });
});

describe('M4 unusable services fail clearly BEFORE any git command; task needs a service', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('missing repo directory', async () => {
    const R = makeRepo(path.join(S.work, 'gone'), { 'a.txt': 'a\n' });
    const P = await S.addProject(R, 'gone', 'true');
    fs.renameSync(R, R + '-moved');
    const t = await S.createTask(P.id, { title: 't', prompt: 'p', files: ['a.txt'] });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const done = await S.waitStatus(t.id, 'failed');
    assert.match(done.result_summary, /repository .* does not exist/);
    const ev = (await S.get(`/tasks/${t.id}/events`)).map((e) => e.message).join('\n');
    assert.doesNotMatch(ev, /git worktree add/);
  });
  it('repo outside the authorized roots', async () => {
    const R = makeRepo(path.join(S.work, 'moved-out'), { 'a.txt': 'a\n' });
    const P = await S.addProject(R, 'outside', 'true');
    const d = new DatabaseSync(S.dbPath);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'orch-outside-')));
    makeRepo(outside, { 'a.txt': 'a\n' });
    d.prepare('UPDATE services SET local_path = ? WHERE id = ?').run(outside, P.serviceId); d.close();
    const t = await S.createTask(P.id, { title: 't', prompt: 'p', files: ['a.txt'] });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const done = await S.waitStatus(t.id, 'failed');
    assert.match(done.result_summary, /outside the authorized roots|authorize the root/);
    assert.equal(git(outside, 'worktree', 'list').trim().split('\n').length, 1);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  it('task creation: service required; "none" rejected; single-service project defaults; multi-service requires a choice', async () => {
    const R = makeRepo(path.join(S.work, 'req'), { 'a.txt': 'a\n', 'api/x.txt': 'x\n' });
    const P = await S.addProject(R, 'req', 'true');
    const ok = await S.raw('POST', '/api/tasks', { project_id: P.id, title: 't', prompt: 'p' });
    assert.equal(ok.status, 201); assert.equal(ok.json.service_id, P.serviceId, 'single service -> default');
    const none = await S.raw('POST', '/api/tasks', { project_id: P.id, title: 't', prompt: 'p', service_id: 'none' });
    assert.equal(none.status, 400); assert.match(none.json.error, /needs a service/);
    await S.post(`/projects/${P.id}/services`, { name: 'api', path: 'api' });
    const amb = await S.raw('POST', '/api/tasks', { project_id: P.id, title: 't', prompt: 'p' });
    assert.equal(amb.status, 400); assert.match(amb.json.error, /service_id required/);
    const other = makeRepo(path.join(S.work, 'req2'), { 'b.txt': 'b\n' });
    const P2 = await S.addProject(other, 'req2', 'true');
    const wrong = await S.raw('POST', '/api/tasks', { project_id: P2.id, title: 't', prompt: 'p', service_id: P.serviceId });
    assert.equal(wrong.status, 400); assert.match(wrong.json.error, /not found in project/);
  });
});

describe('M4 worktree layout, legacy worktrees, context dir by slug', () => {
  it('repo.worktreeFor: new layout vs stored legacy path; context dir keyed by slug', async () => {
    const out = require('node:child_process').execFileSync(process.execPath, ['--no-warnings', '-e', `
      const repo = require('./lib/repo'); const context = require('./lib/context'); const cfg = require('./config');
      const project = { slug: 'my-slug', name: 'Renamed' }, service = { name: 'svc' };
      console.log(JSON.stringify({
        fresh: repo.worktreeFor({ id: 7, worktree_path: null }, project, service).replace(cfg.WORKTREES, '<WT>'),
        legacy: repo.worktreeFor({ id: 7, worktree_path: '/legacy/proj/task-7' }, project, service),
        ctx: context.dirFor(project).replace(cfg.CONTEXT_DIR, '<CTX>') }));`],
      { cwd: ROOT, encoding: 'utf8', env: (() => { const t = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'orch-m4-')); return { ...process.env, ORCH_DB: path.join(t, 'o.db'), ORCH_LOG_DIR: path.join(t, 'l'), ORCH_WORKTREES: path.join(t, 'w') }; })() });
    const j = JSON.parse(out.trim().split('\n').pop());
    assert.equal(j.fresh, '<WT>/my-slug/svc/task-7');
    assert.equal(j.legacy, '/legacy/proj/task-7');
    assert.equal(j.ctx, '<CTX>/my-slug');
  });

  it('a legacy-layout worktree path stored on the task keeps working for escalation resume', async () => {
    const S = await startServer();
    try {
      const R = makeRepo(path.join(S.work, 'leg'), { 'a.txt': 'a\n' });
      const P = await S.addProject(R, 'leg', 'true');
      const t = await S.runToReview(P.id, { title: 'local fail', prompt: 'STUB_FAIL', files: ['a.txt'], engine: 'auto', allow_escalation: true }, 'awaiting_escalation');
      const wt = (await S.get(`/tasks/${t.id}`)).worktree_path;
      // relocate the worktree to the OLD layout (<worktrees>/<project.name>/task-<id>) and re-point the task, as a pre-v4 task would look
      const legacy = path.join(S.base, 'worktrees', 'leg', `task-${t.id}`);
      git(R, 'worktree', 'move', wt, legacy);
      const d = new DatabaseSync(S.dbPath); d.prepare('UPDATE tasks SET worktree_path = ? WHERE id = ?').run(legacy, t.id); d.close();
      await S.post(`/tasks/${t.id}/approve-escalation`, {});
      const done = await S.waitStatus(t.id, ['review', 'failed']);
      assert.equal(done.status, 'review', done.result_summary);
      assert.equal(done.worktree_path, legacy);
      await S.post(`/tasks/${t.id}/approve-merge`, {});
      assert.equal(fs.existsSync(legacy), false);
    } finally { await S.stop(); }
  });
});

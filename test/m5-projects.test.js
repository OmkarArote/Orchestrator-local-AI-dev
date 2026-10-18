'use strict';
// M5: logical Project CRUD (container without a repo), project context (ARCHITECTURE.md, deps), archive / delete rules.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo } = require('./helpers/harness');

/** content hash of a directory tree (paths + bytes, .git included) - proves "byte identical". */
function hashTree(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n); const st = fs.lstatSync(p);
      h.update(path.relative(dir, p) + '\0');
      if (st.isDirectory()) walk(p); else if (st.isSymbolicLink()) h.update(fs.readlinkSync(p)); else h.update(fs.readFileSync(p));
    }
  })(dir);
  return h.digest('hex');
}
function addServiceRow(S, pid, name, repoDir, subdir = '.') {
  const d = new DatabaseSync(S.dbPath);
  try { return Number(d.prepare("INSERT INTO services (project_id, name, path, local_path, default_branch, status, origin) VALUES (?,?,?,?,?,'active','existing')").run(pid, name, subdir, repoDir, 'main').lastInsertRowid); } finally { d.close(); }
}

describe('M5 logical projects', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('create without a repo: slug, description, optional root_dir inside an authorized root; validation + duplicates', async () => {
    const r = await S.post('/projects', { name: 'shop', description: 'Web shop: api + web + worker', root_dir: path.join(S.work, 'shop') });
    assert.equal(r.project.name, 'shop'); assert.equal(r.project.slug, 'shop');
    assert.equal(r.project.description, 'Web shop: api + web + worker');
    assert.equal(r.project.root_dir, path.join(S.work, 'shop'));
    assert.equal(r.project.path, null, 'a logical project owns no repo');
    assert.equal((await S.get(`/projects/${r.project.id}/services`)).length, 0);
    const dup = await S.raw('POST', '/api/projects', { name: 'SHOP' });
    assert.equal(dup.status, 409);
    for (const bad of ['', '../x', 'a b', 'task-5', '-x', 'x'.repeat(70)]) assert.equal((await S.raw('POST', '/api/projects', { name: bad })).status, 400, bad);
    const outside = await S.raw('POST', '/api/projects', { name: 'out', root_dir: '/tmp' });
    assert.ok([400, 403].includes(outside.status)); assert.match(outside.json.error, /authorized root|outside/i);
    assert.ok([400, 403].includes((await S.raw('POST', '/api/projects', { name: 'trav', root_dir: path.join(S.work, '..', 'escape') })).status));
    // a logical project cannot run tasks until it has a service
    const t = await S.raw('POST', '/api/tasks', { project_id: r.project.id, title: 't', prompt: 'p' });
    assert.equal(t.status, 400); assert.match(t.json.error, /no services/);
  });

  it('update: rename keeps the slug (context + worktree dirs), description/root_dir/config/settings; unknown config key rejected', async () => {
    const p = (await S.post('/projects', { name: 'ren' })).project;
    await S.post(`/projects/${p.id}/context/save`, { file: 'RULES.md', content: '# rules\n' });
    const u = await S.post(`/projects/${p.id}/update`, { name: 'renamed', description: 'd2', root_dir: null });
    assert.equal(u.name, 'renamed'); assert.equal(u.slug, 'ren'); assert.equal(u.description, 'd2'); assert.equal(u.root_dir, null);
    assert.match((await S.get(`/projects/${p.id}/context`)).dir, /context\/ren$/);
    assert.equal((await S.get(`/projects/${p.id}/context`)).files.find((f) => f.name === 'RULES.md').content, '# rules\n');
    assert.equal((await S.raw('POST', `/api/projects/${p.id}/update`, { config: { bogus: 1 } })).status, 400);
    assert.equal((await S.raw('POST', `/api/projects/${p.id}/update`, { name: 'shop' })).status, 409);
    // the slug of a renamed project is never reused by a new project of the old name
    const again = (await S.post('/projects', { name: 'ren' })).project;
    assert.equal(again.slug, 'ren-2');
  });

  it('ARCHITECTURE.md is a context file and part of the bundle; deps feed the SERVICES draft and the selected service bundle', async () => {
    const R1 = makeRepo(path.join(S.work, 'ctx-api'), { 'a.txt': 'a\n' });
    const R2 = makeRepo(path.join(S.work, 'ctx-web'), { 'w.txt': 'w\n' });
    const P = await S.addProject(R1, 'ctxproj', 'true');
    const web = addServiceRow(S, P.id, 'web', R2);
    await S.post(`/projects/${P.id}/context/save`, { file: 'ARCHITECTURE.md', content: '# Arch\nweb calls api over REST; both use postgres.\n' });
    await S.post(`/projects/${P.id}/deps`, { action: 'add', service_id: web, depends_on_service_id: P.serviceId, note: 'REST' });
    await S.post(`/projects/${P.id}/deps`, { action: 'add', service_id: P.serviceId, external: 'postgres' });
    const bundle = await S.post(`/projects/${P.id}/context/preview`, { service_id: web, prompt: 'x' });
    assert.match(bundle.text, /## ARCHITECTURE/); assert.match(bundle.text, /postgres/);
    assert.match(bundle.text, /Dependencies of web: uses ctxproj \(REST\)/);
    const draft = (await S.get(`/projects/${P.id}/context`)).services_draft;
    assert.match(draft, /Dependencies: ctxproj \(REST\)/); assert.match(draft, /Dependencies: postgres/);
    const list = await S.get(`/projects/${P.id}/deps`);
    assert.equal(list.length, 2); assert.equal(list[0].service, 'web'); assert.equal(list[1].depends_on, 'postgres');
    for (const [b, re] of [[{ action: 'add', service_id: web, depends_on_service_id: web }, /cannot depend on itself/], [{ action: 'add', service_id: web, depends_on_service_id: P.serviceId }, /already exists/],
      [{ action: 'add', service_id: web }, /exactly one/], [{ action: 'add', service_id: web, external: '$(rm -rf)' }, /external must be/], [{ action: 'add', service_id: 9999, external: 'x' }, /not a service/]]) {
      const r = await S.raw('POST', `/api/projects/${P.id}/deps`, b); assert.equal(r.status, b.service_id === web && b.depends_on_service_id === P.serviceId ? 409 : 400); assert.match(r.json.error, re);
    }
    const rm = await S.post(`/projects/${P.id}/deps`, { action: 'remove', id: list[0].id });
    assert.equal(rm.length, 1);
    const other = (await S.post('/projects', { name: 'otherp' })).project;
    assert.equal((await S.raw('POST', `/api/projects/${other.id}/deps`, { action: 'add', service_id: web, external: 'x' })).status, 400, 'services of another project are not accepted');
  });
});

describe('M5 delete / archive rules', () => {
  it('delete a project with 2 services (2 repos, one merged task): repos + worktrees byte-identical, context in trash, rows gone, cursor usage kept', async () => {
    const S = await startServer({ env: { STUB_SLEEP_MS: '100' } });
    try {
      const X = makeRepo(path.join(S.work, 'pa', 'del-x'), { 'x.txt': 'x\n' });
      const Y = makeRepo(path.join(S.work, 'pb', 'del-y'), { 'y.txt': 'y\n' });
      const P = await S.addProject(X, 'doomed', 'true');
      const sy = addServiceRow(S, P.id, 'svc-y', Y);
      await S.post(`/projects/${P.id}/context/save`, { file: 'MEMORY.md', content: '# mem\n' });
      const t1 = await S.runToReview(P.id, { title: 'ex', prompt: 'p', files: ['x.txt'], service_id: P.serviceId });
      await S.post(`/tasks/${t1.id}/approve-merge`, {});                                   // finished (done)
      const t2 = await S.createTask(P.id, { title: 'ey', prompt: 'p', files: ['y.txt'], service_id: sy, engine: 'cursor' });
      await S.post(`/tasks/${t2.id}/approve-start`, {}); await S.waitStatus(t2.id, 'review');
      const usage = (await S.get('/health')).cursor_usage.used;
      assert.ok(usage >= 1);
      // refused while a task is unfinished (review), wrong confirm refused, nothing changes
      assert.equal((await S.raw('POST', `/api/projects/${P.id}/delete`, { confirm: 'doomed' })).status, 409);
      assert.equal((await S.raw('POST', `/api/projects/${P.id}/delete`, { confirm: 'nope' })).status, 400);
      await S.post(`/tasks/${t2.id}/reject-merge`, { reason: 'drop it' });
      const wtRoot = path.join(S.base, 'worktrees');
      const before = { x: hashTree(X), y: hashTree(Y), wt: hashTree(wtRoot) };
      const r = await S.post(`/projects/${P.id}/delete`, { confirm: 'doomed' });
      assert.equal(r.deleted, true); assert.equal(r.repositories_untouched, true);
      assert.equal(r.rows.services, 2); assert.equal(r.rows.tasks, 2);
      assert.deepEqual({ x: hashTree(X), y: hashTree(Y), wt: hashTree(wtRoot) }, before, 'repos and worktrees byte-identical');
      assert.ok(r.leftovers.worktrees.length >= 1 && r.leftovers.branches.length === 2);
      assert.equal((await S.raw('GET', `/api/projects/${P.id}`)).status, 404);
      assert.equal((await S.get('/projects')).find((p) => p.name === 'doomed'), undefined);
      assert.ok(r.context_moved_to && fs.existsSync(path.join(r.context_moved_to, 'MEMORY.md')));
      assert.equal(fs.existsSync(path.join(S.base, 'data', 'context', 'doomed')), false);
      assert.equal((await S.get('/health')).cursor_usage.used, usage, 'cursor usage (daily cap) survives project deletion');
      const d = new DatabaseSync(S.dbPath, { readOnly: true });
      assert.equal(d.prepare('SELECT COUNT(*) c FROM tasks').get().c, 0);
      assert.equal(d.prepare('SELECT COUNT(*) c FROM task_events').get().c, 0);
      assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0);
      d.close();
      // the same name and repo can be registered again afterwards
      const P2 = await S.addProject(X, 'doomed', 'true');
      assert.ok(P2.id);
    } finally { await S.stop(); }
  });

  it('delete is refused with active tasks; archive is refused with active tasks; empty/archived projects delete fine', async () => {
    const S = await startServer({ env: { STUB_SLEEP_MS: '100' } });
    try {
      const R = makeRepo(path.join(S.work, 'act'), { 'a.txt': 'a\n' });
      const P = await S.addProject(R, 'active', 'true');
      const t = await S.createTask(P.id, { title: 'slow', prompt: 'STUB_SLOW', files: ['a.txt'] });
      assert.equal((await S.raw('POST', `/api/projects/${P.id}/delete`, { confirm: 'active' })).status, 409, 'pending task blocks delete');
      await S.post(`/tasks/${t.id}/approve-start`, {});
      await S.waitFor(async () => (await S.get(`/tasks/${t.id}/events`)).some((e) => /engine local: aider/.test(e.message)), { what: 'running' });
      const del = await S.raw('POST', `/api/projects/${P.id}/delete`, { confirm: 'active' });
      assert.equal(del.status, 409); assert.match(del.json.error, /unfinished tasks/);
      assert.equal((await S.raw('POST', `/api/projects/${P.id}/archive`, {})).status, 409);
      await S.post(`/tasks/${t.id}/cancel`, {}); await S.waitStatus(t.id, 'failed');
      await S.post(`/projects/${P.id}/archive`, {});
      const r = await S.post(`/projects/${P.id}/delete`, { confirm: 'active' });
      assert.equal(r.deleted, true);
      assert.equal(fs.existsSync(R) && fs.existsSync(path.join(R, '.git')), true);
      const e = (await S.post('/projects', { name: 'empty' })).project;
      assert.equal((await S.post(`/projects/${e.id}/delete`, { confirm: 'empty' })).deleted, true);
    } finally { await S.stop(); require('node:child_process').execSync("pkill -f '[s]tub-aider.js' || true"); }
  });
});

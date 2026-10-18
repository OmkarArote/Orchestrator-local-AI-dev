'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('M0 basics: HTTP surface, Host/Origin/Content-Type guards', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('health + config + static dashboard', async () => {
    const h = await S.get('/health');
    assert.equal(h.ok, true);
    assert.ok(h.schema >= 3);
    const c = await S.get('/config');
    assert.deepEqual(c.engines, ['local', 'cursor', 'auto']);
    assert.equal(c.local_model, 'ollama_chat/ornith:9b');
    const r = await S.raw('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /Local AI Dev Orchestrator/);
    assert.equal((await S.raw('GET', '/app.js')).status, 200);
    assert.equal((await S.raw('GET', '/../config.js')).status, 404);
    assert.equal((await S.raw('GET', '/nope.txt')).status, 404);
  });

  it('rejects a foreign Host header', async () => {
    const code = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: S.port, path: '/api/health', headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(code, 403);
  });

  it('rejects a foreign Origin and a non-JSON content type on POST', async () => {
    const r1 = await S.raw('POST', '/api/projects/inspect', { path: '~/work' }, { Origin: 'http://evil.example' });
    assert.equal(r1.status, 403);
    const r2 = await fetch(S.url + '/api/projects/inspect', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(r2.status, 415);
  });

  it('unknown endpoints and methods', async () => {
    assert.equal((await S.raw('GET', '/api/nope')).status, 404);
    assert.equal((await S.raw('DELETE', '/api/tasks')).status, 405);
    assert.equal((await S.raw('GET', '/api/tasks/99999')).status, 404);
  });
});

describe('M0 projects: inspect / add existing / create new / update / archive (legacy API)', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('inspect, add, duplicate detection', async () => {
    const repo = makeRepo(path.join(S.work, 'alpha'), { 'a.txt': 'a\n' });
    const info = await S.post('/projects/inspect', { path: repo });
    assert.equal(info.is_git_repo, true);
    assert.equal(info.can_add, true);
    assert.equal(info.default_branch, 'main');
    const { project } = await S.post('/projects/add', { path: repo, name: 'alpha', check_cmd: 'test -f a.txt' });
    assert.equal(project.name, 'alpha');
    assert.equal(project.default_branch, 'main');
    assert.equal(project.check_cmd, 'test -f a.txt');
    const dup = await S.post('/projects/add', { path: repo, name: 'alpha2' }, { allowFail: true });
    assert.equal(dup.status, 409);
    const dupName = await S.post('/projects/add', { path: makeRepo(path.join(S.work, 'beta')), name: 'ALPHA' }, { allowFail: true });
    assert.equal(dupName.status, 409);
    const list = await S.get('/projects');
    assert.ok(list.some((p) => p.name === 'alpha'));
  });

  it('refuses unsafe paths and bad names', async () => {
    for (const p of ['/etc', '/', S.home, '~/.ssh', path.join(S.home, 'Library', 'x'), 'relative/path', '/tmp/\0x']) {
      const r = await S.post('/projects/add', { path: p, name: 'x' }, { allowFail: true });
      assert.ok(r.status >= 400 && r.status < 500, `path ${JSON.stringify(p)} should be rejected, got ${r.status}`);
    }
    const repo = makeRepo(path.join(S.work, 'gamma'));
    for (const n of ['../evil', 'a b', '-x', 'task-5', '']) {
      const r = await S.post('/projects/add', { path: repo, name: n || undefined, check_cmd: 'true' }, { allowFail: true });
      if (n === '') continue; // empty -> suggested name is used
      assert.equal(r.status, 400, `name ${n}`);
    }
  });

  it('non-git dir needs confirm_git_init; with it a baseline commit is made', async () => {
    const dir = path.join(S.work, 'plain'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    const r = await S.post('/projects/add', { path: dir, name: 'plain', check_cmd: 'true' }, { allowFail: true });
    assert.equal(r.status, 409);
    const ok = await S.post('/projects/add', { path: dir, name: 'plain', check_cmd: 'true', confirm_git_init: true });
    assert.equal(ok.git_initialized, true);
    assert.match(git(dir, 'log', '--oneline'), /Baseline commit/);
  });

  it('create new project: git init -b main + README + .gitignore + baseline commit', async () => {
    const r = await S.post('/projects/create', { name: 'fresh', parent_dir: S.work });
    const dir = path.join(S.work, 'fresh');
    assert.equal(r.project.name, 'fresh');
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
    const again = await S.post('/projects/create', { name: 'fresh', parent_dir: S.work }, { allowFail: true });
    assert.equal(again.status, 409);
    const outside = await S.post('/projects/create', { name: 'x1', parent_dir: '/tmp' }, { allowFail: true });
    assert.equal(outside.status, 403); // ADAPTED: outside the authorized roots is now 403 (was a generic 400 'not strictly inside home')
  });

  it('update settings and archive/unarchive', async () => {
    const repo = makeRepo(path.join(S.work, 'delta'));
    const { id } = await S.addProject(repo, 'delta', 'true');
    const u = await S.post(`/projects/${id}/update`, { check_cmd: 'test -f README.md', install_cmd: 'true', engine: 'auto' });
    assert.equal(u.check_cmd, 'test -f README.md');
    assert.equal(u.engine, 'auto');
    const bad = await S.post(`/projects/${id}/update`, { engine: 'nope' }, { allowFail: true });
    assert.equal(bad.status, 400);
    const st = await S.post(`/projects/${id}/update`, { settings: { route_apply: 'auto', context_max_chars: 5000 } });
    assert.equal(st.settings_effective.route_apply, 'auto');
    assert.equal(st.settings_effective.context_max_chars, 5000);
    assert.equal((await S.post(`/projects/${id}/update`, { settings: { bogus: 1 } }, { allowFail: true })).status, 400);
    assert.equal((await S.post(`/projects/${id}/update`, {}, { allowFail: true })).status, 400);
    const a = await S.post(`/projects/${id}/archive`, {});
    assert.equal(a.archived, true);
    assert.ok(!(await S.get('/projects')).some((p) => p.id === id));
    assert.ok((await S.get('/projects?archived=1')).some((p) => p.id === id));
    const t = await S.post('/tasks', { project_id: id, title: 't', prompt: 'p' }, { allowFail: true });
    assert.equal(t.status, 409);
    assert.equal((await S.post(`/projects/${id}/unarchive`, {})).archived, false);
  });
});

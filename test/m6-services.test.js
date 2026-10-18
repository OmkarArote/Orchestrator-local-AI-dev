'use strict';
// M6: service CRUD - inspect / add existing / create new / update / unregister / status, and the authorized-roots API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, fingerprint } = require('./helpers/harness');

function hashTree(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d) { for (const n of fs.readdirSync(d).sort()) { if (n === '.git') continue; /* git internals (index stat cache etc.) may be refreshed by read-only commands; refs are hashed below */ const p = path.join(d, n); const st = fs.lstatSync(p); h.update(path.relative(dir, p) + '\0'); if (st.isDirectory()) walk(p); else if (st.isSymbolicLink()) h.update(fs.readlinkSync(p)); else h.update(fs.readFileSync(p)); } })(dir);
  try { h.update(require('node:child_process').execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: dir, encoding: 'utf8' })); h.update(fs.readFileSync(path.join(dir, '.git', 'HEAD'))); } catch { /* not a git repo */ }
  return h.digest('hex');
}
const tmpOutside = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-outside-')));

describe('M6 add existing + inspect', () => {
  let S, P;
  before(async () => { S = await startServer(); P = (await S.post('/projects', { name: 'proj' })).project; });
  after(async () => { await S.stop(); });
  const inspect = (p) => S.post(`/projects/${P.id}/services/inspect`, { path: p });
  const add = (b, o) => S.post(`/projects/${P.id}/services/add-existing`, b, o);

  it('inspect reports guard + git state without writing anything; add registers a service with canonical path, branch, stack', async () => {
    const R = makeRepo(path.join(S.work, 'svc-a'), { 'package.json': '{"scripts":{"test":"node --test"}}', 'a.js': '1\n' });
    const before = hashTree(R);
    const i = await inspect(R);
    assert.equal(i.authorized, true); assert.equal(i.is_git_repo, true); assert.equal(i.is_toplevel, true); assert.equal(i.default_branch, 'main');
    assert.equal(i.stack.kind, 'node'); assert.equal(i.can_add, true); assert.equal(i.registered_as, null); assert.equal(i.suggested_name, 'svc-a');
    assert.equal(hashTree(R), before, 'inspect is read-only');
    const r = await add({ path: R, name: 'svc-a', type: 'api', description: 'the api' });
    assert.equal(r.service.local_path, R); assert.equal(r.service.path, '.'); assert.equal(r.service.default_branch, 'main');
    assert.equal(r.service.origin, 'existing'); assert.equal(r.service.status, 'active'); assert.equal(r.service.type, 'api'); assert.equal(r.service.stack, 'node');
    assert.equal(r.service.check_cmd, 'npm test');
    assert.equal(fingerprint(R), fingerprint(R));
    // duplicate: same location => 409 pointing at the existing registration; inspect shows registered_as
    const dup = await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: R, name: 'other-name' });
    assert.equal(dup.status, 409); assert.match(dup.json.error, /already registered as service 'svc-a'/);
    assert.equal((await inspect(R)).registered_as.service, 'svc-a');
    // via a different spelling of the path (case / trailing slash / ./)
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: R + '/./', name: 'x' })).status, 409);
    const upper = R.replace('/work/', '/WORK/').replace('/Work/', '/WORK/');
    if (upper !== R && fs.existsSync(upper)) assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: upper, name: 'y' })).status, 409); // case-insensitive filesystems only (macOS)
    // same name in the project
    const R2 = makeRepo(path.join(S.work, 'svc-b'), { 'b.txt': 'b\n' });
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: R2, name: 'SVC-A' })).status, 409);
  });

  it('unsafe paths are rejected: outside roots, traversal, symlink out, hidden, missing, file, NUL, relative, ~user', async () => {
    const out = tmpOutside(); makeRepo(out, { 'x.txt': 'x\n' });
    const hidden = makeRepo(path.join(S.work, '.hidden-repo'), { 'h.txt': 'h\n' });
    fs.symlinkSync(out, path.join(S.work, 'link-out'));
    fs.writeFileSync(path.join(S.work, 'afile.txt'), 'x');
    const cases = [[out, 403], [path.join(S.work, '..', 'escape'), 403], [path.join(S.work, 'link-out'), 403], [hidden, 403], [path.join(S.work, 'nope'), 400], [path.join(S.work, 'afile.txt'), 400],
      ['/etc', 403], [S.home, 403], ['relative/path', 400], ['~root/x', 400], ['', 400], [path.join(S.work, 'a\0b'), 400]];
    for (const [p, st] of cases) {
      const r = await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: p, name: 'zz' });
      assert.ok(r.status === st || (st === 403 && r.status === 400), `${JSON.stringify(p)} -> ${r.status} ${r.text.slice(0, 150)}`);
      assert.ok(r.status >= 400);
    }
    const i = await S.post(`/projects/${P.id}/services/inspect`, { path: out });
    assert.equal(i.authorized, false); assert.equal(i.auth_code, 'outside_roots'); assert.equal(i.can_add, false);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('a folder inside a repo registers as a subfolder service (local_path = repo root, subdir)', async () => {
    const R = makeRepo(path.join(S.work, 'mono2'), { 'api/main.py': 'x\n', 'web/index.js': 'y\n', 'README.md': 'r\n' });
    const sub = await add({ path: path.join(R, 'api'), name: 'mono-api' });
    assert.equal(sub.service.local_path, R); assert.equal(sub.service.path, 'api');
    const whole = await add({ path: R, name: 'mono-root' });
    assert.equal(whole.service.path, '.');
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: path.join(R, 'api'), name: 'again' })).status, 409);
  });

  it('non-git directory needs confirm_git_init (baseline commit + .gitignore); repo without commits likewise', async () => {
    const D = path.join(S.work, 'plain'); fs.mkdirSync(D); fs.writeFileSync(path.join(D, 'f.txt'), 'f\n');
    const need = await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: D, name: 'plain' });
    assert.equal(need.status, 409); assert.equal(need.json.needs_git_init, true);
    assert.equal(fs.existsSync(path.join(D, '.git')), false, 'nothing written without confirmation');
    const ok = await add({ path: D, name: 'plain', confirm_git_init: true });
    assert.equal(ok.git_initialized, true); assert.equal(git(D, 'rev-list', '--count', 'HEAD').trim(), '1'); assert.equal(ok.service.default_branch, 'main');
    const E = path.join(S.work, 'nocommit'); fs.mkdirSync(E); git(E, 'init', '-q', '-b', 'main');
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/add-existing`, { path: E, name: 'nc' })).status, 409);
    assert.equal((await add({ path: E, name: 'nc', confirm_git_init: true })).service.default_branch, 'main');
  });
});

describe('M6 create new', () => {
  let S, P, home;
  before(async () => { S = await startServer(); P = (await S.post('/projects', { name: 'cproj' })).project; home = S.home; });
  after(async () => { await S.stop(); });
  const create = (b, o) => S.post(`/projects/${P.id}/services/create`, b, o);

  it('creates under an authorized root: git init -b main, README + .gitignore, initial commit, worktree can be cut; orchestrator identity without a user identity', async () => {
    const r = await create({ name: 'fresh-svc', parent_dir: S.work, type: 'worker', description: 'fresh' });
    const dir = path.join(S.work, 'fresh-svc');
    assert.equal(r.service.local_path, dir); assert.equal(r.service.origin, 'create'); assert.equal(r.service.default_branch, 'main');
    assert.ok(fs.existsSync(path.join(dir, 'README.md'))); assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main'); assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git(dir, 'log', '-1', '--format=%ae').trim(), 'ai-orchestrator@localhost'); assert.equal(r.identity_used, 'orchestrator');
    assert.equal(git(dir, 'status', '--porcelain').trim(), '');
    const wt = path.join(S.base, 'wt-check'); git(dir, 'worktree', 'add', '-q', '-b', 'ai/x', wt, 'main'); git(dir, 'worktree', 'remove', '--force', wt);
    // and it runs a task end to end
    const t = await S.runToReview(P.id, { title: 'first', prompt: 'p', files: ['new.txt'], service_id: r.service.id });
    assert.equal(t.status, 'review');
    assert.match(r.note || '', /defaulted/);
  });

  it('empty repo variant (no README, no .gitignore) still gets the initial commit; node template is opt-in only; user git identity is used when configured', async () => {
    const e = await create({ name: 'bare-svc', parent_dir: S.work, readme: false, gitignore: 'none' });
    const dir = path.join(S.work, 'bare-svc');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== '.git'), []);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(fs.existsSync(path.join(S.work, 'fresh-svc', 'package.json')), false, 'default template is empty');
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Real Person\n\temail = real@example.com\n');
    const n = await create({ name: 'node-svc', parent_dir: S.work, template: 'node' });
    const nd = path.join(S.work, 'node-svc');
    assert.ok(fs.existsSync(path.join(nd, 'package.json'))); assert.equal(n.service.check_cmd, 'npm test'); assert.equal(n.service.stack, 'node');
    assert.equal(git(nd, 'log', '-1', '--format=%ae').trim(), 'real@example.com'); assert.equal(n.identity_used, 'your git identity');
    fs.rmSync(path.join(home, '.gitconfig'));
    assert.equal((await S.raw('POST', `/api/projects/${P.id}/services/create`, { name: 'bad-tpl', parent_dir: S.work, template: 'rails' })).status, 400);
    assert.equal(e.service.id > 0, true);
  });

  it('rejects: outside root, traversal, existing dir (even empty, never overwritten), symlink target, missing parent, bad names; nothing is written', async () => {
    const out = tmpOutside();
    const existing = path.join(S.work, 'exists-svc'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep.txt'), 'precious');
    const emptyDir = path.join(S.work, 'empty-existing'); fs.mkdirSync(emptyDir);
    fs.symlinkSync(out, path.join(S.work, 'symlink-svc'));
    const before = hashTree(existing);
    const bad = [
      [{ name: 'o1', parent_dir: out }, 403], [{ name: 'o2', parent_dir: path.join(S.work, '..') }, 403], [{ name: 'exists-svc', parent_dir: S.work }, 400],
      [{ name: 'empty-existing', parent_dir: S.work }, 400], [{ name: 'symlink-svc', parent_dir: S.work }, 403], [{ name: 'p1', parent_dir: path.join(S.work, 'missing-parent') }, 400],
      [{ name: '../evil', parent_dir: S.work }, 400], [{ name: 'ok-name', dir_name: '../../evil', parent_dir: S.work }, 400], [{ name: 'a b', parent_dir: S.work }, 400], [{ name: '.hid', parent_dir: S.work }, 400],
      [{ name: 'x', dir_name: 'sub/dir', parent_dir: S.work }, 400], [{ name: 'x2', parent_dir: path.join(S.work, '.hidden') }, 403],
    ];
    for (const [b, st] of bad) { const r = await S.raw('POST', `/api/projects/${P.id}/services/create`, b); assert.ok(r.status === st || (st === 403 && r.status === 400) || (st === 400 && r.status === 403), `${JSON.stringify(b)} -> ${r.status} ${r.text.slice(0, 160)}`); assert.ok(r.status >= 400); }
    assert.equal(hashTree(existing), before, 'existing directory untouched');
    assert.deepEqual(fs.readdirSync(emptyDir), [], 'existing empty directory untouched (no .git)');
    assert.deepEqual(fs.readdirSync(out), [], 'nothing written through the symlink');
    assert.equal(fs.existsSync(path.join(path.dirname(S.work), 'evil')), false);
    fs.rmSync(out, { recursive: true, force: true });
  });
});

describe('M6 failure injection + journal sweep', () => {
  it('failure after mkdir removes ONLY what this call created (siblings untouched), journal cleaned, no service row', async () => {
    const S = await startServer({ env: { ORCH_TEST_FAIL_AFTER_MKDIR: '1' } });
    try {
      const P = (await S.post('/projects', { name: 'inj' })).project;
      const sibling = path.join(S.work, 'inj-svc-sibling'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'f'), '1');
      const before = hashTree(S.work);
      const r = await S.raw('POST', `/api/projects/${P.id}/services/create`, { name: 'inj-svc', parent_dir: S.work });
      assert.ok(r.status >= 400, r.text);
      assert.equal(fs.existsSync(path.join(S.work, 'inj-svc')), false, 'created dir removed');
      assert.equal(hashTree(S.work), before, 'everything else byte-identical');
      assert.equal((await S.get(`/projects/${P.id}/services`)).length, 0);
      const d = new DatabaseSync(S.dbPath, { readOnly: true });
      assert.deepEqual(d.prepare("SELECT kind, state FROM fs_journal").all().map((x) => ({ ...x })), [{ kind: 'new_service', state: 'cleaned' }]);
      d.close();
    } finally { await S.stop(); }
  });

  it('startup sweep: an open journal entry (crash mid-create) is removed; an unjournaled dir and a registered service are never touched', async () => {
    const S1 = await startServer({ keep: true });
    let S2;
    try {
      const P = (await S1.post('/projects', { name: 'sweep' })).project;
      const R = makeRepo(path.join(S1.work, 'registered'), { 'a': '1\n' });
      await S1.post(`/projects/${P.id}/services/add-existing`, { path: R, name: 'registered' });
      const orphan = path.join(S1.work, 'crash-orphan'); fs.mkdirSync(orphan); fs.writeFileSync(path.join(orphan, 'half.txt'), 'half-written');
      const innocent = path.join(S1.work, 'innocent'); fs.mkdirSync(innocent); fs.writeFileSync(path.join(innocent, 'mine.txt'), 'user data');
      const d = new DatabaseSync(S1.dbPath);
      d.prepare("INSERT INTO fs_journal (kind, path, state) VALUES ('new_service', ?, 'open')").run(orphan);
      d.prepare("INSERT INTO fs_journal (kind, path, state) VALUES ('new_service', ?, 'open')").run(R);      // crashed after the DB insert: must be kept
      d.close();
      await S1.stop();
      S2 = await startServer({ dbPath: S1.dbPath, keep: true });
      assert.equal(fs.existsSync(orphan), false, 'orphan removed by the sweep');
      assert.equal(fs.existsSync(path.join(innocent, 'mine.txt')), true);
      assert.equal(fs.existsSync(path.join(R, '.git')), true, 'registered repo kept');
      const dd = new DatabaseSync(S1.dbPath, { readOnly: true });
      assert.deepEqual(dd.prepare('SELECT state FROM fs_journal ORDER BY id').all().map((x) => x.state), ['cleaned', 'committed']);
      dd.close();
    } finally { if (S2) await S2.stop(); fs.rmSync(S1.base, { recursive: true, force: true }); if (S2) fs.rmSync(S2.base, { recursive: true, force: true }); }
  });
});

describe('M6 update / unregister / status / roots API', () => {
  let S, P, R, svc;
  before(async () => {
    S = await startServer(); P = (await S.post('/projects', { name: 'upd' })).project;
    R = makeRepo(path.join(S.work, 'upd-svc'), { 'a.txt': 'a\n' }); git(R, 'branch', 'develop');
    svc = (await S.post(`/projects/${P.id}/services/add-existing`, { path: R, name: 'upd-svc' })).service;
  });
  after(async () => { await S.stop(); });

  it('update validates: type, stack, commands, default_branch (must exist), env_config non-secret only, rename conflicts', async () => {
    const u = await S.post(`/services/${svc.id}/update`, { type: 'api', stack: 'python/fastapi', check_cmd: 'pytest -q', install_cmd: 'pip install -r requirements.txt', build_cmd: 'make', test_cmd: 'pytest', description: 'd', default_branch: 'develop', env_config: { LOG_LEVEL: 'debug', REGION: 'eu' } });
    assert.equal(u.type, 'api'); assert.equal(u.stack, 'python/fastapi'); assert.equal(u.default_branch, 'develop'); assert.deepEqual(u.env_config, { LOG_LEVEL: 'debug', REGION: 'eu' });
    for (const [b, re] of [[{ type: 'database' }, /type must be/], [{ stack: '$(x)' }, /stack must be/], [{ default_branch: 'nope' }, /not found/], [{ default_branch: '-x' }, /not found/],
      [{ env_config: { API_KEY: 'x' } }, /looks like a secret/], [{ env_config: { GOOD: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }, /secret|token/], [{ env_config: { 'bad name': 'x' } }, /invalid variable name/],
      [{ env_config: { A: 'x'.repeat(40) } }, /secret/], [{ name: 'a b' }, /service name/], [{}, /nothing to update/]]) {
      const r = await S.raw('POST', `/api/services/${svc.id}/update`, b); assert.equal(r.status, 400, JSON.stringify(b) + r.text); assert.match(r.json.error, re);
    }
    const R2 = makeRepo(path.join(S.work, 'upd-svc2'), { 'b.txt': 'b\n' });
    await S.post(`/projects/${P.id}/services/add-existing`, { path: R2, name: 'second' });
    assert.equal((await S.raw('POST', `/api/services/${svc.id}/update`, { name: 'second' })).status, 409);
    assert.equal((await S.post(`/services/${svc.id}/update`, { name: 'renamed-svc' })).name, 'renamed-svc');
  });

  it('status is local-only and reports missing repos; unregister needs confirm, never deletes files, refuses with task history', async () => {
    const st = await S.get(`/services/${svc.id}/status`);
    assert.equal(st.exists, true); assert.equal(st.usable, true); assert.equal(st.branch, 'main'); assert.equal(st.clean, true); assert.equal(st.on_default_branch, false /* default is develop now */);
    await S.post(`/services/${svc.id}/update`, { default_branch: 'main' });
    await S.post(`/services/${svc.id}/update`, { check_cmd: 'true', install_cmd: '' });
    const t = await S.runToReview(P.id, { title: 't', prompt: 'p', files: ['a.txt'], service_id: svc.id });
    await S.post(`/tasks/${t.id}/reject-merge`, { reason: 'x' });
    const hist = await S.raw('POST', `/api/services/${svc.id}/remove`, { confirm: 'renamed-svc' });
    assert.equal(hist.status, 409); assert.match(hist.json.error, /archive it instead/);
    const R3 = makeRepo(path.join(S.work, 'rm-me'), { 'c.txt': 'c\n' });
    const s3 = (await S.post(`/projects/${P.id}/services/add-existing`, { path: R3, name: 'rm-me' })).service;
    await S.post(`/projects/${P.id}/deps`, { action: 'add', service_id: s3.id, external: 'redis' });
    assert.equal((await S.raw('POST', `/api/services/${s3.id}/remove`, {})).status, 400);
    const before = hashTree(R3);
    const rm = await S.post(`/services/${s3.id}/remove`, { confirm: 'rm-me' });
    assert.equal(rm.files_untouched, true); assert.equal(hashTree(R3), before);
    assert.equal((await S.get(`/projects/${P.id}/services`)).some((x) => x.name === 'rm-me'), false);
    assert.equal((await S.get(`/projects/${P.id}/deps`)).length, 0);
    fs.renameSync(R3, R3 + '-gone');
    const gone = makeRepo(path.join(S.work, 'gone-later'), { 'd': '1\n' });
    const s4 = (await S.post(`/projects/${P.id}/services/add-existing`, { path: gone, name: 'gone-later' })).service;
    fs.renameSync(gone, gone + '-moved');
    const ms = await S.get(`/services/${s4.id}/status`);
    assert.equal(ms.exists, false); assert.match(ms.problem, /does not exist/);
  });

  it('roots API: default root listed; add validates (no /, no home, no system dirs, no hidden, not own dirs); check; remove blocked while in use', async () => {
    const l = await S.get('/fs/roots');
    assert.equal(l.length, 1); assert.equal(l[0].path, fs.realpathSync.native(S.work));
    for (const p of ['/', '/etc', '/usr', S.home, path.join(S.base, 'worktrees'), path.join(S.work, '.git-hidden')]) {
      const r = await S.raw('POST', '/api/fs/roots', { path: p }); assert.ok(r.status === 403 || r.status === 400, `${p} -> ${r.status} ${r.text.slice(0, 120)}`);
    }
    const extra = tmpOutside();
    const added = await S.post('/fs/roots', { path: extra, label: 'scratch' });
    assert.equal(added.path, extra);
    assert.equal((await S.raw('POST', '/api/fs/roots', { path: extra })).status, 409);
    assert.equal((await S.post('/fs/check', { path: path.join(extra, 'x') })).ok, true);
    assert.equal((await S.post('/fs/check', { path: '/etc/passwd' })).ok, false);
    const inExtra = makeRepo(path.join(extra, 'r'), { 'z': '1\n' });
    await S.post(`/projects/${P.id}/services/add-existing`, { path: inExtra, name: 'in-extra' });
    const rm = await S.raw('POST', `/api/fs/roots/${added.id}/remove`, {});
    assert.equal(rm.status, 409); assert.match(rm.json.error, /used by 1 registered service/);
    const sid = (await S.get(`/projects/${P.id}/services`)).find((x) => x.name === 'in-extra').id;
    await S.post(`/services/${sid}/archive`, {});
    assert.equal((await S.post(`/fs/roots/${added.id}/remove`, {})).removed, extra);
    fs.rmSync(extra, { recursive: true, force: true });
  });
});

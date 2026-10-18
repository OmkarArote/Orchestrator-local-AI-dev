'use strict';
// M7: clone import. Remotes are LOCAL bare repos reached through the test-only ORCH_TEST_ALLOW_FILE=1 flag (file:// is never allowed otherwise).
// The single real-network clone lives in m7-network.test.js (opt-in).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git } = require('./helpers/harness');

const ENV = { ORCH_TEST_ALLOW_FILE: '1' };
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function makeBare(files = { 'README.md': '# remote\n', 'package.json': '{"scripts":{"test":"node --test","postinstall":"touch /tmp/ORCH-CANARY-NEVER"}}\n' }, branch = 'main') {
  const work = tmp('orch-remote-src-'); makeRepo(work, files, branch);
  const bare = path.join(tmp('orch-remote-'), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  fs.rmSync(work, { recursive: true, force: true });
  return { bare, url: `file://${bare}` };
}
const stagingDirs = (S) => fs.readdirSync(S.work).filter((n) => n.startsWith('.orch-clone-'));
async function waitJob(S, id, states = ['done', 'failed', 'cancelled'], timeout = 30000) {
  return S.waitFor(async () => { const j = await S.get(`/jobs/${id}`); return states.includes(j.state) ? j : null; }, { timeout, what: `job ${id}` });
}
const journal = (S) => { const db = new DatabaseSync(S.dbPath); try { return db.prepare('SELECT kind, path, state FROM fs_journal ORDER BY id').all(); } finally { db.close(); } };
const slowHook = (S, secs) => {
  const hook = path.join(S.base, 'slow-hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\nsleep ${secs}\nexec "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(S.home, '.gitconfig'), `[uploadpack]\n\tpackObjectsHook = ${hook}\n[user]\n\tname = T\n\temail = t@example.com\n`);
};
const noHook = (S) => fs.writeFileSync(path.join(S.home, '.gitconfig'), '[user]\n\tname = T\n\temail = t@example.com\n');

describe('M7 clone import (local bare remote)', () => {
  let S, P, FIRST;
  before(async () => { S = await startServer({ env: ENV }); P = (await S.post('/projects', { name: 'imp' })).project; noHook(S); });
  after(async () => { await S.stop(); });
  const imp = (b, o) => S.api('POST', `/projects/${P.id}/services/import`, b, o);

  it('imports into <dest>/<dir>, atomically, registers origin=import; job reports progress; nothing from the repo runs', async () => {
    const R = makeBare(); FIRST = R;
    const started = await imp({ url: R.url, name: 'svc-one', dir_name: 'svc-one', type: 'api' });
    assert.match(started.id, /^[a-f0-9]{16}$/); assert.ok(['queued', 'running'].includes(started.state));
    const j = await waitJob(S, started.id);
    assert.equal(j.state, 'done', JSON.stringify(j));
    assert.equal(j.percent, 100);
    const svc = j.result.service;
    assert.equal(svc.origin, 'import'); assert.equal(svc.local_path, path.join(S.work, 'svc-one')); assert.equal(svc.path, '.'); assert.equal(svc.default_branch, 'main');
    assert.equal(svc.remote_url, R.url); assert.equal(svc.type, 'api'); assert.equal(svc.check_cmd, 'npm test');
    assert.ok(fs.existsSync(path.join(svc.local_path, 'README.md')));
    assert.equal(git(svc.local_path, 'remote', 'get-url', 'origin').trim(), R.url);
    assert.deepEqual(stagingDirs(S), []);
    assert.ok(!fs.existsSync('/tmp/ORCH-CANARY-NEVER'), 'postinstall never runs');
    assert.ok(journal(S).every((r) => r.state !== 'open'), JSON.stringify(journal(S)));
    assert.equal((await S.get(`/projects/${P.id}/services`)).some((x) => x.name === 'svc-one'), true);
    assert.equal((await S.get(`/jobs`)).some((x) => x.id === started.id), true);
  });

  it('validation: bad URLs, destinations, names, branch, duplicates -> 4xx, nothing created', async () => {
    const R = makeBare();
    const base = { url: R.url, name: 'v1' };
    const before = fs.readdirSync(S.work).sort();
    const cases = [
      [{ ...base, url: 'http://example.com/a/b.git' }, 400], [{ ...base, url: 'ext::sh -c touch% /tmp/pwn' }, 400], [{ ...base, url: 'https://user:pw@example.com/a/b.git' }, 400],
      [{ ...base, url: '--upload-pack=touch /tmp/x' }, 400], [{ ...base, url: '/abs/local/path' }, 400], [{ ...base, url: 'file:///etc/passwd;x' }, 400], [{ ...base, url: '' }, 400],
      [{ ...base, dest_parent: os.tmpdir() }, 403], [{ ...base, dest_parent: path.join(S.work, 'missing') }, 400], [{ ...base, dest_parent: '/etc' }, 403],
      [{ ...base, name: 'bad name!' }, 400], [{ ...base, dir_name: '../escape' }, 400], [{ ...base, dir_name: '.hidden' }, 400], [{ ...base, branch: '--evil' }, 400], [{ ...base, branch: 'a..b' }, 400],
      [{ ...base, name: 'svc-one' }, 409], [{ ...base, name: 'v2', dir_name: 'svc-one' }, 409], [{ ...base, url: FIRST.url, name: 'v3' }, 409 /* remote already registered */],
      [{ ...base, name: 'v4', type: 'nonsense' }, 400],
    ];
    for (const [b, st] of cases) {
      const r = await imp(b, { allowFail: true });
      assert.equal(r.status, st, `${JSON.stringify(b)} -> ${r.status} ${r.text.slice(0, 200)}`);
    }
    assert.deepEqual(fs.readdirSync(S.work).sort(), before, 'validation failures touch nothing');
    // archived project
    const R3 = makeBare({ 'q.txt': 'q\n' });
    const AP = (await S.post('/projects', { name: 'arch' })).project; await S.post(`/projects/${AP.id}/archive`, {});
    assert.equal((await S.api('POST', `/projects/${AP.id}/services/import`, { url: R3.url, name: 'q', dir_name: 'q-arch' }, { allowFail: true })).status, 409);
  });

  it('unknown branch / unreachable ssh host fail in the job with a friendly message and leave nothing behind', async () => {
    const R = makeBare();
    const before = fs.readdirSync(S.work).sort();
    const a = await imp({ url: R.url, name: 'nb', dir_name: 'nb', branch: 'does-not-exist' });
    const ja = await waitJob(S, a.id);
    assert.equal(ja.state, 'failed'); assert.ok(ja.error && !/\/Users\//.test(ja.error), ja.error);
    const b = await imp({ url: 'ssh://git@127.0.0.1:1/nobody/none.git', name: 'sshx', dir_name: 'sshx' });
    const jb = await waitJob(S, b.id);
    assert.equal(jb.state, 'failed'); assert.equal(jb.error_code, 'preflight'); assert.ok(jb.error.length > 5);
    assert.deepEqual(fs.readdirSync(S.work).sort(), before);
    assert.equal((await S.get(`/projects/${P.id}/services`)).some((x) => ['nb', 'sshx'].includes(x.name)), false);
    assert.ok(journal(S).every((r) => r.state !== 'open'));
    // empty remote
    const emptyBare = path.join(tmp('orch-empty-'), 'e.git'); execFileSync('git', ['init', '-q', '--bare', emptyBare]);
    const c = await imp({ url: `file://${emptyBare}`, name: 'emp', dir_name: 'emp' });
    const jc = await waitJob(S, c.id); assert.equal(jc.state, 'failed'); assert.match(jc.error, /empty/);
    assert.deepEqual(fs.readdirSync(S.work).sort(), before);
  });

  it('hooks from git templates/user config never run (positive control proves the canary works)', async () => {
    const canary = path.join(S.base, 'CANARY'); const tdir = path.join(S.base, 'tpl'); fs.mkdirSync(path.join(tdir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(tdir, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${canary}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(S.home, '.gitconfig'), `[init]\n\ttemplateDir = ${tdir}\n[user]\n\tname = T\n\temail = t@example.com\n`);
    try {
      const R = makeBare({ 'a.txt': 'a\n' });
      // control: a plain clone with the same HOME runs the hook
      const ctl = path.join(S.base, 'control-clone');
      spawnSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', R.url, ctl], { env: { ...process.env, HOME: S.home }, stdio: 'ignore' });
      assert.ok(fs.existsSync(canary), 'control: the template hook runs for a plain git clone');
      fs.rmSync(canary);
      const r = await imp({ url: R.url, name: 'hookless', dir_name: 'hookless' });
      assert.equal((await waitJob(S, r.id)).state, 'done');
      assert.ok(fs.existsSync(path.join(S.work, 'hookless', '.git', 'hooks', 'post-checkout')), 'template hook was copied into the clone');
      assert.ok(!fs.existsSync(canary), 'orchestrator clone ran NO hook');
    } finally { noHook(S); }
  });

  it('cancel mid-clone kills git, removes the staging dir, leaves no service/dir; in-flight duplicates are refused; unknown job 404', async () => {
    slowHook(S, 8);
    try {
      const R = makeBare();
      const before = fs.readdirSync(S.work).sort();
      const a = await imp({ url: R.url, name: 'slow1', dir_name: 'slow1' });
      await S.waitFor(() => stagingDirs(S).length === 1, { what: 'staging dir', timeout: 15000 });
      assert.equal((await S.get(`/jobs/${a.id}`)).phase, 'cloning');
      assert.equal((await imp({ url: R.url, name: 'slow2', dir_name: 'slow2' }, { allowFail: true })).status, 409, 'same remote already importing');
      const R2 = makeBare({ 'z.txt': 'z\n' });
      assert.equal((await imp({ url: R2.url, name: 'slow3', dir_name: 'slow1' }, { allowFail: true })).status, 409, 'same target already importing');
      const c = await S.post(`/jobs/${a.id}/cancel`);
      assert.equal(c.cancelled, true);
      const j = await waitJob(S, a.id); assert.equal(j.state, 'cancelled');
      assert.deepEqual(fs.readdirSync(S.work).sort(), before, 'staging dir removed, no target');
      assert.equal((await S.get(`/projects/${P.id}/services`)).some((x) => x.name === 'slow1'), false);
      assert.ok(journal(S).every((r) => r.state !== 'open'), JSON.stringify(journal(S)));
      assert.equal((await S.post(`/jobs/${a.id}/cancel`)).cancelled, false, 'cancel is idempotent');
    } finally { noHook(S); }
    assert.equal((await S.raw('GET', '/api/jobs/0123456789abcdef')).status, 404);
    assert.equal((await S.raw('GET', '/api/jobs/nothex')).status, 404);
  });
});

describe('M7 crash safety: kill -9 mid-clone is swept at the next start', () => {
  it('removes the journaled staging dir, registers nothing', async () => {
    const base = tmp('orch-test-crash-');
    let S = await startServer({ env: ENV, base, keep: true });
    let S2;
    try {
      const P = (await S.post('/projects', { name: 'crash' })).project;
      noHook(S); slowHook(S, 20);
      const R = makeBare();
      const a = await S.api('POST', `/projects/${P.id}/services/import`, { url: R.url, name: 'dead', dir_name: 'dead' });
      await S.waitFor(() => stagingDirs(S).length === 1, { what: 'staging dir', timeout: 15000 });
      S.child.kill('SIGKILL');
      await new Promise((r) => S.child.on('exit', r));
      spawnSync('pkill', ['-KILL', '-f', base]);       // orphaned git clone / hook of the killed server
      assert.equal(stagingDirs(S).length, 1, 'the crash left the staging dir behind');
      assert.deepEqual(journal(S).filter((r) => r.state === 'open').map((r) => r.kind), ['clone_staging']);
      noHook(S);
      await S.fake.close();
      S2 = await startServer({ env: ENV, base });
      await S2.waitFor(() => stagingDirs(S2).length === 0, { what: 'sweep', timeout: 15000 });
      assert.ok(journal(S2).every((r) => r.state !== 'open'));
      assert.equal((await S2.get(`/projects/${P.id}/services`)).some((x) => x.name === 'dead'), false);
      assert.ok(!fs.existsSync(path.join(S2.work, 'dead')));
      assert.match(S2.logs(), /journal sweep removed 1/);
      assert.ok(a.id);
    } finally { if (S2) await S2.stop(); else { spawnSync('pkill', ['-KILL', '-f', base]); fs.rmSync(base, { recursive: true, force: true }); } }
  });
});

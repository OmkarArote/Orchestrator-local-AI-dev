'use strict';
// Schema v7: optional dev/uat/live branches on a service. Additive migration, empty allowed, a name must exist.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v7-')));
const envFor = (dbPath, extra = {}) => ({ ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(path.dirname(dbPath), 'logs'), ORCH_WORKTREES: path.join(path.dirname(dbPath), 'wt'), ORCH_CONTEXT_DIR: path.join(path.dirname(dbPath), 'ctx'), ...extra });
function openNew(dbPath, extra = {}) {
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: envFor(dbPath, extra) });
  return JSON.parse(out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop());
}
const rows = (dbPath, sql) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
const col = (dbPath, table, name) => rows(dbPath, `PRAGMA table_info(${table})`).some((r) => r.name === name);

function rewindToV6(dbPath) {
  const d = new DatabaseSync(dbPath);
  try {
    d.exec('ALTER TABLE services DROP COLUMN dev_branch');
    d.exec('ALTER TABLE services DROP COLUMN uat_branch');
    d.exec('ALTER TABLE services DROP COLUMN live_branch');
    d.exec('ALTER TABLE tasks DROP COLUMN flow');
    d.exec('ALTER TABLE tasks DROP COLUMN iteration');
    d.exec('PRAGMA user_version = 6');
  } finally { d.close(); }
}

describe('schema v7 migration', () => {
  let dir;
  before(() => { dir = tmp(); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a brand-new database is v7 with the columns and no backup', () => {
    const fresh = path.join(dir, 'fresh', 'orchestrator.db');
    fs.mkdirSync(path.dirname(fresh), { recursive: true });
    assert.equal(openNew(fresh).v, 9);
    for (const c of ['dev_branch', 'uat_branch', 'live_branch']) assert.equal(col(fresh, 'services', c), true, c);
    assert.equal(col(fresh, 'tasks', 'flow'), true);
    assert.equal(col(fresh, 'tasks', 'iteration'), true);
    assert.equal(fs.readdirSync(path.dirname(fresh)).filter((f) => f.startsWith('pre-v')).length, 0);
  });

  it('v6 -> v7 keeps rows, defaults flow and iteration, and writes one backup', () => {
    const db = path.join(dir, 'up.db');
    assert.equal(openNew(db).v, 9);
    const w = new DatabaseSync(db);
    w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p','p','','','true')");
    w.exec("INSERT INTO services (project_id, name, path, local_path, default_branch) VALUES (1,'api','.','/x','main')");
    w.exec("INSERT INTO tasks (project_id, service_id, title, prompt) VALUES (1,1,'t','p')");
    w.close();
    const before = rows(db, 'SELECT COUNT(*) c FROM tasks')[0].c;
    rewindToV6(db);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 6);
    assert.equal(col(db, 'services', 'dev_branch'), false);
    assert.equal(openNew(db).v, 9);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM tasks')[0].c, before);
    assert.equal(rows(db, 'SELECT flow, iteration FROM tasks')[0].flow, 'v1');
    assert.equal(rows(db, 'SELECT iteration FROM tasks')[0].iteration, 1);
    assert.equal(rows(db, 'SELECT dev_branch FROM services')[0].dev_branch, null);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('pre-v7-migration-'));
    assert.equal(backups.length, 1);
    assert.equal(rows(path.join(dir, backups[0]), 'SELECT user_version v FROM pragma_user_version')[0].v, 6);
    assert.equal(openNew(db).v, 9);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-v7-migration-')).length, 1, 'a second open does not back up again');
  });

  it('failure injection rolls back to v6 and a clean retry reaches v7', () => {
    const db = path.join(dir, 'fail.db');
    assert.equal(openNew(db).v, 9);
    rewindToV6(db);
    assert.throws(() => openNew(db, { ORCH_TEST_FAIL_MIGRATION_V7: '1' }), (e) => /v7 migration failed and was rolled back/.test(String(e.stderr)) && /injected failure/.test(String(e.stderr)));
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 6);
    assert.equal(col(db, 'services', 'dev_branch'), false);
    assert.equal(col(db, 'tasks', 'flow'), false);
    assert.equal(openNew(db).v, 9);
    assert.equal(col(db, 'tasks', 'iteration'), true);
  });
});

describe('service environment branches', () => {
  let S;
  before(async () => { S = await startServer(); });
  after(async () => { await S.stop(); });

  it('saves branches that exist, clears with a blank, and rejects a missing name', async () => {
    const repo = makeRepo(path.join(S.work, 'api-seva'), { 'a.txt': 'a\n' });
    git(repo, 'branch', 'dev');
    git(repo, 'branch', 'uat');
    const { id, serviceId } = await S.addProject(repo, 'api-seva', 'true');
    const saved = await S.post(`/services/${serviceId}/update`, { dev_branch: 'dev', uat_branch: 'uat' });
    assert.equal(saved.dev_branch, 'dev');
    assert.equal(saved.uat_branch, 'uat');
    assert.equal(saved.live_branch, null);
    assert.deepEqual(saved.branch_protection, { dev: false, uat: true, live: true });
    const listed = await S.get(`/projects/${id}/services`);
    assert.equal(listed.find((s) => s.id === serviceId).uat_branch, 'uat');
    const cleared = await S.post(`/services/${serviceId}/update`, { dev_branch: '' });
    assert.equal(cleared.dev_branch, null);
    assert.equal(cleared.uat_branch, 'uat');
    const missing = await S.post(`/services/${serviceId}/update`, { live_branch: 'no-such' }, { allowFail: true });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /no-such/);
    const still = await S.get(`/projects/${id}/services`);
    assert.equal(still.find((s) => s.id === serviceId).live_branch, null);
  });
});

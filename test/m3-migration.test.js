'use strict';
// Schema v4 migration tests: fixture copy, failure injection, idempotency, empty DB, unauthorized/missing/duplicate legacy locations, rollback drill with the OLD code.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ROOT, REAL_HOME, freePort, sleep } = require('./helpers/harness');

const FIXTURE = path.join(REAL_HOME, 'work', 'local-ai-dev', 'backups', 'pre-clean-slate-20261016-160834', 'data', 'orchestrator.db');
const BASELINE_TGZ = path.join(__dirname, 'fixtures', 'baseline-v3.tgz'); // pre-refactor (schema v3) code, used to create real v3 databases

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mig-')));
function openWithNewCode(dbPath, envExtra = {}, code = "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))") {
  const dir = path.dirname(dbPath);
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...envExtra } });
  return out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop() || '';
}
const rows = (dbPath, sql) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
/** Extract the baseline (pre-refactor) code to a temp dir: used to create real v3 databases and for the rollback drill. */
function oldCode(dir) {
  const d = path.join(dir, 'oldcode'); fs.mkdirSync(d);
  execFileSync('tar', ['-xzf', BASELINE_TGZ, '-C', d]);
  return d;
}
const oldDb = (oldDir, dbPath) => execFileSync(process.execPath, ['--no-warnings', '-e', "require('./lib/db')"], { cwd: oldDir, env: { ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(path.dirname(dbPath), 'logs') }, stdio: 'pipe' });

describe('M3 migration v3 -> v4 on a COPY of the clean-slate fixture', { skip: fs.existsSync(FIXTURE) ? false : 'fixture missing' }, () => {
  let dir, db;
  before(() => {
    dir = tmp(); db = path.join(dir, 'orchestrator.db');
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(FIXTURE + ext)) fs.copyFileSync(FIXTURE + ext, db + ext);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('migrates: counts equal, every task has a service, FK clean, schema v4, backup written', () => {
    const before = rows(db, "SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM approvals) a, (SELECT COUNT(*) FROM task_events) e, (SELECT COUNT(*) FROM cursor_usage) u, (SELECT user_version FROM pragma_user_version) v")[0];
    assert.equal(before.v, 3);
    const out = JSON.parse(openWithNewCode(db));
    assert.equal(out.v, 4);
    const after = rows(db, "SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM approvals) a, (SELECT COUNT(*) FROM task_events) e, (SELECT COUNT(*) FROM cursor_usage) u")[0];
    assert.deepEqual({ ...after }, { p: before.p, t: before.t, a: before.a, e: before.e, u: before.u });
    assert.deepEqual({ ...after }, { p: 3, t: 6, a: 8, e: 210, u: 1 });
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM tasks WHERE service_id IS NULL')[0].c, 0);
    assert.equal(rows(db, 'PRAGMA foreign_key_check').length, 0);
    assert.equal(rows(db, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
    const backups = fs.readdirSync(dir).filter((f) => /^pre-v4-migration-.*\.db$/.test(f));
    assert.equal(backups.length, 1);
    assert.equal(rows(path.join(dir, backups[0]), 'SELECT user_version v FROM pragma_user_version')[0].v, 3);
    assert.equal(rows(path.join(dir, backups[0]), 'SELECT COUNT(*) c FROM tasks')[0].c, 6);
  });
  it('back-fill: slug=name, repo-level service per project (legacy "." service reused), locations canonical, branches/checks copied', () => {
    const projects = rows(db, 'SELECT id, name, slug, description, root_dir, config FROM projects ORDER BY id');
    for (const p of projects) { assert.equal(p.slug, p.name); assert.equal(p.description, ''); assert.equal(p.root_dir, null); assert.equal(p.config, '{}'); }
    const svcs = rows(db, "SELECT id, project_id, name, path, local_path, default_branch, check_cmd, status, origin, archived FROM services ORDER BY id");
    assert.equal(svcs.length, 3);
    assert.equal(svcs[0].name, 'pulse-engage-api'); // the legacy whole-repo service is reused, no duplicate
    assert.deepEqual(svcs.map((s) => s.project_id), [1, 2, 3]);
    for (const s of svcs) {
      assert.equal(s.path, '.'); assert.equal(s.origin, 'legacy'); assert.equal(s.archived, 0);
      assert.ok(path.isAbsolute(s.local_path));
      assert.ok(!s.local_path.includes('/work/'), 'Work/work spellings normalised to the canonical on-disk case: ' + s.local_path);
      assert.equal(s.status, fs.existsSync(s.local_path) ? 'active' : 'missing');
    }
    assert.equal(svcs[1].check_cmd, 'test -f hello.txt');
    assert.equal(svcs[2].default_branch, 'master');
    const tasks = rows(db, 'SELECT id, project_id, service_id FROM tasks ORDER BY id');
    assert.deepEqual(tasks.map((t) => t.service_id), [1, 1, 1, 2, 3, 2]);
    // legacy worktree paths of old tasks are untouched
    assert.match(rows(db, 'SELECT worktree_path w FROM tasks WHERE id = 4')[0].w, /proj-demo\/task-4$/);
  });
  it('new tables, roots seeded from config only, report stored', () => {
    for (const t of ['service_deps', 'authorized_roots', 'fs_journal', 'model_roles', 'settings_kv']) assert.equal(rows(db, `SELECT COUNT(*) c FROM sqlite_master WHERE name='${t}'`)[0].c, 1, t);
    const roots = rows(db, 'SELECT path FROM authorized_roots');
    assert.equal(roots.length, 1);
    assert.equal(roots[0].path, fs.realpathSync.native(path.join(REAL_HOME, 'work')));
    const rep = JSON.parse(rows(db, "SELECT value FROM settings_kv WHERE key='migration.v4.report'")[0].value);
    assert.equal(rep.unauthorized.length, 0);
    assert.equal(rep.services_created.length, 2);
    assert.equal(rows(db, "SELECT sql FROM sqlite_master WHERE name='task_groups'")[0].sql.includes("'independent'"), true);
  });
  it('idempotent: re-opening changes nothing and writes no second backup', () => {
    const snap = JSON.stringify(rows(db, 'SELECT id, local_path, status FROM services ORDER BY id'));
    assert.equal(JSON.parse(openWithNewCode(db)).v, 4);
    assert.equal(JSON.stringify(rows(db, 'SELECT id, local_path, status FROM services ORDER BY id')), snap);
    assert.equal(fs.readdirSync(dir).filter((f) => /^pre-v4-migration/.test(f)).length, 1);
  });
});

describe('M3 migration: failure injection, empty DB, unusual legacy data, rollback drill', () => {
  let dir, old;
  before(() => { dir = tmp(); old = oldCode(dir); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('failure after back-fill rolls back completely; v3 DB untouched; backup kept', () => {
    const db = path.join(dir, 'inj.db'); oldDb(old, db);
    const w = new DatabaseSync(db);
    w.exec("INSERT INTO projects (name, path, default_branch, check_cmd) VALUES ('p1', '" + dir + "', 'main', 'true')");
    w.exec("INSERT INTO tasks (project_id, title, prompt) VALUES (1, 't', 'p')"); w.close();
    assert.throws(() => openWithNewCode(db, { ORCH_TEST_FAIL_MIGRATION_V4: '1' }), /injected failure|rolled back/);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 3);
    assert.equal(rows(db, "SELECT COUNT(*) c FROM pragma_table_info('projects') WHERE name='slug'")[0].c, 0);
    assert.equal(rows(db, "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('authorized_roots','service_deps')")[0].c, 0);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM services')[0].c, 0);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM tasks')[0].c, 1);
    assert.ok(fs.readdirSync(dir).some((f) => /^pre-v4-migration/.test(f)));
    assert.equal(JSON.parse(openWithNewCode(db)).v, 4, 'a clean retry succeeds');
  });
  it('empty v3 database (like the live DB today) migrates; brand-new database is created at v4', () => {
    const db = path.join(dir, 'empty.db'); oldDb(old, db);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 3);
    assert.equal(JSON.parse(openWithNewCode(db)).v, 4);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM projects')[0].c, 0);
    assert.ok(fs.readdirSync(dir).filter((f) => /^pre-v4-migration/.test(f)).length >= 1, 'backup is taken even when empty');
    const fresh = path.join(dir, 'fresh', 'o.db');
    fs.mkdirSync(path.dirname(fresh));
    assert.equal(JSON.parse(openWithNewCode(fresh)).v, 4);
    assert.equal(rows(fresh, 'SELECT COUNT(*) c FROM authorized_roots')[0].c, 1);
    assert.equal(fs.readdirSync(path.dirname(fresh)).filter((f) => /^pre-v4/.test(f)).length, 0, 'no backup for a brand-new DB');
  });
  it('legacy oddities: missing path, outside roots (unauthorized), duplicate location (Work/work), subfolder services share the repo', (t) => {
    const db = path.join(dir, 'odd.db'); oldDb(old, db);
    const home = fs.realpathSync.native(os.homedir());
    const insideRoot = path.join(home, 'work', 'local-ai-dev', 'scratch');           // exists, inside ~/work
    const created = fs.mkdirSync(insideRoot, { recursive: true });                    // CI machines have no ~/work: create it (and remove only what we created)
    if (created) t.after(() => fs.rmSync(created, { recursive: true, force: true }));
    const outside = fs.realpathSync(os.tmpdir());                                    // exists, outside ~/work
    const w = new DatabaseSync(db);
    const ins = w.prepare("INSERT INTO projects (name, path, default_branch, check_cmd, archived) VALUES (?,?,?,?,?)");
    ins.run('ok', insideRoot, 'main', 'true', 0);
    ins.run('gone', path.join(home, 'work', 'definitely-not-here-xyz'), 'main', 'true', 0);
    ins.run('out', outside, 'main', 'true', 0);
    ins.run('dup', insideRoot + '/./', 'main', 'true', 1);        // same dir, different spelling
    w.exec("INSERT INTO services (project_id, name, path) VALUES (1, 'api', 'api'), (1, 'web', 'web')");
    w.exec("INSERT INTO tasks (project_id, title, prompt) VALUES (1,'a','a'), (2,'b','b'), (3,'c','c'), (4,'d','d')");
    w.close();
    assert.equal(JSON.parse(openWithNewCode(db)).v, 4);
    const svc = rows(db, 'SELECT s.id, p.name pname, s.name, s.path, s.status, s.archived, s.local_path, s.origin FROM services s JOIN projects p ON p.id = s.project_id ORDER BY s.id');
    const by = (p, n) => svc.find((s) => s.pname === p && s.name === n);
    assert.equal(by('ok', 'ok').status, 'active');
    assert.equal(by('gone', 'gone').status, 'missing');
    assert.equal(by('out', 'out').status, 'unauthorized');
    assert.equal(by('dup', 'dup').archived, 1, 'duplicate location is archived, never silently shared');
    assert.equal(by('ok', 'api').local_path, by('ok', 'ok').local_path);          // subfolder services live in the same repo
    assert.equal(by('ok', 'api').path, 'api');
    const rep = JSON.parse(rows(db, "SELECT value FROM settings_kv WHERE key='migration.v4.report'")[0].value);
    assert.deepEqual([rep.unauthorized.length, rep.missing.length, rep.duplicates.length], [1, 1, 1]);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM tasks WHERE service_id IS NULL')[0].c, 0);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM authorized_roots')[0].c, 1, 'migration never widens the roots');
  });
  it('unique indexes: same (local_path, subdir) and same normalized remote are rejected for active services', () => {
    const db = path.join(dir, 'uniq.db'); oldDb(old, db); openWithNewCode(db);
    const w = new DatabaseSync(db);
    w.exec("INSERT INTO projects (name, slug, path, default_branch) VALUES ('p','p','','')");
    w.exec("INSERT INTO services (project_id, name, path, local_path, normalized_remote) VALUES (1,'a','.','/x/a','h.com/a/b')");
    assert.throws(() => w.exec("INSERT INTO services (project_id, name, path, local_path) VALUES (1,'b','.','/x/a')"), /UNIQUE/);
    assert.throws(() => w.exec("INSERT INTO services (project_id, name, path, local_path, normalized_remote) VALUES (1,'c','.','/x/c','h.com/a/b')"), /UNIQUE/);
    w.exec("INSERT INTO services (project_id, name, path, local_path) VALUES (1,'d','sub','/x/a')");        // other subdir: fine
    w.exec("UPDATE services SET archived = 1 WHERE name = 'a'");
    w.exec("INSERT INTO services (project_id, name, path, local_path) VALUES (1,'e','.','/x/a')");          // archived rows free the slot
    assert.throws(() => w.exec("INSERT INTO services (project_id, name, path, status) VALUES (1,'f','.','bogus')"), /CHECK/);
    w.close();
  });
  it('ROLLBACK DRILL: restoring the pre-v4 backup makes the OLD (baseline) code boot again', async () => {
    const dbDir = path.join(dir, 'drill'); fs.mkdirSync(dbDir);
    const db = path.join(dbDir, 'orchestrator.db'); oldDb(old, db);
    const w = new DatabaseSync(db); w.exec("INSERT INTO projects (name, path, default_branch, check_cmd) VALUES ('p1', '" + dir + "', 'main', 'true')"); w.close();
    openWithNewCode(db);                                                     // migrate (backup taken)
    const backup = path.join(dbDir, fs.readdirSync(dbDir).find((f) => /^pre-v4/.test(f)));
    // old code refuses the v4 DB (documented: code and DB are restored together)...
    const port = await freePort();
    const boot = (dbPath) => spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: old, env: { ...process.env, ORCH_PORT: String(port), ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(dbDir, 'logs'), ORCH_WORKTREES: path.join(dbDir, 'wt'), ORCH_POLL_MS: '100000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let c = boot(db); let log = ''; c.stderr.on('data', (d) => (log += d)); c.stdout.on('data', (d) => (log += d));
    await new Promise((r) => c.on('exit', r));
    assert.match(log, /newer than this orchestrator|schema v4/);
    // ...and boots fine on the restored backup
    const restored = path.join(dbDir, 'restored.db'); fs.copyFileSync(backup, restored);
    c = boot(restored); log = ''; c.stdout.on('data', (d) => (log += d)); c.stderr.on('data', (d) => (log += d));
    let health = null;
    for (let i = 0; i < 50 && !health; i++) { await sleep(150); health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null); }
    c.kill('SIGTERM');
    assert.ok(health && health.ok, log);
    assert.equal(health.schema, 3);
    assert.equal(health.projects, 1);
  });
});

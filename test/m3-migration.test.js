'use strict';
// Schema migration tests (v3 -> v4 -> v5 -> v6): fixture copy, failure injection, idempotency, empty DB, unauthorized/missing/duplicate legacy locations, rollback drill with the OLD code.
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
const BASELINE_V4_TGZ = path.join(__dirname, 'fixtures', 'baseline-v4.tgz'); // schema v4 code (commit b1bdcff, before M1), used to create real v4 databases

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mig-')));
function openWithNewCode(dbPath, envExtra = {}, code = "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))") {
  const dir = path.dirname(dbPath);
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...envExtra } });
  return out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop() || '';
}
const rows = (dbPath, sql) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
/** Extract the baseline (pre-refactor) code to a temp dir: used to create real v3 databases and for the rollback drill. */
function oldCode(dir, tgz = BASELINE_TGZ, name = 'oldcode') {
  const d = path.join(dir, name); fs.mkdirSync(d);
  execFileSync('tar', ['-xzf', tgz, '-C', d]);
  return d;
}
const oldDb = (oldDir, dbPath) => execFileSync(process.execPath, ['--no-warnings', '-e', "require('./lib/db')"], { cwd: oldDir, env: { ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(path.dirname(dbPath), 'logs'), ORCH_WORKTREES: path.join(path.dirname(dbPath), 'wt') }, stdio: 'pipe' });

describe('M3 migration v3 -> v4 (-> v5) on a COPY of the clean-slate fixture', { skip: fs.existsSync(FIXTURE) ? false : 'fixture missing' }, () => {
  let dir, db;
  before(() => {
    dir = tmp(); db = path.join(dir, 'orchestrator.db');
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(FIXTURE + ext)) fs.copyFileSync(FIXTURE + ext, db + ext);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('migrates: counts equal, every task has a service, FK clean, schema v7 (via v4, v5, v6), both backups written', () => {
    const before = rows(db, "SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM approvals) a, (SELECT COUNT(*) FROM task_events) e, (SELECT COUNT(*) FROM cursor_usage) u, (SELECT user_version FROM pragma_user_version) v")[0];
    assert.equal(before.v, 3);
    const out = JSON.parse(openWithNewCode(db));
    assert.equal(out.v, 10);
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
    const b5 = fs.readdirSync(dir).filter((f) => /^pre-v5-migration-.*\.db$/.test(f));
    assert.equal(b5.length, 1, 'v4 -> v5 takes its own backup');
    assert.equal(rows(path.join(dir, b5[0]), 'SELECT user_version v FROM pragma_user_version')[0].v, 4);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM cursor_usage WHERE task_id IN (SELECT id FROM tasks) AND project_id IS NULL')[0].c, 0, 'cursor usage of existing tasks is attributed');
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
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
    assert.equal(JSON.stringify(rows(db, 'SELECT id, local_path, status FROM services ORDER BY id')), snap);
    assert.equal(fs.readdirSync(dir).filter((f) => /^pre-v4-migration/.test(f)).length, 1);
    assert.equal(fs.readdirSync(dir).filter((f) => /^pre-v5-migration/.test(f)).length, 1);
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
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10, 'a clean retry succeeds (v3 -> v4 -> v5 -> v6 -> v7)');
  });
  it('empty v3 database migrates; brand-new database is created at v5', () => {
    const db = path.join(dir, 'empty.db'); oldDb(old, db);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 3);
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM projects')[0].c, 0);
    assert.ok(fs.readdirSync(dir).filter((f) => /^pre-v4-migration/.test(f)).length >= 1, 'backup is taken even when empty');
    const fresh = path.join(dir, 'fresh', 'o.db');
    fs.mkdirSync(path.dirname(fresh));
    const seedRoot = path.join(dir, 'seed-root'); fs.mkdirSync(seedRoot);                 // hermetic: do not depend on ~/work existing (a fresh clone on a new machine has none)
    assert.equal(JSON.parse(openWithNewCode(fresh, { ORCH_AUTHORIZED_ROOTS: seedRoot })).v, 10);
    assert.equal(rows(fresh, 'SELECT COUNT(*) c FROM authorized_roots')[0].c, 1);
    assert.equal(fs.readdirSync(path.dirname(fresh)).filter((f) => /^pre-v[45]/.test(f)).length, 0, 'no backup for a brand-new DB');
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
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
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

describe('M1 migration v4 -> v5 (usage attribution + chat/feature structures + model_roles rebuild), starting from a REAL v4 database', () => {
  let dir, old4;
  before(() => { dir = tmp(); old4 = oldCode(dir, BASELINE_V4_TGZ, 'v4code'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const TABLES = ['projects', 'services', 'tasks', 'approvals', 'task_events', 'cursor_usage', 'task_groups', 'memory_proposals', 'model_roles', 'settings_kv', 'authorized_roots'];
  const counts = (dbPath) => Object.fromEntries(rows(dbPath, TABLES.map((t) => `SELECT '${t}' t, COUNT(*) c FROM ${t}`).join(' UNION ALL ')).map((r) => [r.t, r.c]));
  /** a genuine v4 database written by the pre-M1 (v4) code, filled with history */
  function makeV4(name) {
    const db = path.join(dir, name); oldDb(old4, db);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 4);
    const w = new DatabaseSync(db);
    w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p1','p1','','',' true'), ('p2','p2','','','true')");
    w.exec("INSERT INTO services (project_id, name, path, local_path) VALUES (1,'s1','.','/x/one'), (2,'s2','.','/x/two')");
    w.exec("INSERT INTO task_groups (project_id, title, dependency) VALUES (1,'g','independent')");
    w.exec("INSERT INTO tasks (project_id, service_id, title, prompt, engine, group_id, step_no) VALUES (1,1,'a','p','cursor',1,1), (1,1,'b','p','cursor',1,2), (2,2,'c','p','local',NULL,NULL)");
    w.exec("INSERT INTO approvals (task_id, stage, decision) VALUES (1,'start','approved')");
    w.exec("INSERT INTO task_events (task_id, kind, message) VALUES (1,'system','x'), (3,'system','y')");
    w.exec("INSERT INTO cursor_usage (task_id, kind, model) VALUES (1,'plan','auto'), (1,'task','auto'), (2,'task','auto'), (2,'review','auto'), (NULL,'session','auto'), (4242,'task','auto')"); // 4242: its task was deleted long ago
    w.exec("INSERT INTO memory_proposals (project_id, task_id, service_id, text) VALUES (1,1,1,'- m')");
    w.exec("INSERT INTO model_roles (role, model, options) VALUES ('coding','ornith:9b','{\"num_ctx\":16384}'), ('memory','ornith:9b','{}')");
    w.exec("INSERT INTO settings_kv (key, value) VALUES ('k','v')");
    w.close();
    return db;
  }

  it('migrates: data preserved, usage back-filled from tasks, new structures present, FK + integrity clean, backup (v4 shape) written', () => {
    const db = makeV4('a.db'); const before = counts(db);
    const snap = (t, cols) => JSON.stringify(rows(db, `SELECT ${cols} FROM ${t} ORDER BY 1`));
    const keep = { tasks: snap('tasks', 'id, project_id, service_id, title, status, engine, group_id, step_no'), roles: snap('model_roles', 'role, model, options'), events: snap('task_events', 'id, task_id, message') };
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
    assert.deepEqual(counts(db), before, 'every row survives');
    assert.deepEqual(keep, { tasks: snap('tasks', 'id, project_id, service_id, title, status, engine, group_id, step_no'), roles: snap('model_roles', 'role, model, options'), events: snap('task_events', 'id, task_id, message') });
    // usage attribution
    assert.deepEqual(rows(db, 'SELECT task_id, kind, project_id, service_id FROM cursor_usage ORDER BY id').map((r) => [r.task_id, r.kind, r.project_id, r.service_id]),
      [[1, 'plan', 1, 1], [1, 'task', 1, 1], [2, 'task', 1, 1], [2, 'review', 1, 1], [null, 'session', null, null], [4242, 'task', null, null]]);
    // new structures
    for (const t of ['chat_conversations', 'chat_messages', 'features', 'task_artifacts']) assert.equal(rows(db, `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='${t}'`)[0].c, 1, t);
    const cols = (t) => rows(db, `SELECT name FROM pragma_table_info('${t}')`).map((r) => r.name);
    for (const c of ['feature_id', 'feature_role', 'superseded_by']) assert.ok(cols('tasks').includes(c), `tasks.${c}`);
    for (const c of ['feature_id', 'gate']) assert.ok(cols('task_groups').includes(c), `task_groups.${c}`);
    for (const c of ['project_id', 'service_id']) assert.ok(cols('cursor_usage').includes(c), `cursor_usage.${c}`);
    assert.equal(rows(db, "SELECT gate FROM task_groups WHERE id = 1")[0].gate, 'none');
    assert.equal(rows(db, 'SELECT COUNT(*) c FROM tasks WHERE feature_id IS NOT NULL OR feature_role IS NOT NULL OR superseded_by IS NOT NULL')[0].c, 0);
    assert.equal(rows(db, 'PRAGMA foreign_key_check').length, 0);
    assert.equal(rows(db, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
    // backup = the v4 database as it was
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('pre-v5-migration-') && f.endsWith('.db'));
    assert.equal(backups.length, 1);
    const b = path.join(dir, backups[0]);
    assert.equal(rows(b, 'SELECT user_version v FROM pragma_user_version')[0].v, 4);
    assert.deepEqual(counts(b), before);
    assert.equal(rows(b, "SELECT COUNT(*) c FROM pragma_table_info('cursor_usage') WHERE name='project_id'")[0].c, 0, 'backup has the old shape');
  });
  it('model_roles was rebuilt: old rows kept, chat + embedding allowed, bogus roles still rejected; new constraints hold', () => {
    const db = path.join(dir, 'a.db');
    const w = new DatabaseSync(db); w.exec('PRAGMA foreign_keys = ON');
    try {
      assert.equal(w.prepare("SELECT options FROM model_roles WHERE role='coding'").get().options, '{"num_ctx":16384}');
      w.exec("INSERT INTO model_roles (role, model) VALUES ('chat','m'), ('embedding','e')");
      assert.throws(() => w.exec("INSERT INTO model_roles (role, model) VALUES ('bogus','m')"), /CHECK/);
      assert.throws(() => w.exec("UPDATE task_groups SET gate = 'sometimes' WHERE id = 1"), /CHECK/);
      assert.throws(() => w.exec("UPDATE tasks SET feature_role = 'boss' WHERE id = 1"), /CHECK/);
      assert.throws(() => w.exec("INSERT INTO features (project_id, title, status) VALUES (1,'f','nope')"), /CHECK/);
      assert.throws(() => w.exec("INSERT INTO chat_messages (conversation_id, role) VALUES (999,'user')"), /FOREIGN KEY/);
      assert.throws(() => w.exec("INSERT INTO task_artifacts (feature_id, kind, content) VALUES (1,'api_contract','x')"), /FOREIGN KEY/);
      w.exec("INSERT INTO features (project_id, title) VALUES (1,'f')");
      w.exec("INSERT INTO task_artifacts (feature_id, kind, content) VALUES (1,'api_contract','openapi: 3')");
      w.exec("UPDATE task_groups SET feature_id = 1, gate = 'contract' WHERE id = 1"); w.exec("UPDATE tasks SET feature_id = 1, feature_role = 'provider' WHERE id = 1");
      w.exec("DELETE FROM model_roles WHERE role IN ('chat','embedding')");
      w.exec("UPDATE task_groups SET feature_id = NULL, gate = 'none' WHERE id = 1"); w.exec("UPDATE tasks SET feature_id = NULL, feature_role = NULL WHERE id = 1");
      w.exec('DELETE FROM task_artifacts; DELETE FROM features');
    } finally { w.close(); }
  });
  it('idempotent: re-opening changes nothing and writes no second v5 backup', () => {
    const db = path.join(dir, 'a.db'); const before = counts(db);
    const sql = rows(db, "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name");
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
    assert.deepEqual(counts(db), before);
    assert.deepEqual(rows(db, "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"), sql);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-v5-migration-')).length, 1);
  });
  it('failure injection: rolls back completely (still v4, old shape, old model_roles CHECK), backup kept, clean retry succeeds', () => {
    const db = makeV4('inj.db'); const before = counts(db);
    const sqlBefore = JSON.stringify(rows(db, "SELECT name, sql FROM sqlite_master ORDER BY name"));
    assert.throws(() => openWithNewCode(db, { ORCH_TEST_FAIL_MIGRATION_V5: '1' }), /injected failure|rolled back/);
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 4);
    assert.deepEqual(counts(db), before);
    assert.equal(JSON.stringify(rows(db, "SELECT name, sql FROM sqlite_master ORDER BY name")), sqlBefore, 'schema byte-identical after the rollback');
    assert.equal(rows(db, "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('chat_conversations','chat_messages','features','task_artifacts')")[0].c, 0);
    assert.equal(rows(db, "SELECT COUNT(*) c FROM pragma_table_info('cursor_usage') WHERE name IN ('project_id','service_id')")[0].c, 0);
    const w = new DatabaseSync(db);
    assert.throws(() => w.exec("INSERT INTO model_roles (role, model) VALUES ('chat','m')"), /CHECK/, 'model_roles still has the v4 CHECK');
    w.close();
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('pre-v5-migration-') && rows(path.join(dir, f), 'SELECT COUNT(*) c FROM tasks')[0].c === 3), 'a backup was written before the failed attempt');
    assert.equal(JSON.parse(openWithNewCode(db)).v, 10);
    assert.deepEqual(counts(db), before);
    assert.equal(rows(db, 'SELECT project_id FROM cursor_usage WHERE id = 1')[0].project_id, 1);
  });
  it('brand-new database is created directly at v5 with every structure and no backup', () => {
    const fresh = path.join(dir, 'fresh5', 'o.db'); fs.mkdirSync(path.dirname(fresh));
    assert.equal(JSON.parse(openWithNewCode(fresh)).v, 10);
    for (const t of ['chat_conversations', 'chat_messages', 'features', 'task_artifacts', 'model_roles']) assert.equal(rows(fresh, `SELECT COUNT(*) c FROM sqlite_master WHERE name='${t}'`)[0].c, 1, t);
    assert.match(rows(fresh, "SELECT sql FROM sqlite_master WHERE name='model_roles'")[0].sql, /'chat'.*'embedding'|'embedding'/s);
    assert.equal(rows(fresh, "SELECT COUNT(*) c FROM pragma_table_info('task_groups') WHERE name IN ('feature_id','gate')")[0].c, 2);
    assert.equal(fs.readdirSync(path.dirname(fresh)).filter((f) => /^pre-v/.test(f)).length, 0);
  });
  it('deleting a project keeps its chat history (project_id -> NULL) and removes its features/artifacts (features <-> groups reference each other)', () => {
    const db = path.join(dir, 'del.db'); fs.mkdirSync(path.dirname(db), { recursive: true });
    const out = JSON.parse(openWithNewCode(db, {}, `
      const s = require('./lib/db');
      const A = s.createProjectWithService({ name: 'doomed' }, { name: 'd', path: '.', local_path: '/x/d' }), B = s.createProjectWithService({ name: 'keeper' }, { name: 'k', path: '.', local_path: '/x/k' });
      const gid = s.createGroup({ project_id: A.projectId, title: 'g', dependency: 'independent' });
      const t1 = s.createTask({ project_id: A.projectId, service_id: A.serviceId, title: 't', prompt: 'p', files: [], engine: 'local', group_id: gid, step_no: 1 });
      const d = s.db;
      d.exec("INSERT INTO features (project_id, title, group_id) VALUES (" + A.projectId + ", 'f', " + gid + ")");
      d.exec("UPDATE task_groups SET feature_id = 1, gate = 'contract' WHERE id = " + gid); d.exec("UPDATE tasks SET feature_id = 1, feature_role = 'provider' WHERE id = " + t1);
      d.exec("INSERT INTO task_artifacts (feature_id, task_id, kind, content) VALUES (1, " + t1 + ", 'api_contract', 'x')");
      d.exec("INSERT INTO chat_conversations (title, project_id) VALUES ('c1', " + A.projectId + "), ('c2', " + B.projectId + ")");
      d.exec("INSERT INTO chat_messages (conversation_id, role, content) VALUES (1,'user','hi'), (2,'user','yo')");
      s.recordCursorUse(t1, 'task', 'auto');
      const n = s.deleteProjectRows(A.projectId);
      const c = (t) => d.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
      console.log(JSON.stringify({ n, convs: d.prepare('SELECT id, project_id FROM chat_conversations ORDER BY id').all(), msgs: c('chat_messages'), features: c('features'), artifacts: c('task_artifacts'), tasks: c('tasks'), groups: c('task_groups'), usage: c('cursor_usage'),
        fk: d.prepare('PRAGMA foreign_key_check').all().length, B: B.projectId }));`));
    assert.equal(out.fk, 0);
    assert.deepEqual(out.convs.map((c) => c.project_id), [null, out.B], 'history of the deleted project is detached, not deleted');
    assert.equal(out.msgs, 2);
    assert.deepEqual([out.features, out.artifacts, out.tasks, out.groups, out.usage], [0, 0, 0, 0, 1], 'only the Cursor usage row outlives the project');
  });
  it('ROLLBACK DRILL: v4 code refuses a newer (now v7) database; restoring the pre-v5 backup boots the v4 code again (schema 4)', async () => {
    const dbDir = path.join(dir, 'drill5'); fs.mkdirSync(dbDir);
    const db = path.join(dbDir, 'orchestrator.db'); oldDb(old4, db);
    const w = new DatabaseSync(db); w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p1','p1','','','true')"); w.close();
    openWithNewCode(db);
    const backup = path.join(dbDir, fs.readdirSync(dbDir).find((f) => f.startsWith('pre-v5-migration-')));
    const port = await freePort();
    const boot = (dbPath) => spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: old4, env: { ...process.env, ORCH_PORT: String(port), ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(dbDir, 'logs'), ORCH_WORKTREES: path.join(dbDir, 'wt'), ORCH_POLL_MS: '100000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let c = boot(db); let log = ''; c.stderr.on('data', (d) => (log += d)); c.stdout.on('data', (d) => (log += d));
    await new Promise((r) => c.on('exit', r));
    assert.match(log, /schema v10 is newer than this orchestrator \(v4\)/);
    const restored = path.join(dbDir, 'restored.db'); fs.copyFileSync(backup, restored);
    c = boot(restored); log = ''; c.stdout.on('data', (d) => (log += d)); c.stderr.on('data', (d) => (log += d));
    let health = null;
    for (let i = 0; i < 50 && !health; i++) { await sleep(150); health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null); }
    c.kill('SIGTERM');
    assert.ok(health && health.ok, log);
    assert.equal(health.schema, 4);
    assert.equal(health.projects, 1);
  });
});

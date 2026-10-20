'use strict';
// Schema v5 -> v6 (attachments + media model roles), starting from a REAL v5 database written by the commit-c0f605c code (test/fixtures/baseline-v5.tgz).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { ROOT, freePort, sleep } = require('./helpers/harness');

const V5_TGZ = path.join(__dirname, 'fixtures', 'baseline-v5.tgz');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mig6-')));
const envFor = (dbPath, extra = {}) => ({ ...process.env, ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(path.dirname(dbPath), 'logs'), ORCH_WORKTREES: path.join(path.dirname(dbPath), 'wt'), ORCH_CONTEXT_DIR: path.join(path.dirname(dbPath), 'ctx'), ...extra });
const NEW = "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))";
function openNew(dbPath, extra = {}) {
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', NEW], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: envFor(dbPath, extra) });
  return JSON.parse(out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop());
}
const rows = (dbPath, sql) => { const d = new DatabaseSync(dbPath, { readOnly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };

describe('M6 migration v5 -> v6, from a REAL v5 database', () => {
  let dir, old5;
  before(() => { dir = tmp(); old5 = path.join(dir, 'v5code'); fs.mkdirSync(old5); execFileSync('tar', ['-xzf', V5_TGZ, '-C', old5]); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const TABLES = ['projects', 'services', 'tasks', 'approvals', 'task_events', 'cursor_usage', 'task_groups', 'memory_proposals', 'model_roles', 'settings_kv', 'chat_conversations', 'chat_messages', 'features', 'task_artifacts'];
  const counts = (db) => Object.fromEntries(rows(db, TABLES.map((t) => `SELECT '${t}' t, COUNT(*) c FROM ${t}`).join(' UNION ALL ')).map((r) => [r.t, r.c]));
  function makeV5(name) {
    const db = path.join(dir, name);
    execFileSync(process.execPath, ['--no-warnings', '-e', "require('./lib/db')"], { cwd: old5, env: envFor(db), stdio: 'ignore' });
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 5);
    const w = new DatabaseSync(db); w.exec('PRAGMA foreign_keys = ON');
    w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p1','p1','','','true')");
    w.exec("INSERT INTO services (project_id, name, path, local_path) VALUES (1,'s1','.','/x/one')");
    w.exec("INSERT INTO tasks (project_id, service_id, title, prompt, engine) VALUES (1,1,'a','p','cursor'), (1,1,'b','p','local')");
    w.exec("INSERT INTO task_events (task_id, kind, message) VALUES (1,'system','x')");
    w.exec("INSERT INTO chat_conversations (title) VALUES ('c')");
    w.exec("INSERT INTO chat_messages (conversation_id, role, content) VALUES (1,'user','hi'), (1,'assistant','yo')");
    w.exec("INSERT INTO model_roles (role, model, options) VALUES ('coding','ornith:9b','{\"num_ctx\":16384}'), ('chat','ornith:9b','{}'), ('embedding','nomic-embed-text','{}')");
    w.exec("INSERT INTO settings_kv (key, value) VALUES ('k','v')");
    assert.throws(() => w.exec("INSERT INTO model_roles (role, model) VALUES ('image','m')"), /CHECK/, 'v5 does not know the media roles');
    w.close();
    return db;
  }

  it('migrates: data preserved, attachment tables + media roles present, FK + integrity clean, backup has the v5 shape', () => {
    const db = makeV5('a.db'); const before = counts(db);
    const roles = JSON.stringify(rows(db, 'SELECT role, model, options FROM model_roles ORDER BY role'));
    assert.equal(openNew(db).v, 9);
    assert.deepEqual(counts(db), before, 'every row survives');
    assert.equal(JSON.stringify(rows(db, 'SELECT role, model, options FROM model_roles ORDER BY role')), roles);
    for (const t of ['attachments', 'attachment_links', 'attachment_derivations']) assert.equal(rows(db, `SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='${t}'`)[0].c, 1, t);
    assert.equal(rows(db, 'PRAGMA foreign_key_check').length, 0);
    assert.equal(rows(db, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('pre-v6-migration-') && f.endsWith('.db'));
    assert.equal(backups.length, 1);
    const b = path.join(dir, backups[0]);
    assert.equal(rows(b, 'SELECT user_version v FROM pragma_user_version')[0].v, 5);
    assert.deepEqual(counts(b), before);
    assert.equal(rows(b, "SELECT COUNT(*) c FROM sqlite_master WHERE name='attachments'")[0].c, 0, 'the backup is the untouched v5 database');
  });

  it('constraints: media roles allowed, bogus rejected; attachments CHECKs, unique sha, cascades and FK hold', () => {
    const db = path.join(dir, 'a.db');
    const w = new DatabaseSync(db); w.exec('PRAGMA foreign_keys = ON');
    try {
      w.exec("INSERT INTO model_roles (role, model) VALUES ('image','qwen3-vl:4b'), ('video','v'), ('audio','a'), ('document','d')");
      assert.throws(() => w.exec("INSERT INTO model_roles (role, model) VALUES ('bogus','m')"), /CHECK/);
      const ins = (sha = 'a'.repeat(64), kind = 'text') => w.prepare("INSERT INTO attachments (sha256, size, kind, mime) VALUES (?,?,?,'text/plain')").run(sha, 1, kind);
      ins(); assert.throws(() => ins(), /UNIQUE/); assert.throws(() => ins('b'.repeat(64), 'exe'), /CHECK/);
      const aid = w.prepare('SELECT id FROM attachments').get().id;
      const link = (m, t) => w.prepare('INSERT INTO attachment_links (attachment_id, message_id, task_id) VALUES (?,?,?)').run(aid, m, t);
      assert.throws(() => link(null, null), /CHECK/, 'a link needs exactly one owner');
      assert.throws(() => link(1, 1), /CHECK/);
      assert.throws(() => link(999, null), /FOREIGN KEY/);
      link(1, null); assert.throws(() => link(1, null), /UNIQUE/); link(null, 1);
      assert.throws(() => w.prepare("INSERT INTO attachment_links (attachment_id, task_id, to_cloud) VALUES (?,?,2)").run(aid, 2), /CHECK/);
      w.prepare("INSERT INTO attachment_derivations (attachment_id, kind, status) VALUES (?, 'text', 'ok')").run(aid);
      assert.throws(() => w.prepare("INSERT INTO attachment_derivations (attachment_id, kind, status) VALUES (?, 'text', 'ok')").run(aid), /UNIQUE/);
      assert.throws(() => w.prepare("INSERT INTO attachment_derivations (attachment_id, kind, status) VALUES (?, 'bogus', 'ok')").run(aid), /CHECK/);
      w.exec('DELETE FROM chat_messages WHERE id = 1');
      assert.equal(w.prepare('SELECT COUNT(*) c FROM attachment_links WHERE message_id = 1').get().c, 0, 'message delete cascades to its link');
      w.exec('DELETE FROM tasks WHERE id = 1');
      assert.equal(w.prepare('SELECT COUNT(*) c FROM attachment_links').get().c, 0, 'task delete cascades to its link');
      w.exec('DELETE FROM attachments');
      assert.equal(w.prepare('SELECT COUNT(*) c FROM attachment_derivations').get().c, 0);
    } finally { w.close(); }
  });

  it('is idempotent: re-opening a v6 database changes nothing and takes no further backup', () => {
    const db = path.join(dir, 'a.db'); const before = counts(db);
    assert.equal(openNew(db).v, 9);
    assert.deepEqual(counts(db), before);
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-v6-migration-')).length, 1);
  });

  it('failure injection: a failed migration rolls back completely (still v5, no tables, roles intact) and a clean retry succeeds', () => {
    const db = makeV5('fail.db'); const before = counts(db);
    assert.throws(() => openNew(db, { ORCH_TEST_FAIL_MIGRATION_V6: '1' }), (e) => /v6 migration failed and was rolled back/.test(String(e.stderr)) && /injected failure/.test(String(e.stderr)) && /backup at/.test(String(e.stderr)));
    assert.equal(rows(db, 'SELECT user_version v FROM pragma_user_version')[0].v, 5);
    assert.equal(rows(db, "SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'attachment%' OR name='model_roles_v6'")[0].c, 0, 'no half-created tables');
    assert.deepEqual(counts(db), before);
    assert.equal(rows(db, "SELECT COUNT(*) c FROM sqlite_master WHERE name='model_roles' AND sql LIKE '%''document''%'")[0].c, 0, 'model_roles was not rebuilt');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('pre-v6-migration-')), 'the backup was written before the attempt');
    assert.equal(openNew(db).v, 9, 'clean retry');
    assert.deepEqual(counts(db), before);
  });

  it('a brand-new database is created at v7 directly, without a backup', () => {
    const fresh = path.join(dir, 'fresh', 'orchestrator.db'); fs.mkdirSync(path.dirname(fresh));
    assert.equal(openNew(fresh).v, 9);
    assert.equal(rows(fresh, "SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('attachments','attachment_links','attachment_derivations')")[0].c, 3);
    assert.equal(fs.readdirSync(path.dirname(fresh)).filter((f) => f.startsWith('pre-v')).length, 0);
  });

  it('ROLLBACK DRILL: v5 code refuses a v6 database; restoring the pre-v6 backup boots the v5 code again (schema 5)', async () => {
    const dbDir = path.join(dir, 'drill'); fs.mkdirSync(dbDir);
    const db = path.join(dbDir, 'orchestrator.db');
    execFileSync(process.execPath, ['--no-warnings', '-e', "require('./lib/db')"], { cwd: old5, env: envFor(db), stdio: 'ignore' });
    const w = new DatabaseSync(db); w.exec("INSERT INTO projects (name, slug, path, default_branch, check_cmd) VALUES ('p1','p1','','','true')"); w.close();
    openNew(db);
    const backup = path.join(dbDir, fs.readdirSync(dbDir).find((f) => f.startsWith('pre-v6-migration-')));
    const port = await freePort();
    const boot = (dbPath) => spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: old5, env: envFor(dbPath, { ORCH_PORT: String(port), ORCH_POLL_MS: '100', ORCH_OLLAMA_REGISTRY: 'http://127.0.0.1:9', OLLAMA_API_BASE: 'http://127.0.0.1:9' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let c = boot(db); let log = ''; c.stderr.on('data', (d) => (log += d)); c.stdout.on('data', (d) => (log += d));
    await new Promise((r) => c.on('exit', r));
    assert.match(log, /schema v9 is newer than this orchestrator \(v5\)/);
    const restored = path.join(dbDir, 'restored.db'); fs.copyFileSync(backup, restored);
    c = boot(restored); log = ''; c.stdout.on('data', (d) => (log += d)); c.stderr.on('data', (d) => (log += d));
    let health = null;
    for (let i = 0; i < 50 && !health; i++) { await sleep(150); health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null); }
    c.kill('SIGTERM');
    assert.ok(health && health.ok, log);
    assert.equal(health.schema, 5); assert.equal(health.projects, 1);
  });
});

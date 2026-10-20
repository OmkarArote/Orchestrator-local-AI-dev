'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite'); // built into Node >= 22.5 (no flag needed on 22.16)
const cfg = require('../config');
const fsg = require('./fsguard');

fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });
const db = new DatabaseSync(cfg.DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

const STATUSES = ['pending', 'awaiting_approval', 'approved', 'running', 'checking', 'awaiting_escalation', 'awaiting_plan', 'review', 'done', 'failed', 'rejected'];
const STATUSES_V1 = STATUSES.filter((x) => x !== 'awaiting_plan');
const ENGINES = ['local', 'cursor', 'auto'];
const SCHEMA_VERSION = 7;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const sqlList = (a) => a.map((s) => `'${s}'`).join(',');

// ---------------------------------------------------------------- schema (v1)
const PROJECTS_DDL_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,                 -- slug; also the worktree sub-directory
  path           TEXT NOT NULL,                        -- absolute path of the git repo
  default_branch TEXT NOT NULL,                        -- task branches are cut from / merged into this
  check_cmd      TEXT NOT NULL DEFAULT 'npm run build',-- project default check command
  install_cmd    TEXT,                                 -- optional; run in the worktree before the check when deps are missing
  engine         TEXT NOT NULL DEFAULT 'local' CHECK (engine IN (${sqlList(ENGINES)})),
  created_at     TEXT NOT NULL DEFAULT (${NOW}),
  archived       INTEGER NOT NULL DEFAULT 0
);`;
const tasksDdlV1 = (name) => `
CREATE TABLE ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  files            TEXT NOT NULL DEFAULT '[]',          -- JSON array of repo-relative paths (aider edits these; hint for cursor)
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN (${sqlList(STATUSES_V1)})),
  branch           TEXT,
  check_cmd        TEXT,                                -- null => project check_cmd
  head_sha         TEXT,                                -- branch tip recorded when the task reached review/failed
  created_at       TEXT NOT NULL DEFAULT (${NOW}),
  updated_at       TEXT NOT NULL DEFAULT (${NOW}),
  result_summary   TEXT,
  engine           TEXT NOT NULL DEFAULT 'local' CHECK (engine IN (${sqlList(ENGINES)})),
  model            TEXT,                                -- cursor model id (engine cursor|auto); null for local
  allow_escalation INTEGER NOT NULL DEFAULT 0,          -- engine=auto: may escalate local -> cursor (after approval)
  ai_review        INTEGER NOT NULL DEFAULT 0,          -- run the advisory cursor review after checks pass
  review_model     TEXT,
  review_summary   TEXT,                                -- advisory AI review text (never blocks merge)
  escalation       TEXT,                                -- null | pending | approved | rejected | blocked
  engine_used      TEXT,                                -- local | cursor | local+cursor (what actually ran)
  worktree_path    TEXT
);`;
const approvalsDdlV1 = (name) => `
CREATE TABLE ${name} (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts       TEXT NOT NULL DEFAULT (${NOW}),
  stage    TEXT NOT NULL CHECK (stage IN ('start','merge','escalate')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason   TEXT
);`;
const REST_DDL = `
CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts      TEXT NOT NULL DEFAULT (${NOW}),
  kind    TEXT NOT NULL,                              -- system | status | git | aider | check | cursor | review | escalation | error
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, id);
CREATE TABLE IF NOT EXISTS cursor_usage (               -- one row per Cursor CLI invocation (counted when spawned)
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (${NOW}),
  task_id INTEGER,
  kind    TEXT NOT NULL,                              -- task | review
  model   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cursor_usage_ts ON cursor_usage(ts);
`;


// ---------------------------------------------------------------- schema (v2, Stage 4)
const PROJECTS_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  path           TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  check_cmd      TEXT NOT NULL DEFAULT 'npm run build',
  install_cmd    TEXT,
  engine         TEXT NOT NULL DEFAULT 'local' CHECK (engine IN (${sqlList(ENGINES)})),
  created_at     TEXT NOT NULL DEFAULT (${NOW}),
  archived       INTEGER NOT NULL DEFAULT 0,
  settings       TEXT NOT NULL DEFAULT '{}'            -- JSON: routing policy / context / memory settings (see lib/settings.js)
);`;
const SERVICES_DDL = `
CREATE TABLE IF NOT EXISTS services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,                           -- slug, unique per project; also .ai/services/<name>.md
  path        TEXT NOT NULL,                           -- relative to the project repo root ('.' = whole repo)
  description TEXT NOT NULL DEFAULT '',
  check_cmd   TEXT,                                    -- overrides the project check for tasks in this service
  notes       TEXT NOT NULL DEFAULT '',                -- owner notes
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_services_project ON services(project_id);`;
const MEMPROP_DDL = `
CREATE TABLE IF NOT EXISTS memory_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  task_id     INTEGER REFERENCES tasks(id),
  service_id  INTEGER REFERENCES services(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  text        TEXT NOT NULL,                           -- markdown bullets proposed by the local LLM (editable until decided)
  source      TEXT NOT NULL DEFAULT 'llm',
  created_at  TEXT NOT NULL DEFAULT (${NOW}),
  decided_at  TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_memprop_project ON memory_proposals(project_id, status);`;
const tasksDdl = (name) => `
CREATE TABLE ${name} (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  title            TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  files            TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN (${sqlList(STATUSES)})),
  branch           TEXT,
  check_cmd        TEXT,
  head_sha         TEXT,
  created_at       TEXT NOT NULL DEFAULT (${NOW}),
  updated_at       TEXT NOT NULL DEFAULT (${NOW}),
  result_summary   TEXT,
  engine           TEXT NOT NULL DEFAULT 'local' CHECK (engine IN (${sqlList(ENGINES)})),
  model            TEXT,
  allow_escalation INTEGER NOT NULL DEFAULT 0,
  ai_review        INTEGER NOT NULL DEFAULT 0,
  review_model     TEXT,
  review_summary   TEXT,
  escalation       TEXT,
  engine_used      TEXT,
  worktree_path    TEXT,
  service_id       INTEGER REFERENCES services(id),     -- stage 4: optional service (working root = service path inside the worktree)
  plan_first       INTEGER NOT NULL DEFAULT 0,          -- cursor: run \`--mode plan\` first, then wait for plan approval
  plan_state       TEXT,                                -- null | pending | approved | rejected
  plan_text        TEXT,
  route_requested  INTEGER NOT NULL DEFAULT 0,          -- router was asked (service=auto and/or engine=auto-route)
  routing_state    TEXT,                                -- null | routing | done | failed
  routing_source   TEXT,                                -- llm | keyword | manual
  routing_json     TEXT,                                -- suggestion + raw model output + policy (JSON)
  model_used       TEXT,                                -- actual cursor model reported by stream-json
  context_json     TEXT                                 -- manifest of the context bundle that was given to the engine
);`;
const approvalsDdl = (name) => `
CREATE TABLE ${name} (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts       TEXT NOT NULL DEFAULT (${NOW}),
  stage    TEXT NOT NULL CHECK (stage IN ('start','merge','escalate','plan')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason   TEXT
);`;

/** v1 -> v2 (Stage 4): services, memory proposals, task routing/plan columns, project settings. Rebuilds tasks/approvals (CHECK constraints widen). History kept. */
function migrateV1toV2() {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const before = { tasks: count('tasks'), events: count('task_events'), approvals: count('approvals'), usage: count('cursor_usage'), projects: count('projects') };
  const backup = path.join(path.dirname(cfg.DB_PATH), `pre-stage4-migration-${stamp()}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`[db] migrating v1 -> v2 ${JSON.stringify(before)}; backup: ${backup}`);
  const oldTaskCols = db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name);
  const oldApprCols = db.prepare('PRAGMA table_info(approvals)').all().map((r) => r.name);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    if (!hasColumn('projects', 'settings')) db.exec("ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
    db.exec(SERVICES_DDL); // services first (tasks references it)
    db.exec(tasksDdl('tasks_v2'));
    db.exec(`INSERT INTO tasks_v2 (${oldTaskCols.join(',')}) SELECT ${oldTaskCols.join(',')} FROM tasks`);
    db.exec(approvalsDdl('approvals_v2'));
    db.exec(`INSERT INTO approvals_v2 (${oldApprCols.join(',')}) SELECT ${oldApprCols.join(',')} FROM approvals`);
    db.exec('DROP TABLE approvals; DROP TABLE tasks;');
    db.exec('ALTER TABLE tasks_v2 RENAME TO tasks; ALTER TABLE approvals_v2 RENAME TO approvals;');
    db.exec(REST_DDL);
    db.exec(MEMPROP_DDL);
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = { tasks: count('tasks'), events: count('task_events'), approvals: count('approvals'), usage: count('cursor_usage'), projects: count('projects') };
    for (const k of Object.keys(before)) if (before[k] !== after[k]) throw new Error(`${k} count changed during migration (${before[k]} -> ${after[k]})`);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    console.log(`[db] migration v1 -> v2 OK ${JSON.stringify(after)}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`stage-4 migration failed and was rolled back (backup at ${backup}): ${e.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------- schema v3 (supervised tasks, multi-service sequences)
const GROUPS_DDL = `
CREATE TABLE IF NOT EXISTS task_groups (               -- a multi-service sequence: ordered steps (tasks.group_id / tasks.step_no)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  dependency TEXT NOT NULL DEFAULT 'stack' CHECK (dependency IN ('stack','merged')), -- stack: next step is cut from the previous step's branch once it passed checks; merged: wait until the previous step is merged
  created_at TEXT NOT NULL DEFAULT (${NOW})
);`;
function migrateV2toV3() {
  const n = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  if (n > 0) {
    const backup = path.join(path.dirname(cfg.DB_PATH), `pre-v3-migration-${stamp()}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[db] migrating v2 -> v3 (${n} tasks); backup: ${backup}`);
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [col, ddl] of [['supervised', 'INTEGER NOT NULL DEFAULT 0'], ['group_id', 'INTEGER REFERENCES task_groups(id)'], ['step_no', 'INTEGER'], ['base_ref', 'TEXT']]) {
      if (!hasColumn('tasks', col)) { if (col === 'group_id') db.exec(GROUPS_DDL); db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`); }
    }
    db.exec(GROUPS_DDL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id, step_no)');
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(bad)}`);
    if (db.prepare('SELECT COUNT(*) c FROM tasks').get().c !== n) throw new Error('task count changed');
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    throw new Error(`v3 migration failed and was rolled back: ${e.message}`);
  }
}

const tableExists = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
const userVersion = () => db.prepare('PRAGMA user_version').get().user_version;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** v0 (single-repo schema, no migrations) -> v1 (projects, engines, escalation). History is preserved. */
function migrateV0toV1() {
  const nTasks = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  const backup = path.join(path.dirname(cfg.DB_PATH), `pre-projects-migration-${stamp()}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); // consistent, WAL-safe snapshot before touching anything
  console.log(`[db] migrating v0 -> v1 (${nTasks} tasks); backup: ${backup}`);

  // tasks/approvals need a rebuild (CHECK constraints change). foreign_keys must be OFF or dropping `tasks` would
  // cascade-delete task_events. The PRAGMA is a no-op inside a transaction, so set it first.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(PROJECTS_DDL_V1);
    let pid = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get()?.id;
    if (!pid) {
      pid = Number(db.prepare('INSERT INTO projects (name, path, default_branch, check_cmd, engine) VALUES (?,?,?,?,?)')
        .run(path.basename(cfg.REPO), cfg.REPO, cfg.BASE_BRANCH, cfg.DEFAULT_CHECK, 'local').lastInsertRowid);
    }
    db.exec(tasksDdlV1('tasks_v1'));
    db.exec(`INSERT INTO tasks_v1 (id, project_id, title, prompt, files, status, branch, check_cmd, head_sha, created_at, updated_at, result_summary, engine, engine_used, worktree_path)
             SELECT id, ${pid}, title, prompt, files, status, branch, check_cmd, head_sha, created_at, updated_at, result_summary, 'local', CASE WHEN branch IS NOT NULL THEN 'local' END,
                    CASE WHEN branch IS NOT NULL THEN '${cfg.WORKTREES.replace(/'/g, "''")}/task-' || id END
             FROM tasks`);
    db.exec(approvalsDdlV1('approvals_v1'));
    db.exec('INSERT INTO approvals_v1 (id, task_id, ts, stage, decision, reason) SELECT id, task_id, ts, stage, decision, reason FROM approvals');
    db.exec('DROP TABLE approvals; DROP TABLE tasks;');
    db.exec('ALTER TABLE tasks_v1 RENAME TO tasks; ALTER TABLE approvals_v1 RENAME TO approvals;');
    db.exec(REST_DDL);
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
    if (after !== nTasks) throw new Error(`task count changed during migration (${nTasks} -> ${after})`);
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`migration failed and was rolled back (backup at ${backup}): ${e.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}


// ---------------------------------------------------------------- schema v4 (EXPAND: logical projects, independent services, roots, journal, model roles)
const GROUPS_DDL_V4 = (name) => `
CREATE TABLE ${name} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  dependency TEXT NOT NULL DEFAULT 'stack' CHECK (dependency IN ('stack','merged','independent')), -- independent: no ordering/stacking (steps may live in different repos)
  created_at TEXT NOT NULL DEFAULT (${NOW})
);`;
const V4_NEW_TABLES = `
CREATE TABLE IF NOT EXISTS service_deps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  depends_on_service_id INTEGER REFERENCES services(id),
  external TEXT,
  note TEXT NOT NULL DEFAULT '',
  CHECK ((depends_on_service_id IS NOT NULL) <> (external IS NOT NULL)),
  CHECK (depends_on_service_id IS NULL OR depends_on_service_id <> service_id));
CREATE INDEX IF NOT EXISTS idx_service_deps_project ON service_deps(project_id);
CREATE TABLE IF NOT EXISTS authorized_roots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS fs_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('clone_staging','new_service','context_trash')),
  path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','committed','cleaned')),
  created_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS model_roles (
  role TEXT PRIMARY KEY CHECK (role IN ('coding','planning','requirements','review','debugging','documentation','routing','memory')),
  model TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE TABLE IF NOT EXISTS settings_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/**
 * v3 -> v4. Additive (ADD COLUMN + new tables + back-fill) plus a rebuild of the small task_groups table (CHECK widened).
 * Backup-first (VACUUM INTO) unless the DB is brand new; one transaction; verifies counts, FK check, every task has a service.
 * Never widens the authorized roots: legacy locations outside the roots are marked status='unauthorized' and listed in settings_kv 'migration.v4.report'.
 */
function migrateV3toV4({ fresh = false } = {}) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const before = { projects: count('projects'), tasks: count('tasks'), events: count('task_events'), approvals: count('approvals'), usage: count('cursor_usage'), groups: count('task_groups'), proposals: count('memory_proposals') };
  let backup = null;
  if (!fresh) {
    backup = path.join(path.dirname(cfg.DB_PATH), `pre-v4-migration-${stamp()}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[db] migrating v3 -> v4 ${JSON.stringify(before)}; backup: ${backup}`);
  }
  const report = { at: new Date().toISOString(), backup, roots: [], roots_skipped: [], services_created: [], unauthorized: [], missing: [], duplicates: [], projects: before.projects };
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    const addCol = (t, c, ddl) => { if (!hasColumn(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
    addCol('projects', 'slug', 'TEXT');
    addCol('projects', 'description', "TEXT NOT NULL DEFAULT ''");
    addCol('projects', 'root_dir', 'TEXT');
    addCol('projects', 'config', "TEXT NOT NULL DEFAULT '{}'");
    db.exec('UPDATE projects SET slug = name WHERE slug IS NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)');
    addCol('services', 'local_path', 'TEXT');
    addCol('services', 'remote_url', 'TEXT');
    addCol('services', 'normalized_remote', 'TEXT');
    addCol('services', 'default_branch', 'TEXT');
    addCol('services', 'type', "TEXT NOT NULL DEFAULT 'other'");
    addCol('services', 'stack', "TEXT NOT NULL DEFAULT ''");
    addCol('services', 'build_cmd', 'TEXT');
    addCol('services', 'test_cmd', 'TEXT');
    addCol('services', 'install_cmd', 'TEXT');
    addCol('services', 'git_config', "TEXT NOT NULL DEFAULT '{}'");
    addCol('services', 'env_config', "TEXT NOT NULL DEFAULT '{}'");
    addCol('services', 'status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing','unauthorized','archived'))");
    addCol('services', 'origin', "TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import','create','existing','legacy'))");
    db.exec(V4_NEW_TABLES);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_services_location ON services(local_path, path) WHERE archived = 0 AND local_path IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_services_remote ON services(normalized_remote) WHERE archived = 0 AND normalized_remote IS NOT NULL');
    // task_groups: widen CHECK (rebuild small table)
    db.exec(GROUPS_DDL_V4('task_groups_v4'));
    db.exec('INSERT INTO task_groups_v4 (id, project_id, title, dependency, created_at) SELECT id, project_id, title, dependency, created_at FROM task_groups');
    db.exec('DROP TABLE task_groups; ALTER TABLE task_groups_v4 RENAME TO task_groups;');

    // authorized roots seeded from config (explicit, never widened by the migration)
    const guard = fsg.createGuard({ home: cfg.HOME, ownDirs: cfg.ownDirs() });
    for (const r of cfg.AUTHORIZED_ROOTS) {
      try { const v = guard.validateRoot(r, 'authorized root'); db.prepare('INSERT OR IGNORE INTO authorized_roots (path, label) VALUES (?,?)').run(v.path, 'default (ORCH_AUTHORIZED_ROOTS)'); report.roots.push({ path: v.path, warnings: v.warnings }); }
      catch (e) { report.roots_skipped.push({ path: r, reason: e.message }); }
    }
    const roots = db.prepare('SELECT path FROM authorized_roots').all().map((x) => x.path);
    const authorized = (p) => roots.some((r) => fsg.inside(p, r));

    // back-fill: every legacy project gets a repo-level service; legacy subfolder services keep (local_path, subdir)
    const upd = db.prepare('UPDATE services SET local_path = ?, default_branch = ?, install_cmd = COALESCE(install_cmd, ?), status = ?, origin = ?, archived = ? WHERE id = ?');
    const taken = (lp, sp, exceptId) => db.prepare('SELECT id FROM services WHERE local_path = ? AND path = ? AND archived = 0 AND id <> ?').get(lp, sp, exceptId ?? -1);
    for (const P of db.prepare('SELECT * FROM projects ORDER BY id').all()) {
      const exists = !!P.path && fs.existsSync(P.path);
      const lp = (exists && fsg.real(P.path)) || path.resolve(P.path || '.');
      const baseStatus = !exists ? 'missing' : !authorized(lp) ? 'unauthorized' : 'active';
      if (baseStatus === 'missing') report.missing.push({ project: P.name, path: P.path });
      if (baseStatus === 'unauthorized') report.unauthorized.push({ project: P.name, path: lp });
      const legacy = db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY id').all(P.id);
      const place = (s) => {
        let archived = s.archived;
        if (!archived && taken(lp, s.path, s.id)) { archived = 1; report.duplicates.push({ project: P.name, service: s.name, local_path: lp, subdir: s.path }); }
        upd.run(lp, P.default_branch, P.install_cmd, archived ? 'archived' : baseStatus, 'legacy', archived, s.id);
      };
      let s0 = legacy.find((s) => s.path === '.' && !s.archived) || null;
      for (const s of legacy) place(s);
      if (!s0) {
        let name = P.name;
        if (legacy.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${P.name}-repo`;
        let archived = 0;
        if (taken(lp, '.', null)) { archived = 1; report.duplicates.push({ project: P.name, service: name, local_path: lp, subdir: '.' }); }
        const id = Number(db.prepare(`INSERT INTO services (project_id, name, path, description, check_cmd, local_path, default_branch, install_cmd, status, origin, archived)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(P.id, name, '.', 'Whole repository (migrated from the legacy single-repo project)', P.check_cmd, lp, P.default_branch, P.install_cmd, archived ? 'archived' : baseStatus, 'legacy', archived).lastInsertRowid);
        s0 = { id, name };
        report.services_created.push({ project: P.name, service: name, id, local_path: lp });
      }
      db.prepare('UPDATE tasks SET service_id = ? WHERE project_id = ? AND service_id IS NULL').run(s0.id, P.id);
    }
    db.prepare('INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?,?)').run('migration.v4.report', JSON.stringify(report));
    if (process.env.ORCH_TEST_FAIL_MIGRATION_V4 === '1') throw new Error('injected failure (ORCH_TEST_FAIL_MIGRATION_V4)'); // failure-injection hook for the migration tests

    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = { projects: count('projects'), tasks: count('tasks'), events: count('task_events'), approvals: count('approvals'), usage: count('cursor_usage'), groups: count('task_groups'), proposals: count('memory_proposals') };
    for (const k of Object.keys(before)) if (before[k] !== after[k]) throw new Error(`${k} count changed during migration (${before[k]} -> ${after[k]})`);
    const orphan = db.prepare('SELECT COUNT(*) c FROM tasks WHERE service_id IS NULL').get().c;
    if (orphan) throw new Error(`${orphan} task(s) have no service after back-fill`);
    const noLoc = db.prepare('SELECT COUNT(*) c FROM services WHERE archived = 0 AND local_path IS NULL').get().c;
    if (noLoc) throw new Error(`${noLoc} active service(s) have no local_path after back-fill`);
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');
    if (!fresh) console.log(`[db] migration v3 -> v4 OK ${JSON.stringify(after)}; created ${report.services_created.length} repo-level service(s); unauthorized=${report.unauthorized.length} missing=${report.missing.length}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`v4 migration failed and was rolled back${backup ? ` (backup at ${backup})` : ''}: ${e.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------- schema v5 (Cursor usage attribution + structures for chat / features; created once so we migrate once)
const MODEL_ROLES_V5 = ['coding', 'planning', 'requirements', 'review', 'debugging', 'documentation', 'routing', 'memory', 'chat', 'embedding'];
const MODEL_ROLES_V6 = [...MODEL_ROLES_V5, 'image', 'video', 'audio', 'document'];
const modelRolesDdl = (name, roles = MODEL_ROLES_V5) => `
CREATE TABLE ${name} (
  role TEXT PRIMARY KEY CHECK (role IN (${sqlList(roles)})),   -- chat/embedding are reserved by the schema; lib/models.js lists a role only once it has a consumer
  model TEXT NOT NULL, options TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (${NOW}));`;
const V5_NEW_TABLES = `
CREATE TABLE IF NOT EXISTS chat_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id),             -- NULL = not tied to a project (also set to NULL when the project is deleted: history is kept)
  model      TEXT,
  options    TEXT NOT NULL DEFAULT '{}',                  -- JSON: num_ctx, temperature, ...
  mentions   TEXT NOT NULL DEFAULT '[]',                  -- JSON: sticky @mentions
  think      INTEGER NOT NULL DEFAULT 0,
  summary    TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE INDEX IF NOT EXISTS idx_chat_conv_project ON chat_conversations(project_id, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id   INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content           TEXT NOT NULL DEFAULT '',
  mentions          TEXT NOT NULL DEFAULT '[]',
  context_json      TEXT,                                 -- manifest of the retrieved context only (never replayed into history)
  model             TEXT,
  num_ctx           INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER,
  status            TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','aborted','error')),
  created_at        TEXT NOT NULL DEFAULT (${NOW}));
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS features (                    -- thin parent over a task_group (cross-repo feature, contract-first)
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title      TEXT NOT NULL,
  brief      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planned','contract_pending','running','contract_drift','review','done','failed','cancelled')),
  group_id   INTEGER REFERENCES task_groups(id),
  plan_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at TEXT NOT NULL DEFAULT (${NOW}));
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id, id);
CREATE TABLE IF NOT EXISTS task_artifacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id  INTEGER NOT NULL REFERENCES features(id),
  task_id     INTEGER REFERENCES tasks(id),
  kind        TEXT NOT NULL CHECK (kind IN ('api_contract','api_actual','notes')),
  version     INTEGER NOT NULL DEFAULT 1,
  content     TEXT NOT NULL,
  sha256      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','superseded')),
  source      TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','llm','extracted')),
  created_at  TEXT NOT NULL DEFAULT (${NOW}),
  approved_at TEXT);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_feature ON task_artifacts(feature_id, kind, version);`;

/**
 * v4 -> v5. Additive (ADD COLUMN + new tables + back-fill) plus a rebuild of the tiny model_roles table (CHECK widened by 'chat','embedding').
 * Backup-first (VACUUM INTO) unless the DB is brand new; one transaction; foreign_keys OFF around the rebuild; verifies row counts + FK check.
 * M1 uses only cursor_usage.project_id/service_id; the chat / feature structures are created now so the schema is migrated once.
 */
function migrateV4toV5({ fresh = false } = {}) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const TABLES = ['projects', 'tasks', 'task_events', 'approvals', 'cursor_usage', 'task_groups', 'memory_proposals', 'services', 'model_roles', 'settings_kv'];
  const snap = () => Object.fromEntries(TABLES.map((t) => [t, count(t)]));
  const before = snap();
  let backup = null;
  if (!fresh) {
    backup = path.join(path.dirname(cfg.DB_PATH), `pre-v5-migration-${stamp()}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[db] migrating v4 -> v5 ${JSON.stringify(before)}; backup: ${backup}`);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    const addCol = (t, c, ddl) => { if (!hasColumn(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
    // 1. Cursor usage attribution (rows of deleted projects/tasks stay NULL = "unattributed", still counted in totals)
    addCol('cursor_usage', 'project_id', 'INTEGER');
    addCol('cursor_usage', 'service_id', 'INTEGER');
    db.exec(`UPDATE cursor_usage SET project_id = (SELECT t.project_id FROM tasks t WHERE t.id = cursor_usage.task_id),
                                     service_id = (SELECT t.service_id FROM tasks t WHERE t.id = cursor_usage.task_id)
             WHERE task_id IS NOT NULL AND project_id IS NULL`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cursor_usage_project ON cursor_usage(project_id, ts)');
    // 2. new tables first (tasks / task_groups columns reference features)
    db.exec(V5_NEW_TABLES);
    // 3. additive columns for features / sequences (no rebuild of tasks or task_groups)
    addCol('tasks', 'feature_id', 'INTEGER REFERENCES features(id)');
    addCol('tasks', 'feature_role', "TEXT CHECK (feature_role IS NULL OR feature_role IN ('provider','consumer'))");
    addCol('tasks', 'superseded_by', 'INTEGER REFERENCES tasks(id)');
    addCol('task_groups', 'feature_id', 'INTEGER REFERENCES features(id)');
    addCol('task_groups', 'gate', "TEXT NOT NULL DEFAULT 'none' CHECK (gate IN ('none','contract'))");
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feature ON tasks(feature_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_groups_feature ON task_groups(feature_id)');
    // 4. model_roles rebuild (CHECK widened). Skipped when already rebuilt.
    const mrSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_roles'").get();
    if (!mrSql || !mrSql.sql.includes("'embedding'")) {
      db.exec(modelRolesDdl('model_roles_v5'));
      db.exec('INSERT INTO model_roles_v5 (role, model, options, updated_at) SELECT role, model, options, updated_at FROM model_roles');
      db.exec('DROP TABLE model_roles; ALTER TABLE model_roles_v5 RENAME TO model_roles;');
    }
    if (process.env.ORCH_TEST_FAIL_MIGRATION_V5 === '1') throw new Error('injected failure (ORCH_TEST_FAIL_MIGRATION_V5)'); // failure-injection hook for the migration tests
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = snap();
    for (const k of Object.keys(before)) if (before[k] !== after[k]) throw new Error(`${k} count changed during migration (${before[k]} -> ${after[k]})`);
    const unattributed = db.prepare('SELECT COUNT(*) c FROM cursor_usage u WHERE u.project_id IS NULL AND u.task_id IN (SELECT id FROM tasks)').get().c;
    if (unattributed) throw new Error(`${unattributed} cursor_usage row(s) of existing tasks were not attributed`);
    db.exec('PRAGMA user_version = 5');
    db.exec('COMMIT');
    if (!fresh) console.log(`[db] migration v4 -> v5 OK ${JSON.stringify(after)}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`v5 migration failed and was rolled back${backup ? ` (backup at ${backup})` : ''}: ${e.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------- schema v6 (attachments: uploaded media/documents, their links to chat messages / tasks, derived text)
const ATTACH_KINDS = ['image', 'document', 'data', 'text', 'audio', 'video'];
const V6_NEW_TABLES = `
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256       TEXT NOT NULL UNIQUE,                    -- content address: the blob lives in the attachments dir under <sha[0:2]>/<sha>; identical uploads dedupe to one row
  size         INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (${sqlList(ATTACH_KINDS)})),
  mime         TEXT NOT NULL,                           -- decided by magic-byte sniffing, never taken from the client
  ext          TEXT NOT NULL DEFAULT '',                -- sniffed type label (png, pdf, docx, ...)
  orig_name    TEXT NOT NULL DEFAULT '',                -- sanitised display name only; never used as a path
  meta         TEXT NOT NULL DEFAULT '{}',              -- JSON: width/height, zip entry count, flags (has_exif, has_macros, ...)
  created_at   TEXT NOT NULL DEFAULT (${NOW}),
  last_used_at TEXT);
CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);
CREATE TABLE IF NOT EXISTS attachment_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  message_id    INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  to_cloud      INTEGER NOT NULL DEFAULT 0 CHECK (to_cloud IN (0,1)),   -- explicit per-use tick: may this attachment's derived text go to a cloud / Cursor engine? default no
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  CHECK ((message_id IS NULL) <> (task_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_att_links_att ON attachment_links(attachment_id);
CREATE INDEX IF NOT EXISTS idx_att_links_msg ON attachment_links(message_id);
CREATE INDEX IF NOT EXISTS idx_att_links_task ON attachment_links(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_att_links_msg ON attachment_links(attachment_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_att_links_task ON attachment_links(attachment_id, task_id) WHERE task_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS attachment_derivations (       -- text derived from a blob (the ONLY thing a model ever sees)
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('text','ocr','caption','transcript','summary')),
  tool          TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  params        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('ok','unsupported','failed')),
  content       TEXT NOT NULL DEFAULT '',
  chars         INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE (attachment_id, kind, tool, model, params));
CREATE INDEX IF NOT EXISTS idx_att_deriv_att ON attachment_derivations(attachment_id);`;

/**
 * v5 -> v6. Additive: three attachment tables + a rebuild of the tiny model_roles table (CHECK widened by image/video/audio/document).
 * Backup-first (VACUUM INTO) unless the DB is brand new; one transaction; foreign_keys OFF around the rebuild; verifies row counts + FK check.
 */
function migrateV5toV6({ fresh = false } = {}) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const TABLES = ['projects', 'tasks', 'task_events', 'approvals', 'cursor_usage', 'task_groups', 'memory_proposals', 'services', 'model_roles', 'settings_kv', 'chat_conversations', 'chat_messages', 'features', 'task_artifacts'];
  const snap = () => Object.fromEntries(TABLES.map((t) => [t, count(t)]));
  const before = snap();
  let backup = null;
  if (!fresh) {
    backup = path.join(path.dirname(cfg.DB_PATH), `pre-v6-migration-${stamp()}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[db] migrating v5 -> v6 ${JSON.stringify(before)}; backup: ${backup}`);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(V6_NEW_TABLES);
    const mrSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_roles'").get();
    if (!mrSql || !mrSql.sql.includes("'document'")) {
      db.exec(modelRolesDdl('model_roles_v6', MODEL_ROLES_V6));
      db.exec('INSERT INTO model_roles_v6 (role, model, options, updated_at) SELECT role, model, options, updated_at FROM model_roles');
      db.exec('DROP TABLE model_roles; ALTER TABLE model_roles_v6 RENAME TO model_roles;');
    }
    if (process.env.ORCH_TEST_FAIL_MIGRATION_V6 === '1') throw new Error('injected failure (ORCH_TEST_FAIL_MIGRATION_V6)'); // failure-injection hook for the migration tests
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = snap();
    for (const k of Object.keys(before)) if (before[k] !== after[k]) throw new Error(`${k} count changed during migration (${before[k]} -> ${after[k]})`);
    db.exec('PRAGMA user_version = 6');
    db.exec('COMMIT');
    if (!fresh) console.log(`[db] migration v5 -> v6 OK ${JSON.stringify(after)}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`v6 migration failed and was rolled back${backup ? ` (backup at ${backup})` : ''}: ${e.message}`);
  }
  db.exec('PRAGMA foreign_keys = ON');
}

/**
 * v6 -> v7. Additive columns only: optional per-service dev/uat/live branches, plus the flow stamp and iteration counter.
 * Existing rows stay flow='v1' and iteration=1. Backup-first unless the DB is brand new. ORCH_TEST_FAIL_MIGRATION_V7=1 rolls the transaction back.
 */
function migrateV6toV7({ fresh = false } = {}) {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const TABLES = ['projects', 'tasks', 'task_events', 'approvals', 'cursor_usage', 'task_groups', 'memory_proposals', 'services', 'model_roles', 'settings_kv', 'chat_conversations', 'chat_messages', 'features', 'task_artifacts', 'attachments', 'attachment_links', 'attachment_derivations'];
  const snap = () => Object.fromEntries(TABLES.filter((t) => tableExists(t)).map((t) => [t, count(t)]));
  const before = snap();
  let backup = null;
  if (!fresh) {
    backup = path.join(path.dirname(cfg.DB_PATH), `pre-v7-migration-${stamp()}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`[db] migrating v6 -> v7 ${JSON.stringify(before)}; backup: ${backup}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasColumn('services', 'dev_branch')) db.exec('ALTER TABLE services ADD COLUMN dev_branch TEXT');
    if (!hasColumn('services', 'uat_branch')) db.exec('ALTER TABLE services ADD COLUMN uat_branch TEXT');
    if (!hasColumn('services', 'live_branch')) db.exec('ALTER TABLE services ADD COLUMN live_branch TEXT');
    if (!hasColumn('tasks', 'flow')) db.exec("ALTER TABLE tasks ADD COLUMN flow TEXT NOT NULL DEFAULT 'v1'");
    if (!hasColumn('tasks', 'iteration')) db.exec('ALTER TABLE tasks ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1');
    if (process.env.ORCH_TEST_FAIL_MIGRATION_V7 === '1') throw new Error('injected failure (ORCH_TEST_FAIL_MIGRATION_V7)');
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`foreign_key_check failed after migration: ${JSON.stringify(bad)}`);
    const after = snap();
    for (const k of Object.keys(before)) if (before[k] !== after[k]) throw new Error(`${k} count changed during migration (${before[k]} -> ${after[k]})`);
    db.exec('PRAGMA user_version = 7');
    db.exec('COMMIT');
    if (!fresh) console.log(`[db] migration v6 -> v7 OK ${JSON.stringify(after)}`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* not in txn */ }
    throw new Error(`v7 migration failed and was rolled back${backup ? ` (backup at ${backup})` : ''}: ${e.message}`);
  }
}

function initSchema() {
  const v = userVersion();
  if (!tableExists('tasks')) { // brand-new database: create v2 directly
    db.exec(PROJECTS_DDL); db.exec(SERVICES_DDL);
    db.exec(tasksDdl('tasks')); db.exec(approvalsDdl('approvals')); db.exec(REST_DDL);
    db.exec(MEMPROP_DDL);
    if (cfg.REPO_IS_EXPLICIT) {
      db.prepare('INSERT INTO projects (name, path, default_branch, check_cmd, engine) VALUES (?,?,?,?,?)')
        .run(path.basename(cfg.REPO), cfg.REPO, cfg.BASE_BRANCH, cfg.DEFAULT_CHECK, 'local');
    }
    db.exec('PRAGMA user_version = 2');
    migrateV2toV3(); // fresh database: add the v3 columns/tables (no history to protect)
    migrateV3toV4({ fresh: true });
    migrateV4toV5({ fresh: true });
    migrateV5toV6({ fresh: true });
    migrateV6toV7({ fresh: true });
    return;
  }
  if (v > SCHEMA_VERSION) throw new Error(`database schema v${v} is newer than this orchestrator (v${SCHEMA_VERSION})`);
  if (v < 1 || !hasColumn('tasks', 'project_id')) migrateV0toV1();
  if (userVersion() < 2 || !hasColumn('tasks', 'service_id')) migrateV1toV2();
  if (userVersion() < 3 || !hasColumn('tasks', 'supervised')) migrateV2toV3();
  if (userVersion() < 4 || !hasColumn('projects', 'slug')) migrateV3toV4();
  if (userVersion() < 5 || !hasColumn('cursor_usage', 'project_id')) migrateV4toV5();
  if (userVersion() < 6 || !tableExists('attachments')) migrateV5toV6();
  if (userVersion() < 7 || !hasColumn('services', 'dev_branch')) migrateV6toV7();
}
initSchema();

const hydrateAtt = (r) => (r ? { ...r, meta: (() => { try { return JSON.parse(r.meta || '{}'); } catch { return {}; } })() } : null);

// ---------------------------------------------------------------- queries
const q = {
  insertTask: db.prepare(`INSERT INTO tasks (project_id, title, prompt, files, check_cmd, engine, model, allow_escalation, ai_review, review_model, service_id, plan_first, route_requested, routing_state, routing_source, group_id, step_no, feature_id, feature_role)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  getTask: db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.id = ?'),
  listTasks: db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id ORDER BY t.id DESC LIMIT 300'),
  listTasksByProject: db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.project_id = ? ORDER BY t.id DESC LIMIT 300'),
  nextApproved: db.prepare("SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.status = 'approved' ORDER BY t.id ASC LIMIT 1"),
  transition: db.prepare(`UPDATE tasks SET status = ?, updated_at = ${NOW} WHERE id = ? AND status = ?`),
  insertEvent: db.prepare('INSERT INTO task_events (task_id, kind, message) VALUES (?,?,?)'),
  eventsAfter: db.prepare('SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?'),
  insertApproval: db.prepare('INSERT INTO approvals (task_id, stage, decision, reason) VALUES (?,?,?,?)'),
  approvals: db.prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY id'),
  inFlight: db.prepare("SELECT id, status FROM tasks WHERE status IN ('running','checking')"),
  activeInProject: db.prepare("SELECT id, status FROM tasks WHERE project_id = ? AND status IN ('approved','running','checking','awaiting_escalation','awaiting_plan')"),
  insertProject: db.prepare('INSERT INTO projects (name, slug, description, root_dir, config, path, default_branch, check_cmd, install_cmd, engine, settings) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
  listProjects: db.prepare('SELECT * FROM projects ORDER BY archived ASC, name COLLATE NOCASE ASC'),
  insertUsage: db.prepare('INSERT INTO cursor_usage (task_id, kind, model, project_id, service_id) VALUES (?,?,?,(SELECT project_id FROM tasks WHERE id = ?),(SELECT service_id FROM tasks WHERE id = ?))'),
  approvedAll: db.prepare("SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.status = 'approved' ORDER BY t.id ASC"),
  insertGroup: db.prepare('INSERT INTO task_groups (project_id, title, dependency, feature_id, gate) VALUES (?,?,?,?,?)'),
  getGroup: db.prepare('SELECT * FROM task_groups WHERE id = ?'),
  listGroups: db.prepare('SELECT * FROM task_groups WHERE (? IS NULL OR project_id = ?) ORDER BY id DESC LIMIT 100'),
  groupTasks: db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.group_id = ? AND t.superseded_by IS NULL ORDER BY t.step_no ASC'),
  groupTasksAll: db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.group_id = ? ORDER BY t.step_no ASC, t.id ASC'),
  insertFeature: db.prepare('INSERT INTO features (project_id, title, brief, status, plan_json) VALUES (?,?,?,?,?)'),
  getFeature: db.prepare('SELECT * FROM features WHERE id = ?'),
  listFeatures: db.prepare('SELECT * FROM features ORDER BY id DESC LIMIT 200'),
  insertArtifact: db.prepare('INSERT INTO task_artifacts (feature_id, task_id, kind, version, content, sha256, status, source) VALUES (?,?,?,?,?,?,?,?)'),
  getArtifact: db.prepare('SELECT * FROM task_artifacts WHERE id = ?'),
  listArtifacts: db.prepare('SELECT * FROM task_artifacts WHERE feature_id = ? ORDER BY id ASC'),
  runningTasks: db.prepare("SELECT t.id, t.project_id, t.service_id, t.engine FROM tasks t WHERE t.status IN ('running','checking')"),
  insertService: db.prepare(`INSERT INTO services (project_id, name, path, description, check_cmd, notes, local_path, remote_url, normalized_remote, default_branch, type, stack, build_cmd, test_cmd, install_cmd, git_config, env_config, status, origin)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  getService: db.prepare('SELECT * FROM services WHERE id = ?'),
  listServices: db.prepare('SELECT * FROM services WHERE project_id = ? ORDER BY archived ASC, name COLLATE NOCASE ASC'),
  insertProposal: db.prepare('INSERT INTO memory_proposals (project_id, task_id, service_id, text, source) VALUES (?,?,?,?,?)'),
  getProposal: db.prepare('SELECT m.*, t.title AS task_title, sv.name AS service_name FROM memory_proposals m LEFT JOIN tasks t ON t.id = m.task_id LEFT JOIN services sv ON sv.id = m.service_id WHERE m.id = ?'),
  listProposals: db.prepare('SELECT m.*, t.title AS task_title, sv.name AS service_name FROM memory_proposals m LEFT JOIN tasks t ON t.id = m.task_id LEFT JOIN services sv ON sv.id = m.service_id WHERE (? IS NULL OR m.project_id = ?) AND (? IS NULL OR m.status = ?) ORDER BY m.id DESC LIMIT 200'),
  proposalsForTask: db.prepare('SELECT * FROM memory_proposals WHERE task_id = ? ORDER BY id'),
  decideProposal: db.prepare(`UPDATE memory_proposals SET status = ?, decided_at = ${NOW}, decision_note = ? WHERE id = ? AND status = 'pending'`),
};

const parseJson = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
/** Shown status. Stored status stays inside the CHECK list (no schema change): split / blocked / cancelled are routing_state (or a cancel summary). */
function displayStatus(t) {
  if (t.routing_state === 'blocked') return 'blocked';
  if (t.routing_state === 'cancelled') return 'cancelled';
  if (t.status === 'failed' && /cancelled by user/.test(t.result_summary || '')) return 'cancelled';
  if (t.status === 'failed' && t.routing_state === 'split') return 'split';
  return t.status;
}
const hydrate = (t) => (t ? { ...t, files: require('./file-list').cleanFileList(JSON.parse(t.files || '[]')), allow_escalation: !!t.allow_escalation, ai_review: !!t.ai_review,
  supervised: !!t.supervised, plan_first: !!t.plan_first, route_requested: !!t.route_requested, routing: parseJson(t.routing_json, null), context: parseJson(t.context_json, null),
  display_status: displayStatus(t) } : null);
// `path` / `default_branch` are LEGACY columns (expand/contract): never exposed to application code. The repo of a project lives on its services.
const hydrateProject = (p) => { if (!p) return null; const { path: _legacyPath, default_branch: _legacyBranch, ...rest } = p; return { ...rest, archived: !!p.archived, settings: parseJson(p.settings, {}), config: parseJson(p.config, {}) }; };
const hydrateConv = (c) => (c ? { ...c, options: parseJson(c.options, {}), mentions: parseJson(c.mentions, []), think: !!c.think, archived: !!c.archived } : null);
const hydrateMsg = (m) => ({ ...m, mentions: parseJson(m.mentions, []), context: parseJson(m.context_json, null) });
const hydrateService = (s) => (s ? { ...s, archived: !!s.archived, subdir: s.path, git_config: parseJson(s.git_config, {}), env_config: parseJson(s.env_config, {}) } : null);

const TASK_FIELDS = ['branch', 'head_sha', 'result_summary', 'check_cmd', 'review_summary', 'escalation', 'engine_used', 'worktree_path',
  'service_id', 'engine', 'model', 'allow_escalation', 'plan_first', 'plan_state', 'plan_text', 'route_requested', 'routing_state', 'routing_source', 'routing_json', 'model_used', 'context_json', 'ai_review', 'review_model', 'title', 'supervised', 'group_id', 'step_no', 'base_ref', 'feature_id', 'feature_role', 'superseded_by', 'flow', 'iteration'];
function updateFields(id, fields) {
  const keys = Object.keys(fields).filter((k) => TASK_FIELDS.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`)
    .run(...keys.map((k) => (fields[k] === true ? 1 : fields[k] === false ? 0 : fields[k] === undefined ? null : fields[k])), id);
}

const PROJECT_FIELDS = ['name', 'description', 'root_dir', 'config', 'check_cmd', 'install_cmd', 'engine', 'archived', 'settings'];
function updateProject(id, fields) {
  const keys = Object.keys(fields).filter((k) => PROJECT_FIELDS.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

/** Start of the LOCAL calendar day containing `now`, as an ISO (UTC) string ("today" in the Cursor counters resets at local midnight). */
function localDayStartIso(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
const localDayEndIso = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

const emptyBucket = () => ({ tasks: 0, task_runs: 0, plans: 0, reviews: 0, sessions: 0, runs: 0 });
const bucketOf = (r) => (r ? { tasks: r.tasks || 0, task_runs: r.task_runs || 0, plans: r.plans || 0, reviews: r.reviews || 0, sessions: r.sessions || 0,
  runs: (r.task_runs || 0) + (r.plans || 0) + (r.reviews || 0) } : emptyBucket());
// "tasks" = DISTINCT tasks with >=1 task|plan run (a plan-then-implement task counts once; its two runs show in task_runs/plans).
// reviews and interactive sessions are listed separately; `runs` = headless CLI invocations (task + plan + review).
const USAGE_AGG = `COUNT(DISTINCT CASE WHEN kind IN ('task','plan') THEN COALESCE(task_id, -id) END) tasks,
  SUM(kind = 'task') task_runs, SUM(kind = 'plan') plans, SUM(kind = 'review') reviews, SUM(kind = 'session') sessions`;

/**
 * Cursor usage counters (no cap, nothing here blocks anything). `now` selects the local calendar day that counts as "today"
 * and bounds the totals (rows after that day are ignored) so the day boundary is unit-testable.
 * Returns { today, total, by_project:[{project_id, name, deleted, today, total}], day_start, since }.
 */
function cursorStats({ now = new Date() } = {}) {
  const from = localDayStartIso(now), to = localDayEndIso(now);
  const one = (sql, ...a) => bucketOf(db.prepare(`SELECT ${USAGE_AGG} FROM cursor_usage WHERE ${sql}`).get(...a));
  const per = (sql, ...a) => new Map(db.prepare(`SELECT project_id, ${USAGE_AGG} FROM cursor_usage WHERE ${sql} GROUP BY project_id`).all(...a).map((r) => [r.project_id, bucketOf(r)]));
  const today = one('ts >= ? AND ts < ?', from, to), total = one('ts < ?', to);
  const todayBy = per('ts >= ? AND ts < ?', from, to), totalBy = per('ts < ?', to);
  const by_project = [...totalBy.entries()].map(([pid, t]) => {
    const p = pid == null ? null : q.getProject.get(pid);
    return { project_id: pid, name: p ? p.name : null, deleted: pid == null || !p, today: todayBy.get(pid) || emptyBucket(), total: t };
  }).sort((a, b) => b.total.runs - a.total.runs || (a.project_id ?? 0) - (b.project_id ?? 0));
  const since = db.prepare('SELECT MIN(ts) ts FROM cursor_usage').get().ts || null;
  return { today, total, by_project, day_start: from, since };
}
/** Back-compat view (old /api/health.cursor_usage shape): used = task+plan runs today, tasks = task-kind runs today, plans, reviews, sessions + today/total buckets. */
function cursorUsageToday({ now = new Date() } = {}) {
  const s = cursorStats({ now });
  return { used: s.today.task_runs + s.today.plans, tasks: s.today.task_runs, plans: s.today.plans, reviews: s.today.reviews, sessions: s.today.sessions,
    day_start: s.day_start, today: s.today, total: s.total };
}

module.exports = {
  db, STATUSES, ENGINES,
  createTask: (t) => {
    const id = Number(q.insertTask.run(
      t.project_id, t.title, t.prompt, JSON.stringify(t.files), t.check_cmd || null, t.engine, t.model || null,
      t.allow_escalation ? 1 : 0, t.ai_review ? 1 : 0, t.review_model || null,
      t.service_id || null, t.plan_first ? 1 : 0, t.route_requested ? 1 : 0, t.route_requested ? 'routing' : null, t.route_requested ? null : (t.routing_source || null), t.group_id || null, t.step_no || null, t.feature_id || null, t.feature_role || null).lastInsertRowid);
    updateFields(id, { flow: t.flow || cfg.FLOW });
    return id;
  },
  getTask: (id) => hydrate(q.getTask.get(id)),
  listTasks: (projectId) => (projectId ? q.listTasksByProject.all(projectId) : q.listTasks.all()).map(hydrate),
  nextApproved: () => hydrate(q.nextApproved.get()),
  // atomic compare-and-set status change; returns true if it happened
  transition(id, from, to, fields) {
    const ok = q.transition.run(to, id, from).changes === 1;
    if (ok) {
      if (fields) updateFields(id, fields);
      q.insertEvent.run(id, 'status', `${from} -> ${to}`);
    }
    return ok;
  },
  updateFields,
  addEvent(id, kind, message) {
    try { q.insertEvent.run(id, kind, String(message).slice(0, cfg.MAX_LINE)); } catch { /* never let logging crash the runner */ }
  },
  eventsAfter: (id, after = 0, limit = 500) => q.eventsAfter.all(id, after, limit),
  addApproval: (id, stage, decision, reason) => q.insertApproval.run(id, stage, decision, reason || null),
  approvals: (id) => q.approvals.all(id),
  /** True only after approve-merge. An approve that skips the default branch is status done with no merge approval. */
  mergedToDefault: (task) => !!(task && task.status === 'done' && q.approvals.all(task.id).some((a) => a.stage === 'merge' && a.decision === 'approved')),
  inFlight: () => q.inFlight.all(),
  activeTasksInProject: (pid) => q.activeInProject.all(pid),
  // projects
  approvedAll: () => q.approvedAll.all().map(hydrate),
  createGroup: (g) => Number(q.insertGroup.run(g.project_id, g.title, g.dependency, g.feature_id || null, g.gate || 'none').lastInsertRowid),
  // ---- features (cross-repo, contract-first): a thin parent over a task_group; contracts/actuals/notes live in task_artifacts
  createFeature: (f) => Number(q.insertFeature.run(f.project_id, f.title, f.brief || '', f.status || 'draft', JSON.stringify(f.plan || {})).lastInsertRowid),
  getFeature: (id) => { const r = q.getFeature.get(id); return r ? { ...r, plan: (() => { try { return JSON.parse(r.plan_json || '{}'); } catch { return {}; } })() } : null; },
  listFeatures: () => q.listFeatures.all().map((r) => ({ ...r, plan: (() => { try { return JSON.parse(r.plan_json || '{}'); } catch { return {}; } })() })),
  updateFeature(id, f) {
    const sets = [], vals = [];
    for (const k of ['title', 'brief', 'status', 'group_id']) if (f[k] !== undefined) { sets.push(`${k} = ?`); vals.push(f[k]); }
    if (f.plan !== undefined) { sets.push('plan_json = ?'); vals.push(JSON.stringify(f.plan)); }
    if (!sets.length) return;
    db.prepare(`UPDATE features SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ?`).run(...vals, id);
  },
  linkGroupToFeature: (gid, fid) => db.prepare('UPDATE task_groups SET feature_id = ? WHERE id = ?').run(fid, gid),
  addArtifact: (a) => Number(q.insertArtifact.run(a.feature_id, a.task_id || null, a.kind, a.version || 1, a.content, a.sha256 || '', a.status || 'proposed', a.source || 'human').lastInsertRowid),
  getArtifact: (id) => q.getArtifact.get(id) || null,
  listArtifacts: (fid, kind) => q.listArtifacts.all(fid).filter((a) => !kind || a.kind === kind),
  setArtifactStatus: (id, status) => db.prepare(`UPDATE task_artifacts SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ${NOW} ELSE approved_at END WHERE id = ?`).run(status, status, id),
  groupTasksAll: (gid) => q.groupTasksAll.all(gid).map(hydrate),
  featureTasks: (fid) => db.prepare('SELECT t.*, p.name AS project_name, sv.name AS service_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN services sv ON sv.id = t.service_id WHERE t.feature_id = ? ORDER BY t.step_no ASC, t.id ASC').all(fid).map(hydrate),
  /** Features owned by a project whose steps in OTHER projects are not finished: they block deleting the owner project. */
  openForeignStepsOfOwnedFeatures: (pid) => db.prepare("SELECT t.id, t.status, t.feature_id FROM tasks t JOIN features f ON f.id = t.feature_id WHERE f.project_id = ? AND t.project_id <> ? AND t.status NOT IN ('done','rejected','failed') ORDER BY t.id").all(pid, pid),
  getGroup: (id) => q.getGroup.get(id) || null,
  listGroups: (pid) => q.listGroups.all(pid || null, pid || null),
  groupTasks: (gid) => q.groupTasks.all(gid).map(hydrate),
  // services
  createService: (s) => Number(q.insertService.run(s.project_id, s.name, s.path || '.', s.description || '', s.check_cmd || null, s.notes || '', s.local_path || null, s.remote_url || null,
    s.normalized_remote || null, s.default_branch || null, s.type || 'other', s.stack || '', s.build_cmd || null, s.test_cmd || null, s.install_cmd || null,
    JSON.stringify(s.git_config || {}), JSON.stringify(s.env_config || {}), s.status || 'active', s.origin || 'import').lastInsertRowid),
  /** all services of all projects (optionally only non-archived) - used for duplicate/location checks and protect lists */
  allServices: ({ includeArchived = true } = {}) => db.prepare('SELECT * FROM services').all().map(hydrateService).filter((x) => includeArchived || !x.archived),
  findServiceByLocation: (local_path, subdir = '.') => hydrateService(db.prepare('SELECT * FROM services WHERE local_path = ? AND path = ? AND archived = 0').get(local_path, subdir)),
  findServiceByRemote: (norm) => hydrateService(db.prepare('SELECT * FROM services WHERE normalized_remote = ? AND archived = 0').get(norm)),
  // service deps
  addDep: (d) => Number(db.prepare('INSERT INTO service_deps (project_id, service_id, depends_on_service_id, external, note) VALUES (?,?,?,?,?)').run(d.project_id, d.service_id, d.depends_on_service_id || null, d.external || null, d.note || '').lastInsertRowid),
  listDeps: (pid) => db.prepare('SELECT * FROM service_deps WHERE project_id = ? ORDER BY id').all(pid),
  removeDep: (pid, id) => db.prepare('DELETE FROM service_deps WHERE id = ? AND project_id = ?').run(id, pid).changes === 1,
  // authorized roots + fs journal + kv + model roles
  listRoots: () => db.prepare('SELECT * FROM authorized_roots ORDER BY id').all(),
  addRoot: (p, label = '') => Number(db.prepare('INSERT INTO authorized_roots (path, label) VALUES (?,?)').run(p, label).lastInsertRowid),
  removeRoot: (id) => db.prepare('DELETE FROM authorized_roots WHERE id = ?').run(id).changes === 1,
  journalAdd: (kind, p) => Number(db.prepare('INSERT INTO fs_journal (kind, path) VALUES (?,?)').run(kind, p).lastInsertRowid),
  journalSet: (id, state) => db.prepare('UPDATE fs_journal SET state = ? WHERE id = ?').run(state, id),
  journalOpen: () => db.prepare("SELECT * FROM fs_journal WHERE state = 'open' ORDER BY id").all(),
  journalHas: (p) => !!db.prepare("SELECT 1 FROM fs_journal WHERE path = ? AND state IN ('open','committed') LIMIT 1").get(p),
  journalOpenHas: (p) => !!db.prepare("SELECT 1 FROM fs_journal WHERE path = ? AND state = 'open' LIMIT 1").get(p),
  kvGet: (k, d = null) => { const r = db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(k); return r ? r.value : d; },
  kvSet: (k, v) => db.prepare('INSERT OR REPLACE INTO settings_kv (key, value) VALUES (?,?)').run(k, String(v)),
  kvDel: (k) => db.prepare('DELETE FROM settings_kv WHERE key = ?').run(k),
  listModelRoles: () => db.prepare('SELECT * FROM model_roles ORDER BY role').all().map((r) => ({ ...r, options: parseJson(r.options, {}) })),
  setModelRole: (role, model, options) => db.prepare(`INSERT INTO model_roles (role, model, options, updated_at) VALUES (?,?,?,${NOW}) ON CONFLICT(role) DO UPDATE SET model = excluded.model, options = excluded.options, updated_at = excluded.updated_at`).run(role, model, JSON.stringify(options || {})),
  clearModelRole: (role) => db.prepare('DELETE FROM model_roles WHERE role = ?').run(role).changes === 1,
  getService: (id) => hydrateService(q.getService.get(id)),
  listServices: (pid, { includeArchived = false } = {}) => q.listServices.all(pid).map(hydrateService).filter((x) => includeArchived || !x.archived),
  updateService(id, f) {
    const keys = Object.keys(f).filter((k) => ['name', 'path', 'description', 'check_cmd', 'notes', 'archived', 'local_path', 'remote_url', 'normalized_remote', 'default_branch', 'dev_branch', 'uat_branch', 'live_branch', 'type', 'stack', 'build_cmd', 'test_cmd', 'install_cmd', 'git_config', 'env_config', 'status', 'origin'].includes(k));
    if (!keys.length) return;
    const val = (k) => (k === 'archived' ? (f[k] ? 1 : 0) : (k === 'git_config' || k === 'env_config') && typeof f[k] === 'object' ? JSON.stringify(f[k]) : f[k]);
    db.prepare(`UPDATE services SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(val), id);
  },
  // memory proposals
  createProposal: (p) => Number(q.insertProposal.run(p.project_id, p.task_id || null, p.service_id || null, p.text, p.source || 'llm').lastInsertRowid),
  getProposal: (id) => q.getProposal.get(id) || null,
  listProposals: ({ projectId = null, status = null } = {}) => q.listProposals.all(projectId, projectId, status, status),
  proposalsForTask: (tid) => q.proposalsForTask.all(tid),
  setProposalText: (id, text) => db.prepare("UPDATE memory_proposals SET text = ? WHERE id = ? AND status = 'pending'").run(text, id).changes === 1,
  setProposalTextForce: (id, text) => db.prepare('UPDATE memory_proposals SET text = ? WHERE id = ?').run(text, id),
  decideProposal: (id, status, note) => q.decideProposal.run(status, note || null, id).changes === 1,
  /** Logical project. `path`/`default_branch` are LEGACY NOT NULL columns kept empty ('' = unused; nothing may read them, see grep guard). */
  createProject: (p) => Number(q.insertProject.run(p.name, p.slug || p.name, p.description || '', p.root_dir || null, JSON.stringify(p.config || {}), p.path || '', p.default_branch || '',
    p.check_cmd || cfg.DEFAULT_CHECK, p.install_cmd || null, p.engine || 'local', JSON.stringify(p.settings || {})).lastInsertRowid),
  /** Project + its first service atomically (legacy add/create flows). Returns { projectId, serviceId }. */
  createProjectWithService(p, sv) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const projectId = Number(q.insertProject.run(p.name, p.slug || p.name, p.description || '', p.root_dir || null, JSON.stringify(p.config || {}), '', '',
        p.check_cmd || cfg.DEFAULT_CHECK, p.install_cmd || null, p.engine || 'local', JSON.stringify(p.settings || {})).lastInsertRowid);
      const serviceId = module.exports.createService({ ...sv, project_id: projectId });
      db.exec('COMMIT');
      return { projectId, serviceId };
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
  },
  /** Tasks that are not finished (anything but done/rejected/failed): they block project deletion. */
  openTasksInProject: (pid) => db.prepare("SELECT id, status, title FROM tasks WHERE project_id = ? AND status NOT IN ('done','rejected','failed') ORDER BY id").all(pid),
  slugTaken: (slug) => !!db.prepare('SELECT 1 FROM projects WHERE slug = ? COLLATE NOCASE').get(slug),
  /** Delete a project's DB rows (tasks + events/approvals via cascade, proposals, groups, deps, services, project). Files are NEVER touched.
   *  cursor_usage rows are deliberately kept (they keep feeding the Cursor counters; project_id stays so by_project shows them as deleted). Chat history is kept (project_id -> NULL). Returns row counts. */
  deleteProjectRows(id) {
    const n = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = (k, sql) => { n[k] = Number(db.prepare(sql).run(...Array((sql.match(/\?/g) || []).length).fill(id)).changes); };
      del('proposals', 'DELETE FROM memory_proposals WHERE project_id = ?');
      del('chat_detached', 'UPDATE chat_conversations SET project_id = NULL WHERE project_id = ?');
      // features owned by this project may have steps in OTHER projects: those tasks keep their history but leave the feature/sequence
      del('foreign_steps_detached', 'UPDATE tasks SET feature_id = NULL, feature_role = NULL, group_id = NULL, step_no = NULL WHERE project_id <> ? AND (feature_id IN (SELECT id FROM features WHERE project_id = ?) OR group_id IN (SELECT id FROM task_groups WHERE project_id = ?))');
      del('groups_unlinked', 'UPDATE task_groups SET feature_id = NULL WHERE project_id = ?'); // features <-> groups reference each other
      del('features_unlinked', 'UPDATE features SET group_id = NULL WHERE project_id = ?');
      del('artifacts', 'DELETE FROM task_artifacts WHERE feature_id IN (SELECT id FROM features WHERE project_id = ?)');
      del('artifacts_of_tasks', 'DELETE FROM task_artifacts WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)');
      del('tasks_unlinked', 'UPDATE tasks SET superseded_by = NULL WHERE superseded_by IN (SELECT id FROM tasks WHERE project_id = ?)');
      del('tasks', 'DELETE FROM tasks WHERE project_id = ?');
      del('features', 'DELETE FROM features WHERE project_id = ?');
      del('groups', 'DELETE FROM task_groups WHERE project_id = ?');
      del('deps', 'DELETE FROM service_deps WHERE project_id = ?');
      del('services', 'DELETE FROM services WHERE project_id = ?');
      del('projects', 'DELETE FROM projects WHERE id = ?');
      db.exec('COMMIT');
      return n;
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
  },
  /** Unregister a service row (no files). Fails on FK when tasks reference it (callers check first). */
  deleteServiceRow(id) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM service_deps WHERE service_id = ? OR depends_on_service_id = ?').run(id, id);
      db.prepare('UPDATE memory_proposals SET service_id = NULL WHERE service_id = ?').run(id);
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none */ } throw e; }
  },
  listAllProjects: () => q.listProjects.all().map(hydrateProject),
  getProject: (id) => hydrateProject(q.getProject.get(id)),
  listProjects: ({ includeArchived = false } = {}) => q.listProjects.all().map(hydrateProject).filter((p) => includeArchived || !p.archived),
  updateProject: (id, fields) => updateProject(id, { ...fields, ...(fields.archived !== undefined ? { archived: fields.archived ? 1 : 0 } : {}), ...(fields.settings !== undefined ? { settings: JSON.stringify(fields.settings) } : {}), ...(fields.config !== undefined ? { config: JSON.stringify(fields.config) } : {}) }),
  // ---- dashboard chat (tables created by schema v5)
  chatCreateConversation: (c) => Number(db.prepare('INSERT INTO chat_conversations (title, project_id, model, options, mentions, think) VALUES (?,?,?,?,?,?)')
    .run(c.title || '', c.project_id || null, c.model || null, JSON.stringify(c.options || {}), JSON.stringify(c.mentions || []), c.think ? 1 : 0).lastInsertRowid),
  chatGetConversation: (id) => hydrateConv(db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id)),
  chatListConversations: ({ projectId = null, includeArchived = false } = {}) => db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count FROM chat_conversations c
     WHERE (? IS NULL OR c.project_id = ?) AND (? = 1 OR c.archived = 0) ORDER BY c.updated_at DESC, c.id DESC LIMIT 200`).all(projectId, projectId, includeArchived ? 1 : 0).map(hydrateConv),
  chatUpdateConversation(id, f) {
    const keys = Object.keys(f).filter((k) => ['title', 'project_id', 'model', 'options', 'mentions', 'think', 'summary', 'archived'].includes(k));
    if (!keys.length) return;
    const val = (k) => (k === 'options' || k === 'mentions' ? JSON.stringify(f[k]) : k === 'think' || k === 'archived' ? (f[k] ? 1 : 0) : f[k]);
    db.prepare(`UPDATE chat_conversations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`).run(...keys.map(val), id);
  },
  chatTouch: (id) => db.prepare(`UPDATE chat_conversations SET updated_at = ${NOW} WHERE id = ?`).run(id),
  chatDeleteConversation: (id) => db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id).changes === 1, // messages go with it (ON DELETE CASCADE)
  chatAddMessage: (m) => Number(db.prepare('INSERT INTO chat_messages (conversation_id, role, content, mentions, context_json, model, num_ctx, status) VALUES (?,?,?,?,?,?,?,?)')
    .run(m.conversation_id, m.role, m.content || '', JSON.stringify(m.mentions || []), m.context ? JSON.stringify(m.context) : null, m.model || null, m.num_ctx ?? null, m.status || 'complete').lastInsertRowid),
  chatUpdateMessage(id, f) {
    const keys = Object.keys(f).filter((k) => ['content', 'context_json', 'model', 'num_ctx', 'prompt_tokens', 'completion_tokens', 'duration_ms', 'status'].includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE chat_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (k === 'context_json' && f[k] && typeof f[k] === 'object' ? JSON.stringify(f[k]) : f[k] ?? null)), id);
  },
  chatMessages: (cid) => db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id').all(cid).map(hydrateMsg),
  /** Crash recovery at boot: assistant rows still 'streaming' belong to a dead process. Returns how many were marked 'error'. */
  chatMarkStale() {
    const stale = db.prepare("SELECT id, context_json FROM chat_messages WHERE status = 'streaming'").all();
    for (const r of stale) {
      const c = parseJson(r.context_json, null) || {};
      db.prepare("UPDATE chat_messages SET status = 'error', context_json = ? WHERE id = ?").run(JSON.stringify({ ...c, error: { code: 'interrupted', message: 'the orchestrator restarted while this answer was streaming' } }), r.id);
    }
    return stale.length;
  },
  /** Running/checking tasks that use the local engine (aider shares the GPU with chat). */
  localTasksRunning: () => db.prepare("SELECT id, title, engine FROM tasks WHERE status IN ('running','checking') AND engine <> 'cursor'").all(),
  // cursor usage counters (no cap)
  recordCursorUse: (taskId, kind, model) => q.insertUsage.run(taskId, kind, model || null, taskId, taskId),
  cursorStats,
  cursorUsageToday,
  // ---- attachments (M6). Rows only; the blobs are managed by lib/attachments.js
  attInsert: (a) => Number(db.prepare('INSERT INTO attachments (sha256, size, kind, mime, ext, orig_name, meta) VALUES (?,?,?,?,?,?,?)').run(a.sha256, a.size, a.kind, a.mime, a.ext || '', a.orig_name || '', JSON.stringify(a.meta || {})).lastInsertRowid),
  attGet: (id) => hydrateAtt(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id)),
  attBySha: (sha) => hydrateAtt(db.prepare('SELECT * FROM attachments WHERE sha256 = ?').get(sha)),
  attList: (limit = 100) => db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM attachment_links l WHERE l.attachment_id = a.id) AS link_count FROM attachments a ORDER BY a.id DESC LIMIT ?`).all(Math.min(500, Math.max(1, limit | 0))).map(hydrateAtt),
  attTotals: () => db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM attachments').get(),
  attAll: () => db.prepare('SELECT id, sha256, size FROM attachments').all(),
  attDelete: (id) => db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes,
  attTouch: (id) => db.prepare(`UPDATE attachments SET last_used_at = ${NOW} WHERE id = ?`).run(id),
  attUnreferenced: (olderThanIso) => db.prepare('SELECT * FROM attachments a WHERE a.created_at < ? AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id)').all(olderThanIso).map(hydrateAtt),
  attOlderThan: (iso) => db.prepare('SELECT * FROM attachments WHERE created_at < ?').all(iso).map(hydrateAtt),
  attLinksOf: (attId) => db.prepare('SELECT * FROM attachment_links WHERE attachment_id = ? ORDER BY id').all(attId),
  attLinksForMessage: (mid) => db.prepare('SELECT l.*, a.kind, a.mime, a.orig_name, a.size FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id WHERE l.message_id = ? ORDER BY l.id').all(mid),
  attLinksForTask: (tid) => db.prepare('SELECT l.*, a.kind, a.mime, a.orig_name, a.size FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id WHERE l.task_id = ? ORDER BY l.id').all(tid),
  attLinkAdd: (attId, { messageId = null, taskId = null, toCloud = false }) => {
    db.prepare('INSERT OR IGNORE INTO attachment_links (attachment_id, message_id, task_id, to_cloud) VALUES (?,?,?,?)').run(attId, messageId, taskId, toCloud ? 1 : 0);
    return db.prepare('SELECT * FROM attachment_links WHERE attachment_id = ? AND message_id IS ? AND task_id IS ?').get(attId, messageId, taskId);
  },
  attLinkSetCloud: (linkId, on) => db.prepare('UPDATE attachment_links SET to_cloud = ? WHERE id = ?').run(on ? 1 : 0, linkId).changes,
  attLinkRemove: (linkId) => db.prepare('DELETE FROM attachment_links WHERE id = ?').run(linkId).changes,
  attLinkCount: ({ messageId = null, taskId = null }) => db.prepare('SELECT COUNT(*) c FROM attachment_links WHERE message_id IS ? AND task_id IS ?').get(messageId, taskId).c,
  attDerivUpsert: (d) => {
    db.prepare(`INSERT INTO attachment_derivations (attachment_id, kind, tool, model, params, status, content, chars, truncated, error) VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (attachment_id, kind, tool, model, params) DO UPDATE SET status = excluded.status, content = excluded.content, chars = excluded.chars, truncated = excluded.truncated, error = excluded.error, created_at = ${NOW}`)
      .run(d.attachment_id, d.kind, d.tool || '', d.model || '', d.params || '', d.status, d.content || '', (d.content || '').length, d.truncated ? 1 : 0, d.error || null);
    return db.prepare('SELECT * FROM attachment_derivations WHERE attachment_id = ? AND kind = ? AND tool = ? AND model = ? AND params = ?').get(d.attachment_id, d.kind, d.tool || '', d.model || '', d.params || '');
  },
  attDerivList: (attId, withContent = false) => db.prepare(`SELECT id, attachment_id, kind, tool, model, params, status, ${withContent ? 'content,' : ''} chars, truncated, error, created_at FROM attachment_derivations WHERE attachment_id = ? ORDER BY id`).all(attId),
  schemaVersion: userVersion,
};

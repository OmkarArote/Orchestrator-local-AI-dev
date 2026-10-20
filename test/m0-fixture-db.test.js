'use strict';
// Regression baseline for the schema/migration: a COPY of the clean-slate backup DB (3 projects, 1 service, 6 tasks, 8 approvals, 210 events).
// Opens it through lib/db.js in a child process (so config comes from env); the original is never touched. No server, no runner, no repo access.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, REAL_HOME } = require('./helpers/harness');

const FIXTURE = path.join(REAL_HOME, 'work', 'local-ai-dev', 'backups', 'pre-clean-slate-20261016-160834', 'data', 'orchestrator.db');
const HAVE = fs.existsSync(FIXTURE);

describe('M0 fixture DB (copy of the clean-slate backup)', { skip: HAVE ? false : 'fixture backup not present' }, () => {
  let dir, dbCopy;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fx-'));
    dbCopy = path.join(dir, 'orchestrator.db');
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(FIXTURE + ext)) fs.copyFileSync(FIXTURE + ext, dbCopy + ext);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // the migration logs '[db] ...' lines on stdout; the probe's JSON is the last line
  const lastLine = (o) => o.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop();
  const probe = (code) => lastLine(execFileSync(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCH_DB: dbCopy, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt') } }));

  it('opens (migrating to the current schema if needed), keeps all rows, FK check clean', () => {
    const out = JSON.parse(probe(`
      const s = require('./lib/db'); const c = (t) => s.db.prepare('SELECT COUNT(*) c FROM '+t).get().c;
      console.log(JSON.stringify({ v: s.schemaVersion(), projects: c('projects'), services: c('services'), tasks: c('tasks'), approvals: c('approvals'), events: c('task_events'), usage: c('cursor_usage'),
        fk: s.db.prepare('PRAGMA foreign_key_check').all().length, groups: c('task_groups') }));`));
    assert.equal(out.v, 7, "fixture (v3) is migrated to the current schema");
    assert.deepEqual({ projects: out.projects, tasks: out.tasks, approvals: out.approvals, events: out.events, usage: out.usage, fk: out.fk }, { projects: 3, tasks: 6, approvals: 8, events: 210, usage: 1, fk: 0 });
    assert.ok(out.services >= 1);
  });

  it('task rows are readable through the store API with their stored worktree paths', () => {
    const out = JSON.parse(probe(`const s = require('./lib/db'); console.log(JSON.stringify(s.listTasks().map(t => ({id: t.id, st: t.status, wt: t.worktree_path, br: t.branch}))));`));
    assert.equal(out.length, 6);
    assert.equal(out.find((t) => t.id === 4).wt.endsWith('/proj-demo/task-4'), true);
  });
});

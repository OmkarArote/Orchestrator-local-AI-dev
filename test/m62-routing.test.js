'use strict';
// Cost router: cache key, stable prefix, route movement, schema v11.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { compose, prefixOf } = require('../lib/routing/prefix');
const { choose } = require('../lib/routing/decide');
const { hash } = require('../lib/routing/cache');
const roles = require('../lib/flow/roles');

const ROOT = path.join(__dirname, '..');

describe('cost router', () => {
  it('keeps the prefix order when the task changes', () => {
    const a = compose({ rules: 'rules', architecture: 'arch', brief: 'api', variable: 'task one' });
    const b = compose({ rules: 'rules', architecture: 'arch', brief: 'api', variable: 'task two is longer' });
    assert.equal(prefixOf(a), prefixOf(b));
    assert.ok(a.indexOf('SYSTEM RULES') < a.indexOf('ARCHITECTURE'));
    assert.ok(a.indexOf('ARCHITECTURE') < a.indexOf('SERVICE BRIEF'));
    assert.ok(a.indexOf('SERVICE BRIEF') < a.indexOf('\nTASK\n'));
  });

  it('downgrades a small task and sends a large or twice-failed task toward Cursor', () => {
    const small = choose({ from: 'local-ornith', tokens: 100, files: 1, localFails: 0 });
    assert.equal(small.route, 'local-small');
    const big = choose({ from: 'local-small', tokens: 9000, files: 1 });
    assert.equal(big.route, 'local-ornith');
    const failed = choose({ from: 'local-small', localFails: 2 });
    assert.equal(failed.route, 'cursor');
    assert.match(failed.reasons[0], /failed local/);
  });

  it('uses one keep_alive until the cost router flag is on', () => {
    const before = roles.keepAliveFor('planner');
    assert.equal(before, roles.keepAliveFor('coder'));
    process.env.ORCH_COST_ROUTER = '1';
    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../lib/flow/roles')];
    const again = require('../lib/flow/roles');
    assert.notEqual(again.keepAliveFor('planner'), again.keepAliveFor('coder'));
    delete process.env.ORCH_COST_ROUTER;
  });

  it('hashes task text with the commit and round-trips a cache row', () => {
    assert.notEqual(hash('a', 'sha'), hash('b', 'sha'));
    assert.notEqual(hash('a', 'sha1'), hash('a', 'sha2'));
    const store = require('../lib/db');
    const cache = require('../lib/routing/cache');
    const made = store.createProjectWithService(
      { name: 'cache', slug: 'cache', description: '', path: '', default_branch: '' },
      { name: 'api', path: '.', local_path: '/tmp', default_branch: 'main', status: 'active', origin: 'existing' },
    );
    const key = hash('edit checkout', 'abc');
    assert.equal(cache.get(made.serviceId, 'plan', key), null);
    cache.put(made.serviceId, 'plan', key, { steps: 1 });
    assert.deepEqual(cache.get(made.serviceId, 'plan', key).payload, { steps: 1 });
  });
});

describe('schema v11', () => {
  it('opens a v10 database as v11 and rolls back the failure hook', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v11-')));
    const db = path.join(dir, 'up.db');
    const envFor = (extra = {}) => ({ ...process.env, ORCH_DB: db, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ORCH_CONTEXT_DIR: path.join(dir, 'ctx'), ...extra });
    const open = (extra) => execFileSync(process.execPath, ['--no-warnings', '-e', "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: envFor(extra) });
    const version = () => JSON.parse(open().trim().split('\n').filter((l) => !l.startsWith('[db]')).pop()).v;
    assert.equal(version(), 11);
    const w = new DatabaseSync(db);
    w.exec('DROP TABLE flow_cache');
    w.exec('PRAGMA user_version = 10');
    w.close();
    assert.equal(version(), 11);
    const again = new DatabaseSync(db);
    again.exec('DROP TABLE flow_cache');
    again.exec('PRAGMA user_version = 10');
    again.close();
    let failed = false;
    try { open({ ORCH_TEST_FAIL_MIGRATION_V11: '1' }); } catch (e) {
      failed = /v11 migration failed/.test(`${e.stderr || ''}${e.message || ''}`);
    }
    assert.equal(failed, true);
    const left = new DatabaseSync(db, { readOnly: true });
    assert.equal(left.prepare('SELECT user_version v FROM pragma_user_version').get().v, 10);
    assert.equal(left.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'flow_cache'").get().c, 0);
    left.close();
  });
});

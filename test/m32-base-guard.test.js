'use strict';
// M2: ORCH_EXPECTED_BASE. v2 refuses a mismatched resolved base; v1 warns and continues; an explicit base_ref overrides.
delete process.env.ORCH_EXPECTED_BASE;
delete process.env.ORCH_FLOW;
delete process.env.ORCH_DB;
delete process.env.ORCH_WORKTREES;
delete process.env.ORCH_LOG_DIR;
require('./helpers/temp-env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');

const MAP = JSON.stringify({ 'api-seva': 'feature/city_filter' });
const evText = async (S, id) => (await S.get(`/tasks/${id}/events`)).map((e) => e.message).join('\n');
const aiderCount = (S) => {
  const p = path.join(S.base, 'stub-aider.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0;
};
function setBaseRef(dbPath, id, ref) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.prepare('UPDATE tasks SET base_ref = ? WHERE id = ?').run(ref, id);
  db.close();
}
function runNode(code, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m32-'));
  const base = { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...env };
  delete base.ORCH_ALLOW_DEFAULT_DB;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', env: base }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('M32 expected base config', () => {
  it('rejects a non-object ORCH_EXPECTED_BASE and accepts a service map', async () => {
    const bad = await runNode("require('./config')", { ORCH_EXPECTED_BASE: 'feature/city_filter' });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /ORCH_EXPECTED_BASE must be a JSON object/);
    const ok = await runNode("const c = require('./config'); console.log(c.FLOW + ' ' + c.EXPECTED_BASE['api-seva'])", { ORCH_FLOW: 'v2', ORCH_EXPECTED_BASE: MAP });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'v2 feature/city_filter');
  });
});

describe('M32 expected base at runtime', () => {
  async function boot(flow) {
    const S = await startServer({ env: { ORCH_FLOW: flow, ORCH_EXPECTED_BASE: MAP } });
    const repo = makeRepo(path.join(S.work, 'api-seva'), { 'a.txt': 'a\n' });
    git(repo, 'branch', 'feature/city_filter');
    git(repo, 'branch', 'topic');
    const P = await S.addProject(repo, 'api-seva', 'true');
    return { S, P, repo };
  }

  it('v1 logs a warning and still runs when the service default is not the expected base', async () => {
    const { S, P } = await boot('v1');
    try {
      const t = await S.runToReview(P.id, { title: 'v1', prompt: 'edit a', files: ['a.txt'], engine: 'local' });
      assert.match(await evText(S, t.id), /WARNING: base 'main' from service\.default_branch does not match expected 'feature\/city_filter'/);
      assert.equal(aiderCount(S) > 0, true);
    } finally { await S.stop(); }
  });

  it('v2 refuses base_mismatch before aider and before worktree add', async () => {
    const { S, P } = await boot('v2');
    try {
      const n = aiderCount(S);
      const t = await S.runToReview(P.id, { title: 'v2', prompt: 'edit a', files: ['a.txt'], engine: 'auto' }, 'failed');
      assert.match(t.result_summary, /base_mismatch: service 'api-seva' resolved 'main'/);
      assert.equal(t.worktree_path, null);
      assert.equal(aiderCount(S), n);
      assert.doesNotMatch(await evText(S, t.id), /git worktree add/);
    } finally { await S.stop(); }
  });

  it('an explicit base_ref overrides the expected base and is logged', async () => {
    const { S, P, repo } = await boot('v2');
    try {
      const t0 = await S.createTask(P.id, { title: 'override', prompt: 'edit a', files: ['a.txt'], engine: 'local' });
      setBaseRef(S.dbPath, t0.id, 'topic');
      await S.post(`/tasks/${t0.id}/approve-start`, {});
      const t = await S.waitStatus(t0.id, 'review');
      assert.match(await evText(S, t.id), /explicit base 'topic' overrides expected base 'feature\/city_filter' for service api-seva/);
      assert.equal(git(repo, 'merge-base', t.head_sha, 'topic').trim(), git(repo, 'rev-parse', 'topic').trim());
    } finally { await S.stop(); }
  });

  it('v2 accepts the expected base when base_ref names it', async () => {
    const { S, P } = await boot('v2');
    try {
      const t0 = await S.createTask(P.id, { title: 'match', prompt: 'edit a', files: ['a.txt'], engine: 'local' });
      setBaseRef(S.dbPath, t0.id, 'feature/city_filter');
      await S.post(`/tasks/${t0.id}/approve-start`, {});
      const t = await S.waitStatus(t0.id, 'review');
      const ev = await evText(S, t.id);
      assert.match(ev, /base feature\/city_filter from task\.base_ref/);
      assert.doesNotMatch(ev, /base_mismatch|overrides expected|WARNING: base/);
    } finally { await S.stop(); }
  });
});

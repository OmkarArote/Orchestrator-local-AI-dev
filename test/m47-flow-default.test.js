'use strict';
// The default flow is v2. A task keeps the flow it was given at create time.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, ROOT } = require('./helpers/harness');

function flowOf(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m47-'));
  const env = { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...extra };
  delete env.ORCH_ALLOW_DEFAULT_DB;
  if (!Object.prototype.hasOwnProperty.call(extra, 'ORCH_FLOW')) delete env.ORCH_FLOW;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--no-warnings', '-e', "console.log(require('./config').FLOW)"], { cwd: ROOT, encoding: 'utf8', env }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

function setFlow(dbPath, id, flow) {
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('UPDATE tasks SET flow = ? WHERE id = ?').run(flow, id); }
  finally { db.close(); }
}

describe('flow default', () => {
  it('is v2 when ORCH_FLOW is absent, and v1 only when set to v1', async () => {
    assert.equal(await flowOf(), 'v2');
    assert.equal(await flowOf({ ORCH_FLOW: 'v2' }), 'v2');
    assert.equal(await flowOf({ ORCH_FLOW: 'v1' }), 'v1');
  });

  it('stamps the server flow onto a new task', async () => {
    const v1 = await startServer();
    const v2 = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(v1.work, 'api'), { 'a.txt': 'a\n' });
      const P = await v1.addProject(repo, 'api', 'true');
      const a = await v1.createTask(P.id, { title: 'a', prompt: 'edit a.txt', files: ['a.txt'], engine: 'auto' });
      assert.equal(a.flow, 'v1');
      const repo2 = makeRepo(path.join(v2.work, 'api'), { 'a.txt': 'a\n' });
      const P2 = await v2.addProject(repo2, 'api', 'true');
      const b = await v2.createTask(P2.id, { title: 'b', prompt: 'edit a.txt', files: ['a.txt'], engine: 'auto' });
      assert.equal(b.flow, 'v2');
    } finally { await v1.stop(); await v2.stop(); }
  });

  it('runs a v2-stamped task on v2 even when the server was started with ORCH_FLOW=v1', async () => {
    const S = await startServer();
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'a\n' });
      const P = await S.addProject(repo, 'api', 'true');
      const created = await S.createTask(P.id, { title: 'stamped', prompt: 'edit a.txt', files: ['a.txt'], engine: 'auto' });
      setFlow(S.dbPath, created.id, 'v2');
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const done = await S.waitStatus(created.id, 'review');
      assert.equal(done.flow, 'v2');
      const events = await S.get(`/tasks/${created.id}/events`);
      assert.equal(events.some((e) => e.kind === 'plan'), true);
    } finally { await S.stop(); }
  });

  it('keeps a v1-stamped task on v1 when the server is v2', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'a\n' });
      const P = await S.addProject(repo, 'api', 'true');
      const created = await S.createTask(P.id, { title: 'old', prompt: 'edit a.txt', files: ['a.txt'], engine: 'auto' });
      setFlow(S.dbPath, created.id, 'v1');
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const done = await S.waitStatus(created.id, 'review');
      assert.equal(done.flow, 'v1');
      const events = await S.get(`/tasks/${created.id}/events`);
      assert.equal(events.some((e) => e.kind === 'plan'), false);
      assert.equal(events.some((e) => String(e.message).includes('engine local: aider')), true);
    } finally { await S.stop(); }
  });
});

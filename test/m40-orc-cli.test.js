'use strict';
// M10 CLI: orc talks to the server over HTTP and never opens the database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');

function orc(S, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/orc.js'), ...args], {
      env: { ...process.env, ORCH_PORT: String(S.port) },
      cwd: ROOT,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

describe('M40 orc CLI', () => {
  it('do waits until review, and status and review read that task', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(S.work, 'm40'), { 'a.txt': 'a\n' });
      git(repo, 'branch', 'topic');
      await S.addProject(repo, 'm40', 'true');
      const done = await orc(S, ['do', 'edit a.txt', '--service', 'm40', '--base', 'topic', '--title', 'cli']);
      assert.equal(done.code, 0, done.err + done.out);
      const row = JSON.parse(done.out);
      assert.equal(row.status, 'review');
      assert.ok(row.head_sha);
      const status = await orc(S, ['status', String(row.id)]);
      assert.equal(status.code, 0, status.err);
      assert.equal(JSON.parse(status.out).status, 'review');
      const review = await orc(S, ['review', String(row.id)]);
      assert.equal(review.code, 0, review.err);
      const body = JSON.parse(review.out);
      assert.equal(body.lineage.tree.kind, 'task');
      assert.equal(body.lineage.tree.children[0].kind, 'plan');
    } finally { await S.stop(); }
  });
});

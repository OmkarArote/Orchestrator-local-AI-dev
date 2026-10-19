'use strict';
// M9: ORCH_FLOW=v2 auto tasks run the pipeline. POST /api/do approves itself. One remaining gate is review.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

const evs = async (S, id) => S.get(`/tasks/${id}/events`);
const cursorLog = (S) => {
  const p = path.join(S.base, 'stub-agent.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

describe('M39 flow v2', () => {
  it('POST /api/do is refused unless ORCH_FLOW=v2', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v1' } });
    try {
      const repo = makeRepo(path.join(S.work, 'm39'), { 'a.txt': 'a\n' });
      await S.addProject(repo, 'm39', 'true');
      const r = await S.post('/do', { service: 'm39', prompt: 'edit a.txt', title: 'no' }, { allowFail: true });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /ORCH_FLOW=v2/);
    } finally { await S.stop(); }
  });

  it('reaches review with one start approval and no awaiting transition', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(S.work, 'm39'), { 'a.txt': 'a\n' });
      await S.addProject(repo, 'm39', 'true');
      const created = await S.post('/do', { service: 'm39', prompt: 'edit a.txt', title: 'happy', files: ['a.txt'], check_cmd: 'true' });
      assert.equal(created.status, 'approved');
      const t = await S.waitStatus(created.id, 'review');
      const events = await evs(S, t.id);
      assert.equal(events.some((e) => e.kind === 'status' && /awaiting_/.test(e.message)), false);
      const approvals = (await S.get(`/tasks/${t.id}`)).approvals;
      assert.equal(approvals.filter((a) => a.stage === 'start' && a.decision === 'approved').length, 1);
      assert.equal(t.status, 'review');
      assert.ok(t.head_sha);
    } finally { await S.stop(); }
  });

  it('after two failed checks escalates with verify_failed>=2 and runs the Cursor stub', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2' } });
    try {
      const repo = makeRepo(path.join(S.work, 'm39b'), { 'a.txt': 'a\n' });
      await S.addProject(repo, 'm39b', 'true');
      const check_cmd = 'node -e "process.exit(require(\'fs\').readdirSync(\'.\').some(f=>f.startsWith(\'STUB-\'))?0:1)"';
      const created = await S.post('/do', { service: 'm39b', prompt: 'edit a.txt', title: 'retry', files: ['a.txt'], check_cmd });
      const t = await S.waitStatus(created.id, ['review', 'failed'], { timeout: 60000 });
      const events = await evs(S, t.id);
      const blob = events.map((e) => `${e.kind}: ${e.message}`).join('\n');
      assert.ok(/verify_failed>=2/.test(blob), blob.slice(0, 2500));
      assert.match(cursorLog(S), /mode=force/);
      assert.equal(events.some((e) => e.kind === 'status' && /awaiting_/.test(e.message)), false);
      assert.equal(t.status, 'review');
    } finally { await S.stop(); }
  });
});

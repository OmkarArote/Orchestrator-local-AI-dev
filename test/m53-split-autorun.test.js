'use strict';
// M1: one approval on a v2 split parent runs the stacked parts in order.
// A failure stops the rest as blocked; a cancel stops the rest as cancelled.
// ORCH_SPLIT_AUTORUN=0 restores per-part approval.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startServer, makeRepo, ROOT } = require('./helpers/harness');

const FILES = { 'src/a.js': 'a\n', 'src/b.js': 'b\n', 'src/c.js': 'c\n' };
const PROMPT = 'Touch each file.\n\n## Files\n\n- `src/a.js`\n- `src/b.js`\n- `src/c.js`\n';
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const editTargets = (r) => {
  const out = [];
  for (let i = 0; i < r.files.length; i++) {
    if (r.files[i] === '--read') { i++; continue; }
    if (String(r.files[i]).startsWith('--')) continue;
    out.push(String(r.files[i]));
  }
  return out;
};
const partsOf = (tasks) => tasks.filter((t) => t.group_id).sort((a, b) => a.step_no - b.step_no);

function runNode(code, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m53-'));
  const base = { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ...env };
  delete base.ORCH_ALLOW_DEFAULT_DB;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', env: base }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('M53 split autorun', () => {
  it('ORCH_SPLIT_AUTORUN defaults on and 0 turns it off', async () => {
    const on = await runNode("const c = require('./config'); console.log(c.SPLIT_AUTORUN)", {});
    assert.equal(on.code, 0, on.stderr);
    assert.equal(on.stdout.trim(), 'true');
    const off = await runNode("const c = require('./config'); console.log(c.SPLIT_AUTORUN)", { ORCH_SPLIT_AUTORUN: '0' });
    assert.equal(off.stdout.trim(), 'false');
  });

  it('one approval on the parent runs 3 parts to review and the parent shows 3/3', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '1' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm53a'), FILES), 'm53a', 'true');
      const parent = await S.runToReview(P.id, { title: 'three', prompt: PROMPT, engine: 'auto', allow_escalation: true }, 'failed');
      assert.equal(parent.display_status, 'split');
      assert.match(parent.result_summary, /^split into sequence #\d+: #\d+, #\d+, #\d+/);
      const parts = partsOf(await S.get('/tasks'));
      assert.equal(parts.length, 3);
      const human = (await S.get(`/tasks/${parent.id}`)).approvals.filter((a) => a.stage === 'start' && a.decision === 'approved');
      assert.equal(human.length, 1);
      for (const p of parts) {
        const full = await S.get(`/tasks/${p.id}`);
        assert.match(full.approvals.find((a) => a.stage === 'start').reason, /auto-started with parent/);
        assert.equal(full.files.length, 1);
      }
      const done = [];
      for (const p of parts) done.push(await S.waitStatus(p.id, 'review', { timeout: 40000 }));
      assert.deepEqual(done.map((t) => t.files[0]), ['src/a.js', 'src/b.js', 'src/c.js']);
      const again = await S.get(`/tasks/${parent.id}`);
      assert.match(again.result_summary, /3\/3: #\d+ review, #\d+ review, #\d+ review/);
      const ev = (await S.get(`/tasks/${parent.id}/events`)).map((e) => e.message).join('\n');
      assert.match(ev, /3\/3: #\d+ review, #\d+ review, #\d+ review/);
      const runs = lines(path.join(S.base, 'stub-aider.log'));
      assert.equal(runs.length, 3, 'one aider run per part');
      for (const name of ['a.js', 'b.js', 'c.js']) assert.ok(runs.some((r) => r.files.some((f) => String(f).endsWith(name))), name);
    } finally { await S.stop(); }
  });

  it('a failure in part 2 stops part 3 as blocked', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '1', ORCH_V2_STEP_ATTEMPTS: '1' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm53b'), FILES), 'm53b', 'true');
      const parent = await S.runToReview(P.id, {
        title: 'fail part 2', prompt: PROMPT, engine: 'auto', allow_escalation: true,
        check_cmd: '! grep -q "edited by stub-aider" src/b.js',
      }, 'failed');
      const parts = partsOf(await S.get('/tasks'));
      assert.equal(parts.length, 3);
      await S.waitStatus(parts[0].id, 'review', { timeout: 40000 });
      const failed = await S.waitStatus(parts[1].id, 'failed', { timeout: 40000 });
      assert.equal(failed.display_status, 'failed');
      const failedEv = (await S.get(`/tasks/${parts[1].id}/events`)).map((e) => e.message).join('\n');
      assert.match(failedEv, /FAILED \(exit 1/);
      const stopped = await S.waitFor(async () => {
        const t = await S.get(`/tasks/${parts[2].id}`);
        return t.display_status === 'blocked' ? t : null;
      }, { what: 'part 3 blocked' });
      assert.match(stopped.result_summary, /blocked: previous step/);
      const runs = lines(path.join(S.base, 'stub-aider.log'));
      assert.ok(!runs.some((r) => editTargets(r).some((f) => f.endsWith('c.js'))), 'part 3 never ran');
      const again = await S.get(`/tasks/${parent.id}`);
      assert.match(again.result_summary, /#\d+ review, #\d+ failed, #\d+ blocked/);
      const group = await S.get(`/groups/${parts[0].group_id}`);
      assert.deepEqual(group.steps.map((s) => s.display_status), ['review', 'failed', 'blocked']);
    } finally { await S.stop(); }
  });

  it('cancelling the running part stops the rest as cancelled', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '1' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm53c'), FILES), 'm53c', 'true');
      const parent = await S.runToReview(P.id, { title: 'cancel all', prompt: `${PROMPT}\nSTUB_SLOW`, engine: 'auto', allow_escalation: true }, 'failed');
      const parts = partsOf(await S.get('/tasks'));
      assert.equal(parts.length, 3);
      const log = path.join(S.base, 'stub-aider.log');
      await S.waitFor(async () => lines(log).length >= 1, { what: 'part 1 aider started' });
      await S.post(`/tasks/${parts[0].id}/cancel`, {});
      const first = await S.waitStatus(parts[0].id, 'failed', { timeout: 20000 });
      assert.equal(first.display_status, 'cancelled');
      assert.match(first.result_summary, /cancelled by user/);
      for (const p of parts.slice(1)) {
        const t = await S.waitFor(async () => {
          const row = await S.get(`/tasks/${p.id}`);
          return row.display_status === 'cancelled' ? row : null;
        }, { what: `part ${p.step_no} cancelled` });
        assert.match(t.result_summary, /cancelled: previous step/);
      }
      assert.equal(lines(log).length, 1, 'no later part started aider');
      const again = await S.get(`/tasks/${parent.id}`);
      assert.match(again.result_summary, /#\d+ cancelled, #\d+ cancelled, #\d+ cancelled/);
    } finally { await S.stop(); }
  });

  it('ORCH_SPLIT_AUTORUN=0 leaves the parts pending and runs nothing', async () => {
    const S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_LOCAL_MAX_FILES: '1', ORCH_SPLIT_AUTORUN: '0' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'm53d'), FILES), 'm53d', 'true');
      const n = lines(path.join(S.base, 'stub-aider.log')).length;
      const parent = await S.runToReview(P.id, { title: 'manual', prompt: PROMPT, engine: 'auto', allow_escalation: true }, 'failed');
      assert.match(parent.result_summary, /0\/3: #\d+ pending, #\d+ pending, #\d+ pending/);
      const parts = partsOf(await S.get('/tasks'));
      assert.equal(parts.length, 3);
      assert.ok(parts.every((p) => p.status === 'pending' && p.display_status === 'pending'));
      assert.equal(lines(path.join(S.base, 'stub-aider.log')).length, n);
    } finally { await S.stop(); }
  });
});

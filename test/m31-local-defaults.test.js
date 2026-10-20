'use strict';
// M0: local-engine defaults. Edit format, num_predict/num_ctx, native keep_alive, check-timeout process group, protected base_ref.
delete process.env.ORCH_LOCAL_NUM_PREDICT;
delete process.env.ORCH_OLLAMA_KEEP_ALIVE;
delete process.env.ORCH_AIDER_EDIT_FORMAT;
delete process.env.ORCH_PROTECTED_BRANCHES;
delete process.env.ORCH_DB;
delete process.env.ORCH_WORKTREES;
delete process.env.ORCH_LOG_DIR;
require('./helpers/temp-env'); // FIRST: lib/* is loaded in-process below
process.env.OLLAMA_API_BASE = 'http://127.0.0.1:9';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');
const { resolveAiderEditFormat, parseAiderTokens, filesThatFit } = require('../lib/runner');
const cfg = require('../config');
const store = require('../lib/db');
const models = require('../lib/models');
const llm = require('../lib/llm');

const lastAider = (S) => JSON.parse(fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').pop());
const argAfter = (rec, flag) => rec.args[rec.args.indexOf(flag) + 1];
const evText = async (S, id) => (await S.get(`/tasks/${id}/events`)).map((e) => e.message).join('\n');
const aiderLines = (S) => {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m31-'));
  const base = { ...process.env, ORCH_DB: path.join(dir, 'o.db'), ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), OLLAMA_API_BASE: 'http://127.0.0.1:9', ...env };
  delete base.ORCH_ALLOW_DEFAULT_DB;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--no-warnings', '-e', code], { cwd: ROOT, encoding: 'utf8', env: base }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}
function openChat(S, id, body) {
  const events = [];
  const done = (async () => {
    const r = await fetch(`${S.url}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) return { status: r.status, events };
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
        if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    }
    return { status: r.status, events };
  })();
  return done;
}

describe('M31 live token count', () => {
  it('parses aider token lines and keeps only the files that still fit the window', () => {
    assert.deepEqual(parseAiderTokens('Tokens: 11k sent, 3.5k received.'), { sent: 11000, received: 3500 });
    assert.deepEqual(parseAiderTokens('Tokens: 1,024 sent, 512 received. Cost: $0.00 message, $0.00 session.'), { sent: 1024, received: 512 });
    assert.equal(parseAiderTokens('Scanning repo: 100%'), null);
    // History already ~14.5k of 16384. A 4 KB file still fits; a 40 KB file does not.
    const fit = filesThatFit({
      baseChars: 32000, numCtx: 16384, cap: 60000, promptTokens: 14500,
      files: [{ path: 'src/models/product.model.js', bytes: 4000 }, { path: 'src/services/product.service.js', bytes: 40000 }],
    });
    assert.deepEqual(fit.fit, ['src/models/product.model.js']);
    assert.equal(fit.tokens, 14500 + 1000);
  });
});

describe('M31 edit-format selection (pure)', () => {
  it('defaults to diff at 4096 bytes and when nothing is pinned', () => {
    assert.deepEqual(resolveAiderEditFormat({ format: '', pinned: [{ missing: false, bytes: 4096 }] }), { format: 'diff' });
    assert.deepEqual(resolveAiderEditFormat({ format: null, pinned: [] }), { format: 'diff' });
    assert.deepEqual(resolveAiderEditFormat({ format: 'diff', pinned: [{ missing: false, bytes: 5000 }] }), { format: 'diff' });
  });
  it('falls back to whole when a pinned file is under 4096 bytes or missing', () => {
    assert.deepEqual(resolveAiderEditFormat({ pinned: [{ missing: false, bytes: 4095 }] }), { format: 'whole' });
    assert.deepEqual(resolveAiderEditFormat({ format: 'diff', pinned: [{ missing: true, bytes: 0 }] }), { format: 'whole' });
    assert.deepEqual(resolveAiderEditFormat({ pinned: [{ missing: false, bytes: 8000 }, { missing: false, bytes: 10 }] }), { format: 'whole' });
  });
  it('keeps an explicit whole, udiff, or diff-fenced value and rejects anything else', () => {
    assert.deepEqual(resolveAiderEditFormat({ format: 'udiff', pinned: [{ missing: false, bytes: 3 }] }), { format: 'udiff' });
    assert.deepEqual(resolveAiderEditFormat({ format: 'whole', pinned: [{ missing: false, bytes: 8000 }] }), { format: 'whole' });
    assert.deepEqual(resolveAiderEditFormat({ format: 'diff-fenced', pinned: [{ missing: true, bytes: 0 }] }), { format: 'diff-fenced' });
    const bad = resolveAiderEditFormat({ format: 'patch', pinned: [] });
    assert.match(bad.error, /ORCH_AIDER_EDIT_FORMAT 'patch'/);
  });
});

describe('M31 aider settings and keep_alive (in-process)', () => {
  it('aiderSettingsFor emits the coder defaults (num_predict 2048, num_ctx 16384, temperature 0.1, seed 42), and role values win', async () => {
    assert.equal(cfg.LOCAL_NUM_PREDICT, 2048);
    assert.equal(cfg.LOCAL_NUM_CTX, 16384);
    store.clearModelRole('coding');
    const d = await models.aiderSettingsFor('ollama_chat/m');
    assert.equal(d.yaml, '- name: ollama_chat/m\n  extra_params:\n    num_ctx: 16384\n    temperature: 0.1\n    top_p: 0.9\n    top_k: 20\n    repeat_penalty: 1.05\n    num_predict: 2048\n    seed: 42\n');
    store.setModelRole('coding', 'm', { num_ctx: 8192, num_predict: 512 });
    try {
      const r = await models.aiderSettingsFor('ollama_chat/m');
      assert.equal(r.yaml, '- name: ollama_chat/m\n  extra_params:\n    num_ctx: 8192\n    temperature: 0.1\n    top_p: 0.9\n    top_k: 20\n    repeat_penalty: 1.05\n    num_predict: 512\n    seed: 42\n');
    } finally { store.clearModelRole('coding'); }
  });
  it('ORCH_LOCAL_NUM_PREDICT rejects 0 and accepts -1', async () => {
    const bad = await runNode("require('./config')", { ORCH_LOCAL_NUM_PREDICT: '0' });
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /ORCH_LOCAL_NUM_PREDICT must be an integer 1\.\.131072 or -1/);
    const ok = await runNode("const c = require('./config'); console.log(c.LOCAL_NUM_PREDICT)", { ORCH_LOCAL_NUM_PREDICT: '-1' });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout.trim().split('\n').pop(), '-1');
  });
  it('keep_alive is on the native chat body and absent from the OpenAI-compatible body', () => {
    const native = llm.buildBody({ system: 'S', user: 'U', api: 'ollama', model: 'm' });
    assert.equal(native.keep_alive, '30m');
    assert.equal(native.options.keep_alive, undefined);
    const v1 = llm.buildBody({ system: 'S', user: 'U', api: 'openai', model: 'm' });
    assert.equal(v1.keep_alive, undefined);
    assert.equal(cfg.OLLAMA_KEEP_ALIVE, '30m');
  });
});

describe('M31 local engine defaults (server)', () => {
  let S, P, repo;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'm31'), { 'a.txt': 'a\n', 'big.txt': 'x'.repeat(4096) });
    P = await S.addProject(repo, 'm31', 'true');
  });
  after(async () => { await S.stop(); });

  it('a pinned file of 4096 bytes uses diff, reaches review, and logs the base source', async () => {
    const t = await S.runToReview(P.id, { title: 'big', prompt: 'edit', files: ['big.txt'], engine: 'local' });
    const rec = lastAider(S);
    assert.equal(argAfter(rec, '--edit-format'), 'diff');
    assert.match(rec.message, /return a search\/replace diff, not the complete file/);
    assert.doesNotMatch(rec.message, /return the complete file/);
    assert.match(await evText(S, t.id), /base main from service\.default_branch/);
  });
  it('a pinned file under 4096 bytes uses whole and asks for the complete file', async () => {
    await S.runToReview(P.id, { title: 'small', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    const rec = lastAider(S);
    assert.equal(argAfter(rec, '--edit-format'), 'whole');
    assert.match(rec.message, /return the complete file/);
  });
  it('a missing pinned file uses whole', async () => {
    await S.runToReview(P.id, { title: 'new', prompt: 'edit', files: ['brand-new.txt'], engine: 'local' });
    const rec = lastAider(S);
    assert.equal(argAfter(rec, '--edit-format'), 'whole');
    assert.match(rec.message, /return the complete file/);
  });
  it('keep_alive 30m is on the dashboard chat request', async () => {
    const c = await S.post('/conversations', {});
    const r = await openChat(S, c.id, { content: 'Say hello' });
    assert.equal(r.status, 200);
    assert.ok(r.events.some((e) => e.event === 'done'));
    const bodies = S.fake.state.requests.filter((q) => q.path === '/api/chat' && q.body && q.body.stream === true);
    const b = bodies[bodies.length - 1].body;
    assert.equal(b.keep_alive, '30m');
    assert.equal(b.options.keep_alive, undefined);
  });
  it('base_ref uat is refused before worktree add; a main service still ran above', async () => {
    const t0 = await S.createTask(P.id, { title: 'prot', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    setBaseRef(S.dbPath, t0.id, 'uat');
    await S.post(`/tasks/${t0.id}/approve-start`, {});
    const t = await S.waitStatus(t0.id, 'failed');
    assert.equal(t.worktree_path, null);
    assert.match(t.result_summary, /refusing protected base 'uat' from task\.base_ref/);
    const ev = await evText(S, t.id);
    assert.match(ev, /base uat from task\.base_ref/);
    assert.doesNotMatch(ev, /git worktree add/);
  });
  it('a local origin ref ahead of the base logs a behind warning and the task still reaches review', async () => {
    const ahead = makeRepo(path.join(S.work, 'behind'), { 'a.txt': 'a\n' });
    git(ahead, 'commit', '--allow-empty', '-m', 'ahead');
    git(ahead, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(ahead, 'reset', '--hard', 'HEAD~1');
    assert.equal(git(ahead, 'remote').trim(), '');
    const Q = await S.addProject(ahead, 'behind', 'true');
    const t = await S.runToReview(Q.id, { title: 'behind', prompt: 'edit', files: ['a.txt'], engine: 'local' });
    const ev = await evText(S, t.id);
    assert.match(ev, /base main from service\.default_branch/);
    assert.match(ev, /base main from service\.default_branch is 1 commit\(s\) behind origin\/main \(local ref only, not fetched\)/);
  });
});

describe('M31 edit-format env and check timeout', () => {
  it('ORCH_AIDER_EDIT_FORMAT=udiff wins over the small-file fallback', async () => {
    const S = await startServer({ env: { ORCH_AIDER_EDIT_FORMAT: 'udiff' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'ud'), { 'a.txt': 'a\n' }), 'ud', 'true');
      await S.runToReview(P.id, { title: 'u', prompt: 'edit', files: ['a.txt'], engine: 'local' });
      const rec = lastAider(S);
      assert.equal(argAfter(rec, '--edit-format'), 'udiff');
      assert.match(rec.message, /return a unified diff, not the complete file/);
    } finally { await S.stop(); }
  });
  it('an invalid edit format is refused and aider is not spawned', async () => {
    const S = await startServer({ env: { ORCH_AIDER_EDIT_FORMAT: 'patch' } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'bad'), { 'a.txt': 'a\n' }), 'bad', 'true');
      const n = aiderLines(S);
      const t = await S.runToReview(P.id, { title: 'bad', prompt: 'edit', files: ['a.txt'], engine: 'local' }, 'failed');
      assert.match(t.result_summary, /ORCH_AIDER_EDIT_FORMAT 'patch'/);
      assert.equal(aiderLines(S), n);
    } finally { await S.stop(); }
  });
  it('a check that spawns a grandchild leaves no survivor after timeout', { timeout: 30000 }, async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-m31-gc-')));
    const pidfile = path.join(base, 'grand.pid');
    const S = await startServer({ base, env: { ORCH_CHECK_TIMEOUT_MS: '1000', PIDFILE: pidfile } });
    try {
      const P = await S.addProject(makeRepo(path.join(S.work, 'gc'), { 'a.txt': 'a\n' }), 'gc', 'sleep 30 & echo $! > "$PIDFILE"; wait');
      const t = await S.runToReview(P.id, { title: 'gc', prompt: 'edit', files: ['a.txt'], engine: 'local' }, 'failed');
      assert.match(t.result_summary, /FAILED \(timeout: sleep 30 & echo \$! > "\$PIDFILE"; wait\)/);
      const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
      assert.ok(pid > 0);
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
      assert.equal(alive, false);
    } finally { await S.stop(); }
  });
});

describe('M50 tuning: local window and request cap', () => {
  it('derives the request cap from num_ctx and num_predict (16384/2048 -> 44000) and ORCH_LOCAL_NUM_CTX moves it', async () => {
    assert.equal(cfg.requestCapFor(16384, 2048), 44000);
    assert.equal(cfg.requestCapFor(12288, 1536), 31000);
    assert.equal(cfg.LOCAL_MAX_FILES, 3);
    const r = await runNode("const c = require('./config'); console.log(c.LOCAL_NUM_CTX, c.LOCAL_MAX_REQUEST_CHARS)", { ORCH_LOCAL_NUM_CTX: '8192', ORCH_LOCAL_MAX_REQUEST_CHARS: '' });
    assert.equal(r.stdout.trim(), '8192 16000');
    const bad = await runNode("require('./config')", { ORCH_LOCAL_NUM_CTX: '999999' });
    assert.notEqual(bad.code, 0);
  });
  it('roles: think off, coder seed 42 / temperature 0.1, planner 12288, reader 8192/512, repair on the second model', () => {
    const roles = require('../lib/flow/roles');
    const c = roles.optionsFor('coder');
    assert.equal(c.temperature, 0.1); assert.equal(c.seed, 42); assert.equal(c.num_predict, 2048); assert.equal(c.num_ctx, 16384);
    assert.equal(roles.optionsFor('planner').num_ctx, 12288);
    assert.deepEqual([roles.optionsFor('reader').num_ctx, roles.optionsFor('reader').num_predict], [8192, 512]);
    for (const r of roles.ROLES) assert.equal(roles.chatFields(r).think, false);
    assert.equal(roles.modelFor('repair', ['ornith:9b', 'qwen2.5-coder:7b']), 'qwen2.5-coder:7b');
    assert.equal(roles.modelFor('coder', ['qwen2.5-coder:7b']), 'qwen2.5-coder:7b');
    assert.equal(roles.modelFor('repair', ['ornith:9b']), 'ornith:9b');
  });
  it('v2 step settings file carries the role options and think:false', () => {
    const { stepSettingsYaml } = require('../lib/flow/coder');
    assert.equal(stepSettingsYaml('ollama_chat/ornith:9b'), '- name: ollama_chat/ornith:9b\n  extra_params:\n    num_ctx: 16384\n    temperature: 0.1\n    top_p: 0.9\n    top_k: 20\n    repeat_penalty: 1.05\n    num_predict: 2048\n    seed: 42\n    think: false\n');
  });
});

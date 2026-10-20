'use strict';
// Conflicts: auto-resolve only inside the rules. Otherwise roll back and open a pending Cursor task.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, makeRepo, git, sleep } = require('./helpers/harness');
const { canAutoResolve } = require('../lib/flow/conflicts');

describe('conflict rules', () => {
  const file = (p, text) => ({ path: p, text });
  const hunk = (n) => `<<<<<<< dev\n${'a\n'.repeat(n)}=======\n${'b\n'.repeat(n)}>>>>>>> task\n`;
  it('allows one small text hunk and refuses lockfiles, wide hunks, and a fourth file', () => {
    assert.equal(canAutoResolve([file('a.txt', hunk(2))]).ok, true);
    assert.equal(canAutoResolve([file('package-lock.json', hunk(1))]).ok, false);
    assert.match(canAutoResolve([file('db/migrations/1.sql', hunk(1))]).reason, /protected/);
    assert.match(canAutoResolve([file('.env', hunk(1))]).reason, /protected/);
    assert.match(canAutoResolve([file('a.txt', '\0')]).reason, /binary/);
    assert.match(canAutoResolve([file('a.txt', hunk(41))]).reason, /40/);
    assert.match(canAutoResolve([1, 2, 3, 4].map((i) => file(`f${i}.txt`, hunk(1)))).reason, /max 3/);
  });
});

function setHead(S, id, sha) {
  const d = new DatabaseSync(S.dbPath);
  try { d.prepare('UPDATE tasks SET head_sha = ? WHERE id = ?').run(sha, id); } finally { d.close(); }
}
function diverge(repo, wt, file, devText, taskText) {
  git(repo, 'checkout', 'dev');
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), devText);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `dev ${file}`);
  git(repo, 'checkout', 'main');
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), taskText);
  git(wt, 'add', '--', file);
  git(wt, 'commit', '-q', '-m', `task ${file}`);
}
function conflictChats(S) {
  return S.fake.state.requests.filter((r) => r.path === '/api/chat' && r.body && r.body.stream !== true && /<<<<<<< /.test(((r.body.messages) || []).map((m) => m.content || '').join('\n'))).length;
}
function openChat(S, id, body) {
  const events = [];
  const done = (async () => {
    const r = await fetch(`${S.url}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = { status: r.status, events };
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) { out.json = await r.json(); return out; }
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
    return out;
  })();
  return done;
}

describe('merge conflicts', () => {
  async function world(files) {
    const S = await startServer();
    const repo = makeRepo(path.join(S.work, 'api'), files);
    git(repo, 'branch', 'dev');
    const P = await S.addProject(repo, 'api', 'true');
    await S.post(`/services/${P.serviceId}/update`, { dev_branch: 'dev' });
    const t = await S.createTask(P.id, { title: 'edit', prompt: 'change a.txt MARKER', files: ['a.txt'] });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const done = await S.waitStatus(t.id, 'review');
    return { S, repo, P, t: done };
  }

  it('resolves one small conflict, fast-forwards, and shows the merge in the lineage', async () => {
    const w = await world({ 'a.txt': 'base\n' });
    try {
      diverge(w.repo, w.t.worktree_path, 'a.txt', 'DEV\n', 'TASK\n');
      setHead(w.S, w.t.id, git(w.t.worktree_path, 'rev-parse', 'HEAD').trim());
      const dev = git(w.repo, 'rev-parse', 'dev').trim();
      w.S.fake.state.chatReply = (u, body, user) => (/<<<<<<< /.test(user) ? 'resolved\n' : JSON.stringify({ service: null, confidence: 0.9, difficulty: 'simple', needs_thinking: false, reason: 'x' }));
      const before = conflictChats(w.S);
      const r = await w.S.post(`/tasks/${w.t.id}/merge-to`, { role: 'dev' });
      assert.equal(r.merge.ok, true);
      assert.notEqual(git(w.repo, 'rev-parse', 'dev').trim(), dev);
      assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8').includes('resolved') || git(w.repo, 'show', 'dev:a.txt').includes('resolved'), true);
      assert.equal(conflictChats(w.S), before + 1);
      const lin = await w.S.get(`/tasks/${w.t.id}/lineage`);
      assert.equal(JSON.stringify(lin.tree).includes('"kind":"merge"'), true);
    } finally { await w.S.stop(); }
  });

  it('a lockfile conflict rolls back, leaves the target sha, and opens a pending Cursor task', async () => {
    const w = await world({ 'a.txt': 'base\n', 'package-lock.json': '{}\n' });
    try {
      diverge(w.repo, w.t.worktree_path, 'package-lock.json', '{"dev":1}\n', '{"task":1}\n');
      setHead(w.S, w.t.id, git(w.t.worktree_path, 'rev-parse', 'HEAD').trim());
      const dev = git(w.repo, 'rev-parse', 'dev').trim();
      const log = path.join(w.S.base, 'stub-agent.log');
      const beforeLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      const before = conflictChats(w.S);
      const r = await w.S.post(`/tasks/${w.t.id}/merge-to`, { role: 'dev' }, { allowFail: true });
      assert.equal(r.status, 409);
      assert.equal(git(w.repo, 'rev-parse', 'dev').trim(), dev);
      assert.equal(conflictChats(w.S), before, 'the model is not asked to resolve a lockfile');
      const events = await w.S.get(`/tasks/${w.t.id}/events`);
      const row = events.find((e) => e.kind === 'merge' && e.message.includes('merge_rolled_back'));
      assert.ok(row);
      const body = JSON.parse(row.message);
      assert.equal(body.target_sha, dev);
      assert.equal(body.target_unchanged, true);
      const cursor = await w.S.get(`/tasks/${body.cursor_task_id}`);
      assert.equal(cursor.status, 'pending');
      assert.equal(cursor.engine, 'cursor');
      assert.match(cursor.prompt, /MARKER/);
      assert.match(cursor.prompt, /package-lock\.json/);
      assert.match(cursor.prompt, /<<<<<<< /);
      assert.match(cursor.prompt, /dev/);
      assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', beforeLog);
      const lin = await w.S.get(`/tasks/${w.t.id}/lineage`);
      assert.match(JSON.stringify(lin.tree), /merge_rolled_back|cursor #/);
    } finally { await w.S.stop(); }
  });

  it('four files and a 41-line hunk also roll back without resolving', async () => {
    const files = { 'a.txt': 'base\n', 'b.txt': 'base\n', 'c.txt': 'base\n', 'd.txt': 'base\n' };
    const w = await world(files);
    try {
      for (const name of Object.keys(files)) diverge(w.repo, w.t.worktree_path, name, `DEV ${name}\n`, `TASK ${name}\n`);
      setHead(w.S, w.t.id, git(w.t.worktree_path, 'rev-parse', 'HEAD').trim());
      const dev = git(w.repo, 'rev-parse', 'dev').trim();
      const before = conflictChats(w.S);
      const r = await w.S.post(`/tasks/${w.t.id}/merge-to`, { role: 'dev' }, { allowFail: true });
      assert.equal(r.status, 409);
      assert.equal(git(w.repo, 'rev-parse', 'dev').trim(), dev);
      assert.equal(conflictChats(w.S), before);
    } finally { await w.S.stop(); }
    const big = 'x\n'.repeat(45);
    const w2 = await world({ 'a.txt': 'base\n' });
    try {
      diverge(w2.repo, w2.t.worktree_path, 'a.txt', big, big.replace(/x/g, 'y'));
      setHead(w2.S, w2.t.id, git(w2.t.worktree_path, 'rev-parse', 'HEAD').trim());
      const dev = git(w2.repo, 'rev-parse', 'dev').trim();
      const before = conflictChats(w2.S);
      const r = await w2.S.post(`/tasks/${w2.t.id}/merge-to`, { role: 'dev' }, { allowFail: true });
      assert.equal(r.status, 409);
      assert.equal(git(w2.repo, 'rev-parse', 'dev').trim(), dev);
      assert.equal(conflictChats(w2.S), before);
    } finally { await w2.S.stop(); }
  });

  it('a check that fails after resolution rolls back and opens a Cursor task', async () => {
    const w = await world({ 'a.txt': 'base\n' });
    try {
      diverge(w.repo, w.t.worktree_path, 'a.txt', 'DEV\n', 'TASK\n');
      setHead(w.S, w.t.id, git(w.t.worktree_path, 'rev-parse', 'HEAD').trim());
      await w.S.post(`/services/${w.P.serviceId}/update`, { check_cmd: 'grep -q TASK a.txt' });
      const dev = git(w.repo, 'rev-parse', 'dev').trim();
      w.S.fake.state.chatReply = (u, body, user) => (/<<<<<<< /.test(user) ? 'resolved\n' : JSON.stringify({ service: null, confidence: 0.9, difficulty: 'simple', needs_thinking: false, reason: 'x' }));
      const r = await w.S.post(`/tasks/${w.t.id}/merge-to`, { role: 'dev' }, { allowFail: true });
      assert.equal(r.status, 409);
      assert.equal(git(w.repo, 'rev-parse', 'dev').trim(), dev);
      const events = await w.S.get(`/tasks/${w.t.id}/events`);
      const row = events.find((e) => e.kind === 'merge' && e.message.includes('merge_rolled_back'));
      const body = JSON.parse(row.message);
      assert.equal(body.target_unchanged, true);
      const cursor = await w.S.get(`/tasks/${body.cursor_task_id}`);
      assert.equal(cursor.status, 'pending');
      assert.equal(cursor.engine, 'cursor');
      assert.match(cursor.prompt, /MARKER/);
    } finally { await w.S.stop(); }
  });

  it('chat asks for confirm and only then merges', async () => {
    const S = await startServer();
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'base\n' });
      git(repo, 'branch', 'dev');
      const P = await S.addProject(repo, 'api', 'true');
      await S.post(`/services/${P.serviceId}/update`, { dev_branch: 'dev' });
      const t = await S.createTask(P.id, { title: 'edit', prompt: 'change a.txt', files: ['a.txt'] });
      await S.post(`/tasks/${t.id}/approve-start`, {});
      const done = await S.waitStatus(t.id, 'review');
      const dev = git(repo, 'rev-parse', 'dev').trim();
      const c = await S.post('/conversations', { title: 'ops' });
      const ask = await openChat(S, c.id, { content: `merge task ${done.id} into dev` });
      assert.equal(ask.status, 200);
      const asked = ask.events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
      assert.match(asked, new RegExp(`Merge ${done.branch} into dev`));
      assert.equal(git(repo, 'rev-parse', 'dev').trim(), dev);
      const go = await openChat(S, c.id, { content: `confirm merge task ${done.id} into dev` });
      assert.match(go.events.filter((e) => e.event === 'token').map((e) => e.data.text).join(''), /merged/);
      assert.notEqual(git(repo, 'rev-parse', 'dev').trim(), dev);
      await sleep(1);
    } finally { await S.stop(); }
  });
});

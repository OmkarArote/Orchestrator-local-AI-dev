'use strict';
// A follow-up keeps the task branch and comes back to review. It does not merge.
const http = require('node:http');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

function layaYes() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
      res.end(JSON.stringify({ answers: { needs_code_change: { p: 0.97 } }, confidence: 0.97 }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

const PLAN = JSON.stringify({
  targetBranch: null,
  steps: [{ id: '1', file: 'a.txt', intent: 'change a.txt', acceptance: 'check passes', estLines: 1 }],
  risk: { files: 1, crossModule: false, contract: false, estDiff: 1 },
});

function openChat(S, id, body) {
  const events = [];
  return (async () => {
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
}

describe('follow-up on the same branch', () => {
  it('iteration 2 returns to review without recreating the branch or merging', async () => {
    const laya = await layaYes();
    const S = await startServer({ env: { ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: String(laya.port) } });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'base\n' });
      const main = git(repo, 'rev-parse', 'main').trim();
      const P = await S.addProject(repo, 'api', 'true');
      const created = await S.createTask(P.id, { title: 'edit', prompt: 'change a.txt', files: ['a.txt'] });
      const early = await S.post(`/tasks/${created.id}/follow-up`, { instruction: 'too soon' }, { allowFail: true });
      assert.equal(early.status, 409);
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const first = await S.waitStatus(created.id, 'review');
      const branch = first.branch;
      const head = first.head_sha;
      S.fake.state.chatReply = () => PLAN;
      const r = await S.post(`/tasks/${first.id}/follow-up`, { instruction: 'change a.txt again' });
      assert.equal(r.follow_up.iteration, 2);
      assert.equal(r.follow_up.branch, branch);
      const second = await S.waitStatus(first.id, 'review');
      assert.equal(second.iteration, 2);
      assert.equal(second.branch, branch);
      assert.equal(second.status, 'review');
      assert.notEqual(second.head_sha, head);
      assert.equal(git(repo, 'merge-base', '--is-ancestor', head, branch).trim(), '');
      assert.equal(git(repo, 'rev-parse', 'main').trim(), main);
      const body = fs.readFileSync(path.join(first.worktree_path, 'a.txt'), 'utf8');
      assert.equal(body.split('edited by stub-aider').length - 1, 2);
      const events = await S.get(`/tasks/${first.id}/events`);
      assert.equal(events.filter((e) => String(e.message).includes('worktree add -b')).length, 1);
      assert.equal(events.some((e) => e.kind === 'followup' && e.message.includes('change a.txt again')), true);
      const lin = await S.get(`/tasks/${first.id}/lineage`);
      assert.match(JSON.stringify(lin.tree), /"kind":"followup"/);
      assert.match(JSON.stringify(lin.tree), /iteration 2/);
    } finally { await S.stop(); await laya.close(); }
  });

  it('chat starts the same follow-up', async () => {
    const laya = await layaYes();
    const S = await startServer({ env: { ORCH_LAYA_AUTOSTART: '0', ORCH_LAYA_PORT: String(laya.port) } });
    try {
      const repo = makeRepo(path.join(S.work, 'api'), { 'a.txt': 'base\n' });
      const P = await S.addProject(repo, 'api', 'true');
      const created = await S.createTask(P.id, { title: 'edit', prompt: 'change a.txt', files: ['a.txt'] });
      await S.post(`/tasks/${created.id}/approve-start`, {});
      const first = await S.waitStatus(created.id, 'review');
      S.fake.state.chatReply = () => PLAN;
      const c = await S.post('/conversations', { title: 'ops' });
      const ask = await openChat(S, c.id, { content: `on task ${first.id}, change a.txt once more` });
      assert.equal(ask.status, 200);
      const text = ask.events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
      assert.match(text, new RegExp(`iteration 2 approved on ${first.branch}`));
      const second = await S.waitStatus(first.id, 'review');
      assert.equal(second.iteration, 2);
      assert.equal(second.branch, first.branch);
    } finally { await S.stop(); await laya.close(); }
  });
});

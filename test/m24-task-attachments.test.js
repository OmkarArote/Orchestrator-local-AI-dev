'use strict';
// M11: task bundles include derived attachment text. Local engines always. Cloud engines only when to_cloud is set. Files stay out of the worktree.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, makeRepo } = require('./helpers/harness');

function upload(S, body, name) {
  return new Promise((resolve, reject) => {
    const u = new URL(S.url);
    const r = http.request({ host: u.hostname, port: u.port, path: '/api/attachments', method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Orch-Upload': '1', 'X-Filename': encodeURIComponent(name), 'Content-Length': body.length } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(parts).toString())));
    });
    r.on('error', reject); r.end(body);
  });
}

describe('M11 task attachments', () => {
  let S, P;
  before(async () => {
    S = await startServer();
    const repo = makeRepo(path.join(S.work, 'att'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'att', 'test -f hello.txt');
  });
  after(async () => { if (S) await S.stop(); });

  async function bundle(engine, toCloud) {
    const up = await upload(S, Buffer.from('SECRET-TASK-NOTE'), 'note.txt');
    const t = await S.post('/tasks', { project_id: P.id, title: 'att', prompt: 'edit hello', files: ['hello.txt'], engine, attachments: [{ id: up.id, to_cloud: toCloud }] });
    await S.post(`/tasks/${t.id}/approve-start`, {});
    const file = path.join(S.base, 'logs', 'context', `task-${t.id}`, 'CONTEXT.md');
    await S.waitFor(() => fs.existsSync(file), { what: 'context bundle' });
    return { text: fs.readFileSync(file, 'utf8'), detail: await S.get(`/tasks/${t.id}`) };
  }

  it('a local engine receives the derived text and does not mark it sent to Cursor', async () => {
    const r = await bundle('local', false);
    assert.match(r.text, /ATTACHMENTS/);
    assert.match(r.text, /SECRET-TASK-NOTE/);
    assert.equal(r.detail.sent_to_cursor, false);
    assert.equal(fs.existsSync(path.join(S.work, 'att', 'note.txt')), false);
  });

  it('a cursor engine receives the text only when the tick is on', async () => {
    const off = await bundle('cursor', false);
    assert.doesNotMatch(off.text, /SECRET-TASK-NOTE/);
    assert.equal(off.detail.sent_to_cursor, false);
    const on = await bundle('cursor', true);
    assert.match(on.text, /SECRET-TASK-NOTE/);
    assert.equal(on.detail.sent_to_cursor, true);
  });
});

'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

describe('M0 context files, bundle, supervised sessions', () => {
  let S, repo, P;
  before(async () => {
    S = await startServer();
    repo = makeRepo(path.join(S.work, 'ctx'), { 'hello.txt': 'hi\n' });
    P = await S.addProject(repo, 'ctx', 'test -f hello.txt');
  });
  after(async () => { await S.stop(); });

  it('save/read context files; invalid names rejected; preview builds a bundle', async () => {
    await S.post(`/projects/${P.id}/context/save`, { file: 'RULES.md', content: '# Rules\n- Always keep tests green.\n' });
    await S.post(`/projects/${P.id}/context/save`, { file: 'MEMORY.md', content: '# Memory\n\n## 2026-01-01\n- fact one\n' });
    for (const f of ['../x.md', 'FOO.md', 'services/../a.md', '']) {
      assert.equal((await S.post(`/projects/${P.id}/context/save`, { file: f, content: 'x' }, { allowFail: true })).status, 400, f);
    }
    const c = await S.get(`/projects/${P.id}/context`);
    const rules = c.files.find((f) => f.name === 'RULES.md');
    assert.equal(rules.exists, true);
    assert.match(rules.content, /keep tests green/);
    const pv = await S.post(`/projects/${P.id}/context/preview`, { prompt: 'edit hello' });
    assert.match(pv.text, /PROJECT CONTEXT/);
    assert.match(pv.text, /## RULES/);
    assert.match(pv.text, /fact one/);
  });

  it('the context bundle is given to the engine via --read and logged', async () => {
    const t = await S.runToReview(P.id, { title: 'ctx task', prompt: 'edit', files: ['hello.txt'] });
    assert.ok(t.context && t.context.total_chars > 0);
    const ev = await S.get(`/tasks/${t.id}/events`);
    assert.ok(ev.some((e) => e.kind === 'context' && /context bundle/.test(e.message)));
    const lines = fs.readFileSync(S.env.STUB_AIDER_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = lines[lines.length - 1];
    assert.equal(last.readFiles.length, 1);
    assert.match(last.readFiles[0], /CONTEXT\.md$/);
    assert.match(fs.readFileSync(last.readFiles[0], 'utf8'), /Always keep tests green/);
    assert.ok(!last.readFiles[0].startsWith(t.worktree_path));
  });

  it('supervised: open (dry run) -> manual edit -> release -> review, context rule not committed', async () => {
    const t = await S.runToReview(P.id, { title: 'sup', prompt: 'edit', files: ['hello.txt'] });
    const r = await S.post(`/tasks/${t.id}/open-cursor`, { mode: 'ide' });
    assert.equal(r.ok, true);
    assert.match(r.command, /'-n'|'-a' 'Cursor'/);
    assert.ok(r.notes.some((n) => /dry run/.test(n)));
    const rule = path.join(t.worktree_path, '.cursor', 'rules', 'orch-context.mdc');
    assert.ok(fs.existsSync(rule));
    const common = git(t.worktree_path, 'rev-parse', '--git-common-dir').trim();
    assert.match(fs.readFileSync(path.join(path.isAbsolute(common) ? common : path.join(t.worktree_path, common), 'info', 'exclude'), 'utf8'), /orch-context\.mdc/);
    const sup = await S.get(`/tasks/${t.id}`);
    assert.equal(sup.supervised, true);
    assert.equal((await S.post(`/tasks/${t.id}/approve-merge`, {}, { allowFail: true })).status, 409);
    assert.equal((await S.post(`/tasks/${t.id}/open-cursor`, { mode: 'bogus' }, { allowFail: true })).status, 400);
    const term = await S.post(`/tasks/${t.id}/open-cursor`, { mode: 'terminal' });
    assert.match(term.command, /osascript/);
    fs.writeFileSync(path.join(t.worktree_path, 'manual.txt'), 'by hand\n');
    const rel = await S.post(`/tasks/${t.id}/release`, {});
    assert.equal(rel.status, 'review');
    const after = await S.get(`/tasks/${t.id}`);
    assert.equal(after.supervised, false);
    assert.match(git(repo, 'ls-tree', '-r', '--name-only', after.branch), /manual\.txt/);
    assert.doesNotMatch(git(repo, 'ls-tree', '-r', '--name-only', after.branch), /\.cursor/);
    assert.equal((await S.post(`/tasks/${t.id}/release`, {}, { allowFail: true })).status, 409);
  });

  it('open-cursor needs a worktree/valid status', async () => {
    const t = await S.createTask(P.id, { title: 'pend', prompt: 'x' });
    assert.equal((await S.post(`/tasks/${t.id}/open-cursor`, { mode: 'ide' }, { allowFail: true })).status, 409);
  });
});

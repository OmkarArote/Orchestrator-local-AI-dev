'use strict';
// Aider scratch (.aider.tags.cache.v4/ and other .aider* paths) must never be committed.
// A run that only touches those files is skipped, even when the cache file is already tracked.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');

const lastAider = (S) => JSON.parse(fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').pop());
const evText = async (S, id) => (await S.get(`/tasks/${id}/events`)).map((e) => e.message).join('\n');

describe('M31 aider artifacts are not commits', () => {
  let S, P, repo;
  before(async () => {
    S = await startServer({ env: { STUB_WRITE_AIDER_CACHE: '1' } });
    repo = makeRepo(path.join(S.work, 'm31-empty'), {
      'hello.txt': 'hello\n',
      '.aider.tags.cache.v4/cache': 'old\n',
    });
    P = await S.addProject(repo, 'm31-empty', 'true');
  });
  after(async () => { await S.stop(); });

  it('commits the real edit and leaves tracked and untracked aider scratch out of the commit', async () => {
    const t = await S.runToReview(P.id, { title: 'edit', prompt: 'change hello', files: ['hello.txt'], engine: 'local' });
    const names = git(repo, 'diff', '--name-only', `main...${t.branch}`);
    assert.match(names, /hello\.txt/);
    assert.doesNotMatch(names, /\.aider/);
    assert.equal(git(repo, 'show', `${t.branch}:.aider.tags.cache.v4/cache`), 'old\n');
    assert.throws(() => git(repo, 'cat-file', '-e', `${t.branch}:.aider.chat.history.md`));
    const ex = git(t.worktree_path, 'rev-parse', '--git-path', 'info/exclude').trim();
    const excludeFile = path.isAbsolute(ex) ? ex : path.resolve(t.worktree_path, ex);
    assert.match(fs.readFileSync(excludeFile, 'utf8'), /^\.aider\*$/m);
    assert.ok(lastAider(S).aiderignore.split('\n').includes('.aider*'), 'generated aiderignore lists .aider*');
    assert.match(await evText(S, t.id), /worktree exclude: \.aider\*/);
  });

  it('skips the commit when the only change is aider scratch', async () => {
    const t = await S.runToReview(P.id, { title: 'cache only', prompt: 'STUB_NOCHANGE', files: ['hello.txt'], engine: 'local' }, 'failed');
    assert.equal(git(repo, 'rev-list', '--count', `main..${t.branch}`).trim(), '0');
    assert.match(t.result_summary, /no changes|no file changes/);
    assert.match(await evText(S, t.id), /no (real file )?changes to commit/);
    assert.equal(git(repo, 'show', `${t.branch}:.aider.tags.cache.v4/cache`), 'old\n');
  });
});

describe('M50 mode-only and empty-file changes are not commits', () => {
  require('./helpers/temp-env');
  const { onlyEmptyChanges } = require('../lib/runner');
  it('recognises numstat with only 0/0 entries (real git: chmod + empty file) and keeps real or binary edits', () => {
    const r = makeRepo(path.join(require('node:os').tmpdir(), `m50-empty-${process.pid}`), { 'a.sh': 'echo\n', 'b.txt': 'b\n' });
    fs.chmodSync(path.join(r, 'a.sh'), 0o755);
    fs.writeFileSync(path.join(r, 'empty.txt'), '');
    git(r, 'add', '-A');
    const ns = git(r, 'diff', '--cached', '--numstat');
    assert.ok(onlyEmptyChanges(ns), ns);
    fs.writeFileSync(path.join(r, 'b.txt'), 'b2\n'); git(r, 'add', '-A');
    assert.equal(onlyEmptyChanges(git(r, 'diff', '--cached', '--numstat')), false);
    assert.equal(onlyEmptyChanges('-\t-\timg.png\n'), false);
    assert.equal(onlyEmptyChanges(''), false);
  });
});

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

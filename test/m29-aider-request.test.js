'use strict';
require('./helpers/temp-env'); // FIRST: lib/aider-prep loads config in-process
// Swap-relook fixes 3 + 4: local (aider) request hygiene. "Do not open" lists leave the aider message (aider auto-adds every file named in
// it) and go into a generated ignore file; oversized and generated files are ignored; the request size is budgeted before the run and
// while aider auto-adds mentioned files; a small repo map replaces --map-tokens 0; too many pinned files are refused locally.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, makeRepo, git } = require('./helpers/harness');
const prep = require('../lib/aider-prep');

const lastAider = (S) => JSON.parse(fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').pop());
const evText = async (S, id) => (await S.get(`/tasks/${id}/events`)).map((e) => e.message).join('\n');
const argAfter = (rec, flag) => rec.args[rec.args.indexOf(flag) + 1];

describe('M29 stripDoNotOpen (pure)', () => {
  it('moves a "do not open ...:" bullet list into patterns and leaves ordinary sentences and later lists alone', () => {
    const p = 'Goal.\n\nDo not open, summarize, or search these files:\n- package-lock.json, node_modules, LICENSE\n- .github/workflows, ecosystem*.cjs\n\nNever add tests you cannot run.\n1. src/app.js - start here\nDo not start there.';
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'm29-'));
    fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'LICENSE'), 'x');
    const r = prep.stripDoNotOpen(p, { root });
    assert.deepEqual(r.patterns, ['package-lock.json', 'node_modules/', 'LICENSE', '.github/workflows', 'ecosystem*.cjs']);
    assert.doesNotMatch(r.text, /package-lock\.json/);
    assert.match(r.text, /Never add tests you cannot run\.\n1\. src\/app\.js/);
    assert.match(r.text, /Do not start there\./);
    assert.equal(r.removed, 3);
    assert.deepEqual(prep.stripDoNotOpen('Do not read docs/a.md or README.md', { prefix: 'svc' }).patterns, ['svc/docs/a.md', 'README.md']);
    assert.equal(prep.stripDoNotOpen('Do not touch unrelated code.').removed, 0);
  });
});

describe('M29 aider request (server)', () => {
  let S, P, repo;
  before(async () => {
    S = await startServer({ env: { ORCH_LOCAL_MAX_REQUEST_CHARS: '60000' } });
    repo = makeRepo(path.join(S.work, 'm29'), {
      'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n', 'e.txt': 'e\n', 'f.txt': 'f\n', 'package-lock.json': '{}\n', 'README.md': '# r\n',
      'big.json': 'x'.repeat(70 * 1024), 'm1.txt': 'm'.repeat(40 * 1024), 'm2.txt': 'n'.repeat(40 * 1024),
    });
    P = await S.addProject(repo, 'm29', 'true');
  });
  after(async () => { await S.stop(); });

  it('do-not-open list: stripped from the message, in the ignore file with defaults + oversized files; pinned files re-allowed; repo map 512', async () => {
    const t = await S.runToReview(P.id, { title: 'x', prompt: 'Change a.txt.\nDo not open these files:\n- package-lock.json, README.md\n', files: ['a.txt', 'README.md'], engine: 'local' });
    const rec = lastAider(S);
    assert.doesNotMatch(rec.message, /package-lock/); assert.match(rec.message, /excluded from this run by the aider ignore file/);
    assert.equal(argAfter(rec, '--map-tokens'), '512');
    const ig = rec.aiderignore;
    for (const l of ['package-lock.json', 'README*', '*.map', '.env*', '/big.json', '/**', '!/a.txt', '!/README.md']) assert.ok(ig.split('\n').includes(l), `${l} in ignore file`);
    assert.match(await evText(S, t.id), /pin-only run/);
    assert.ok(!argAfter(rec, '--aiderignore').startsWith(t.worktree_path), 'ignore file lives outside the worktree');
    assert.match(await evText(S, t.id), /moved a "do not open" list out of the message \(2 path\(s\)/);
  });

  it('no pinned files: 1024-token repo map and a clear warning', async () => {
    const t = await S.runToReview(P.id, { title: 'y', prompt: 'edit something', engine: 'local' });
    assert.equal(argAfter(lastAider(S), '--map-tokens'), '1024');
    assert.match(await evText(S, t.id), /no files pinned - the model only sees a 1024-token repo map/);
  });

  it('too many pinned files: refused locally; engine=auto goes to the (approval-gated) escalation', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    const n = fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').length;
    const t = await S.runToReview(P.id, { title: 'z', prompt: 'edit', files, engine: 'local' }, 'failed');
    assert.match(t.result_summary, /aider: REFUSED \(4 pinned files > ORCH_LOCAL_MAX_FILES=3/);
    const t2 = await S.runToReview(P.id, { title: 'z2', prompt: 'edit', files, engine: 'auto', allow_escalation: true }, 'awaiting_escalation');
    assert.equal(t2.escalation, 'pending');
    assert.equal(fs.readFileSync(path.join(S.base, 'stub-aider.log'), 'utf8').trim().split('\n').length, n, 'aider never started');
  });

  it('oversized request: refused before the run; auto-added mentions over budget: aider is stopped', async () => {
    const before = git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain');
    const t = await S.runToReview(P.id, { title: 'big', prompt: 'edit', files: ['big.json'], engine: 'local' }, 'failed');
    assert.match(t.result_summary, /aider: REFUSED \(request would be ~\d+ chars .* > ORCH_LOCAL_MAX_REQUEST_CHARS=60000/);
    const t2 = await S.runToReview(P.id, { title: 'mention', prompt: 'STUB_PRINT<<m1.txt|m2.txt>> STUB_SLOW', files: ['a.txt'], engine: 'local' }, 'failed');
    assert.match(t2.result_summary, /aider: STOPPED \(request too large: aider auto-added 2 mentioned file\(s\) \(81920 bytes, last m2\.txt\)/);
    assert.equal(git(repo, 'rev-parse', 'HEAD') + git(repo, 'status', '--porcelain'), before, 'main checkout untouched');
  });
});

describe('M50 pin-only ignore file (pure)', () => {
  const prep = require('../lib/aider-prep');
  it('ignores everything but the pinned files when pinOnly is set, and only then', () => {
    const on = prep.ignoreFileText({ wt: '/nonexistent', pinned: ['src/a.js'], pinOnly: true, maxFileBytes: 1 }).split('\n');
    assert.ok(on.indexOf('/**') > 0 && on.indexOf('!/src/a.js') > on.indexOf('/**'), 'catch-all before the pinned re-allow');
    const off = prep.ignoreFileText({ wt: '/nonexistent', pinned: ['src/a.js'], maxFileBytes: 1 }).split('\n');
    assert.ok(!off.includes('/**'));
    const none = prep.ignoreFileText({ wt: '/nonexistent', pinned: [], pinOnly: true, maxFileBytes: 1 }).split('\n');
    assert.ok(!none.includes('/**'), 'no pinned files: the repo map stays usable');
  });
});

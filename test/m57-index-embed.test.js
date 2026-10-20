'use strict';
// M5: embeddings are an extra ranking signal. The index still builds when the embedder is missing or throws.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-emb-')));
process.env.ORCH_DB = path.join(dir, 't.db');
process.env.ORCH_LOG_DIR = path.join(dir, 'logs');
process.env.ORCH_WORKTREES = path.join(dir, 'wt');
process.env.ORCH_CONTEXT_DIR = path.join(dir, 'ctx');
delete process.env.ORCH_ALLOW_DEFAULT_DB;
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { makeRepo, git } = require('./helpers/harness');
const { rankIndex } = require('../lib/flow/rank');
const { cosine } = require('../lib/index/embed');

const HIDDEN = 'src/hidden/note.js';
const BOOK = 'src/services/book.service.js';

function unit() { return [1, 0, 0]; }

describe('embedding rank', () => {
  it('cosine is 1 for the same vector and 0 for an orthogonal one', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1], [1, 0]), 0);
  });

  it('a file with no lexical hit is selected from a strong embedding', () => {
    const r = rankIndex({
      files: [{ path: HIDDEN }, { path: BOOK }],
      symbols: [{ path: BOOK, name: 'editBook', kind: 'function', line: 1 }],
      modules: [],
      prompt: 'unrelated prompt about nothing in these names\n',
      vectors: { [HIDDEN]: 1 },
    });
    assert.ok(r.files.some((f) => f.path === HIDDEN));
    assert.equal(r.files.some((f) => f.path === BOOK), false);
  });

  it('lexical ranking still selects the named file when there is no vector', () => {
    const r = rankIndex({
      files: [{ path: HIDDEN }, { path: BOOK }],
      symbols: [{ path: BOOK, name: 'editBook', kind: 'function', line: 1 }],
      modules: [{ path: 'src/services', summary: 'book edit' }],
      prompt: 'Change editBook in the book service.\n',
      vectors: null,
    });
    assert.ok(r.files.some((f) => f.path === BOOK));
    assert.equal(r.files.some((f) => f.path === HIDDEN), false);
  });
});

describe('embedding storage', () => {
  let repoDir, store, build, repo, project, service;
  before(() => {
    store = require('../lib/db');
    build = require('../lib/index/build');
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-emb-repo-')));
    repo = makeRepo(path.join(repoDir, 'api'), { 'src/services/book.service.js': 'export function editBook() { return 1; }\n' });
    store.addRoot(repoDir, 'emb');
    const made = store.createProjectWithService(
      { name: 'books', slug: 'books', description: '', path: '', default_branch: '' },
      { name: 'api', path: '.', local_path: repo, default_branch: 'main', status: 'active', origin: 'existing' },
    );
    project = store.getProject(made.projectId);
    service = store.getService(made.serviceId);
  });
  after(() => { for (const d of [dir, repoDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

  const summarize = async () => ({ text: 'book edit', model: 'fake' });
  const embedder = async (texts) => texts.map(() => unit());

  it('stores a vector and keeps it when the hash has not changed', async () => {
    const view = await build.rebuild(service, project, { summarizer: summarize, embedder });
    assert.equal(view.embedded.error, undefined);
    assert.ok(view.embedded.embedded >= 1);
    const row = store.db.prepare('SELECT vector, content_hash FROM index_embeddings WHERE service_id = ? AND kind = ? AND ref = ?').get(service.id, 'file', BOOK);
    assert.deepEqual(JSON.parse(row.vector), unit());
    const again = await build.rebuild(service, project, { summarizer: summarize, embedder });
    assert.equal(again.embedded.embedded, 0);
    const { scoresFor } = require('../lib/index/embed');
    const scores = await scoresFor(service.id, 'edit the book', { embedder });
    assert.equal(scores[BOOK], 1);
  });

  it('a throwing embedder leaves the structural index in place', async () => {
    fs.appendFileSync(path.join(repo, BOOK), 'export const EXTRA = 1;\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'extra');
    const view = await build.rebuild(service, project, { summarizer: summarize, embedder: async () => { throw new Error('embed down'); } });
    assert.equal(view.embedded.error, 'embed down');
    assert.ok(view.files.some((f) => f.path === BOOK));
    assert.equal(view.stale, false);
  });
});

describe('installed embedding model', () => {
  let listed = '';
  try { listed = execFileSync('ollama', ['list'], { encoding: 'utf8' }); } catch { listed = ''; }
  const has = /nomic-embed-text/.test(listed);

  it('embeds one string through Ollama when nomic-embed-text is installed', { skip: has ? false : 'nomic-embed-text is not installed' }, async () => {
    const res = await fetch('http://127.0.0.1:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: ['visit check-out outcome'] }),
    });
    const body = await res.json();
    assert.equal(res.ok, true);
    assert.ok(Array.isArray(body.embeddings) && body.embeddings[0].length > 8);
  });
});

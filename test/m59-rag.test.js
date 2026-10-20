'use strict';
// RAG chunks (schema v10). ORCH_RAG=1 stores symbol/window chunks and can rank them. Off leaves the reader alone.
require('./helpers/temp-env');
process.env.ORCH_RAG = '1';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const { startServer, makeRepo, git, ROOT } = require('./helpers/harness');
const { chunkText } = require('../lib/rag/chunk');
const { rankChunks } = require('../lib/rag/rank');
const { fill } = require('../lib/rag/context');
const { decode } = require('../lib/rag/vectors');
const { buildLineage } = require('../lib/flow/lineage');

const SERVICE = 'src/visit.service.js';
const OTHER = 'src/book.service.js';

function longFn() {
  let body = 'export function longOne() {\n';
  for (let i = 0; i < 80; i++) body += `  const a${i} = ${i};\n`;
  body += '}\n';
  return body;
}

describe('rag chunk and rank', () => {
  it('chunks a symbol and caps it at the window, and windows a file with no symbols', () => {
    const code = 'export class VisitService {\n  checkOut(dto) {\n    return dto;\n  }\n}\n';
    const chunks = chunkText(code, SERVICE);
    assert.ok(chunks.some((c) => c.kind === 'service' && c.name === 'VisitService'));
    assert.ok(chunks.some((c) => c.kind === 'function' && c.name === 'checkOut' && c.text.includes('return dto')));
    const long = chunkText(longFn(), 'src/long.js');
    const fn = long.find((c) => c.name === 'longOne');
    assert.ok(fn);
    assert.equal(fn.end_line - fn.start_line + 1, 60);
    const plain = Array.from({ length: 90 }, (_, i) => `plain line ${i}`).join('\n');
    const windows = chunkText(plain, 'notes.txt');
    assert.deepEqual(windows.map((c) => c.kind), ['window', 'window']);
    assert.equal(windows[0].end_line - windows[0].start_line + 1, 60);
    assert.equal(windows[1].start_line, 61);
  });

  it('ranks a named file by the import graph, and stops at the token budget', () => {
    const chunks = [
      { path: 'src/a.js', chunk_key: 'function:alpha:1', kind: 'function', name: 'alpha', start_line: 1, end_line: 2, text: 'export function alphaWidget() { return 1; }' },
      { path: 'src/b.js', chunk_key: 'function:beta:1', kind: 'function', name: 'beta', start_line: 1, end_line: 2, text: 'export function betaOther() { return 2; }' },
    ];
    const edges = [{ from: 'src/a.js', to: 'src/b.js' }];
    const files = [{ path: 'src/a.js' }, { path: 'src/b.js' }];
    const byGraph = rankChunks({ chunks, prompt: 'edit src/a.js only', edges, files, weights: { bm25: 0, vector: 0, graph: 1 } });
    assert.equal(byGraph[0].path, 'src/a.js');
    assert.equal(byGraph[0].graph, 1);
    assert.equal(byGraph[1].graph, 0.6);
    const byWord = rankChunks({ chunks, prompt: 'change alphaWidget', edges, files, weights: { bm25: 1, vector: 0, graph: 0 } });
    assert.equal(byWord[0].path, 'src/a.js');
    assert.match(byWord[0].why, /bm25/);
    const packed = fill(byWord, 2);
    assert.equal(packed.chunks.length, 1);
    assert.ok(packed.chars <= 8);
    assert.ok(packed.chunks[0].text.length < byWord[0].text.length);
  });

  it('shows included chunks on the lineage', () => {
    const tree = buildLineage({
      task: { id: 1, title: 't', status: 'running' },
      events: [{ kind: 'retrieval', message: JSON.stringify({ phase: 'retrieval', status: 'ok', reason: 'vectors skipped', chunks: [{ path: 'src/a.js', start: 1, end: 4, why: 'bm25 1' }], tokens: 12, budget: 100 }) }],
    });
    const node = tree.tree.children[0].children.find((n) => n.kind === 'retrieval');
    assert.equal(node.reason, 'vectors skipped');
    assert.match(node.note, /src\/a\.js:1-4/);
  });
});

describe('rag store', () => {
  let dir, repoDir, store, build, repo, project, service;
  const calls = [];
  const embedder = async (texts) => {
    calls.push(texts.length);
    return texts.map(() => [1, 0, 0]);
  };
  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rag-')));
    process.env.ORCH_DB = path.join(dir, 't.db');
    process.env.ORCH_LOG_DIR = path.join(dir, 'logs');
    process.env.ORCH_WORKTREES = path.join(dir, 'wt');
    process.env.ORCH_CONTEXT_DIR = path.join(dir, 'ctx');
    delete process.env.ORCH_ALLOW_DEFAULT_DB;
    delete require.cache[require.resolve('../lib/db')];
    delete require.cache[require.resolve('../lib/index/build')];
    delete require.cache[require.resolve('../lib/rag/store')];
    store = require('../lib/db');
    build = require('../lib/index/build');
    repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rag-repo-')));
    const plain = Array.from({ length: 90 }, (_, i) => `plain line ${i}`).join('\n') + '\n';
    repo = makeRepo(path.join(repoDir, 'api'), {
      'package.json': '{}\n',
      [SERVICE]: 'export class VisitService {\n  checkOut(dto) {\n    return dto;\n  }\n}\n',
      [OTHER]: 'export function editBook() { return 1; }\n',
      'notes.txt': plain,
    });
    store.addRoot(repoDir, 'rag');
    const made = store.createProjectWithService(
      { name: 'pulse', slug: 'pulse', description: '', path: '', default_branch: '' },
      { name: 'api', path: '.', local_path: repo, default_branch: 'main', status: 'active', origin: 'existing' },
    );
    project = store.getProject(made.projectId);
    service = store.getService(made.serviceId);
  });
  after(() => { for (const d of [dir, repoDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } });

  it('stores chunks and a float32 blob, and a second rebuild embeds nothing', async () => {
    calls.length = 0;
    const view = await build.rebuild(service, project, { summaries: false, embedder });
    assert.equal(store.schemaVersion(), 10);
    const chunks = store.db.prepare('SELECT path, kind, name, text FROM index_chunks WHERE service_id = ?').all(service.id);
    assert.ok(chunks.some((c) => c.path === SERVICE && c.name === 'checkOut'));
    assert.ok(chunks.some((c) => c.path === 'notes.txt' && c.kind === 'window'));
    const blob = store.db.prepare('SELECT vector, dim FROM index_chunk_vectors WHERE service_id = ? LIMIT 1').get(service.id);
    assert.equal(blob.dim, 3);
    assert.deepEqual(decode(blob.vector), [1, 0, 0]);
    assert.ok(calls.length >= 1);
    const before = calls.length;
    fs.appendFileSync(path.join(repo, OTHER), '\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'touch book');
    const again = await build.rebuild(service, project, { summaries: false, embedder });
    assert.deepEqual(again.changed, [OTHER]);
    const bookChunks = store.db.prepare('SELECT file_hash FROM index_chunks WHERE service_id = ? AND path = ?').all(service.id, OTHER);
    assert.ok(bookChunks.length >= 1);
    const visitHash = store.db.prepare('SELECT file_hash FROM index_chunks WHERE service_id = ? AND path = ?').get(service.id, SERVICE).file_hash;
    assert.equal(visitHash, view.files.find((f) => f.path === SERVICE).hash);
    assert.ok(calls.length > before, 'the changed file is embedded');
    const mid = calls.length;
    await build.rebuild(service, project, { summaries: false, embedder });
    assert.equal(calls.length, mid, 'unchanged hashes do not re-embed');
    assert.equal(view.chunks.skipped, false);
  });
});

describe('rag flag off', () => {
  it('a rebuild without ORCH_RAG writes no chunks', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rag-off-')));
    const db = path.join(dir, 't.db');
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rag-off-repo-')));
    const repo = makeRepo(path.join(repoDir, 'api'), { 'a.js': 'export function hi() { return 1; }\n' });
    const env = { ...process.env, ORCH_DB: db, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ORCH_CONTEXT_DIR: path.join(dir, 'ctx') };
    delete env.ORCH_RAG;
    delete env.ORCH_ALLOW_DEFAULT_DB;
    const script = `
      const store = require('./lib/db');
      const build = require('./lib/index/build');
      const cfg = require('./config');
      (async () => {
        if (cfg.RAG) throw new Error('RAG should be off');
        store.addRoot(${JSON.stringify(repoDir)}, 'off');
        const made = store.createProjectWithService(
          { name: 'p', slug: 'p', description: '', path: '', default_branch: '' },
          { name: 'api', path: '.', local_path: ${JSON.stringify(repo)}, default_branch: 'main', status: 'active', origin: 'existing' },
        );
        const project = store.getProject(made.projectId);
        const service = store.getService(made.serviceId);
        const view = await build.rebuild(service, project, { summaries: false, embedder: async () => { throw new Error('no embed'); } });
        const n = store.db.prepare('SELECT COUNT(*) c FROM index_chunks').get().c;
        console.log(JSON.stringify({ n, chunks: view.chunks, files: view.file_count }));
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    try {
      const out = execFileSync(process.execPath, ['--no-warnings', '-e', script], { cwd: ROOT, encoding: 'utf8', env });
      const row = JSON.parse(out.trim().split('\n').filter((l) => !l.startsWith('[db]')).pop());
      assert.equal(row.n, 0);
      assert.equal(row.chunks, null);
      assert.ok(row.files >= 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('rag migration v10', () => {
  it('v9 opens as v10 and the failure hook rolls back', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v10-')));
    const db = path.join(dir, 'up.db');
    const envFor = (extra = {}) => ({ ...process.env, ORCH_DB: db, ORCH_LOG_DIR: path.join(dir, 'logs'), ORCH_WORKTREES: path.join(dir, 'wt'), ORCH_CONTEXT_DIR: path.join(dir, 'ctx'), ...extra });
    delete envFor().ORCH_RAG;
    const open = (extra) => execFileSync(process.execPath, ['--no-warnings', '-e', "const s=require('./lib/db'); console.log(JSON.stringify({v:s.schemaVersion()}))"], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: envFor(extra) });
    try {
      assert.equal(JSON.parse(open().trim().split('\n').filter((l) => !l.startsWith('[db]')).pop()).v, 10);
      const w = new DatabaseSync(db);
      w.exec('DROP TABLE index_chunk_vectors');
      w.exec('DROP TABLE index_chunks');
      w.exec('PRAGMA user_version = 9');
      w.close();
      assert.equal(JSON.parse(open().trim().split('\n').filter((l) => !l.startsWith('[db]')).pop()).v, 10);
      const d = new DatabaseSync(db, { readOnly: true });
      assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('index_chunks','index_chunk_vectors')").get().c, 2);
      d.close();
      assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('pre-v10-migration-')).length, 1);
      const d2 = new DatabaseSync(db);
      d2.exec('DROP TABLE index_chunk_vectors');
      d2.exec('DROP TABLE index_chunks');
      d2.exec('PRAGMA user_version = 9');
      d2.close();
      assert.throws(() => open({ ORCH_TEST_FAIL_MIGRATION_V10: '1' }), (e) => /v10 migration failed and was rolled back/.test(String(e.stderr)));
      const left = new DatabaseSync(db, { readOnly: true });
      assert.equal(left.prepare('SELECT user_version v FROM pragma_user_version').get().v, 9);
      assert.equal(left.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'index_chunks'").get().c, 0);
      left.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('rag task retrieval', () => {
  let S;
  before(async () => { S = await startServer({ env: { ORCH_FLOW: 'v2', ORCH_RAG: '1' } }); });
  after(async () => { await S.stop(); });

  it('a v2 task logs the chunks it included', async () => {
    const repo = makeRepo(path.join(S.work, 'api'), {
      [SERVICE]: 'export class VisitService {\n  checkOut(dto) {\n    return dto;\n  }\n}\n',
      [OTHER]: 'export function editBook() { return 1; }\n',
    });
    const { id } = await S.addProject(repo, 'pulse', 'true');
    const task = await S.runToReview(id, { title: 'checkout', prompt: 'Update checkOut in src/visit.service.js so it keeps the dto.', engine: 'auto', flow: 'v2' });
    assert.equal(task.status, 'review');
    const lin = await S.get(`/tasks/${task.id}/lineage`);
    const flat = JSON.stringify(lin.tree);
    assert.match(flat, /retrieval/);
    assert.match(flat, /visit\.service\.js/);
  });
});

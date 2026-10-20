'use strict';
// M6: read-only stdio MCP over one service index. No rebuild and no model call.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-')));
process.env.ORCH_DB = path.join(dir, 't.db');
process.env.ORCH_LOG_DIR = path.join(dir, 'logs');
process.env.ORCH_WORKTREES = path.join(dir, 'wt');
process.env.ORCH_CONTEXT_DIR = path.join(dir, 'ctx');
delete process.env.ORCH_ALLOW_DEFAULT_DB;
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers/harness');

const BOOK = 'src/services/book.service.js';
const CONST = 'src/constants/book.js';

function rpc(child, msg) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(msg));
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { child.stdout.off('data', onData); reject(new Error(`mcp timeout for ${msg.method}`)); }, 5000);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, headerEnd).toString('utf8'));
      if (!m) return;
      const start = headerEnd + 4;
      const len = Number(m[1]);
      if (buf.length < start + len) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(JSON.parse(buf.slice(start, start + len).toString('utf8')));
    }
    child.stdout.on('data', onData);
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  });
}

function text(reply) {
  return JSON.parse(reply.result.content[0].text);
}

describe('index MCP', () => {
  let store, child, serviceId;
  before(async () => {
    store = require('../lib/db');
    const build = require('../lib/index/build');
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-repo-')));
    const repo = makeRepo(path.join(repoDir, 'api'), {
      [CONST]: 'export const BOOK = 1;\n',
      [BOOK]: 'import { BOOK } from "../constants/book";\nexport function editBook() { return BOOK; }\n',
    });
    store.addRoot(repoDir, 'mcp');
    const made = store.createProjectWithService(
      { name: 'books', slug: 'books', description: '', path: '', default_branch: '' },
      { name: 'api', path: '.', local_path: repo, default_branch: 'main', status: 'active', origin: 'existing' },
    );
    serviceId = made.serviceId;
    await build.rebuild(store.getService(serviceId), store.getProject(made.projectId), {
      summarizer: async () => ({ text: 'book edit', model: 'fake' }),
      embedder: async () => null,
    });
    child = spawn(process.execPath, [path.join(ROOT, 'bin', 'index-mcp.js')], {
      env: { ...process.env, ORCH_DB: process.env.ORCH_DB, ORCH_MCP_SERVICE_ID: String(serviceId), NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (c) => { child.err = (child.err || '') + c.toString(); });
  });
  after(() => { if (child) child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  it('lists the four read-only tools and answers from the index', async () => {
    const filesBefore = store.db.prepare('SELECT COUNT(*) c FROM index_files').get().c;
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
    assert.equal(init.result.serverInfo.name, 'orch-index');
    const listed = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), ['get_file_summary', 'get_neighbours', 'get_symbols', 'search']);
    const found = text(await rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { q: 'editBook' } } }));
    assert.ok(found.hits.some((h) => h.name === 'editBook' && h.path === BOOK));
    const symbols = text(await rpc(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_symbols', arguments: { path: BOOK } } }));
    assert.ok(symbols.some((s) => s.name === 'editBook'));
    const neighbours = text(await rpc(child, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_neighbours', arguments: { path: BOOK } } }));
    assert.ok(neighbours.neighbours.includes(CONST));
    const summary = text(await rpc(child, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_file_summary', arguments: { path: BOOK } } }));
    assert.equal(summary.summary, 'book edit');
    assert.equal(store.db.prepare('SELECT COUNT(*) c FROM index_files').get().c, filesBefore);
    assert.equal(child.err || '', '');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'index', 'mcp.js'), 'utf8');
    assert.equal(/\b(INSERT|UPDATE|DELETE)\b/.test(src), false);
    assert.equal(src.includes("require('../ollama')") || src.includes('new DatabaseSync('), false);
  });
});

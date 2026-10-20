'use strict';
// Read-only MCP server for one service's project index. Selects only. No model calls.
// The database is the shared lib/db.js connection, so this file does not open a second one.

const TOOLS = [
  { name: 'search', description: 'Search indexed symbol names, file paths and folder summaries.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'get_file_summary', description: 'Return the stored folder summary for a file path.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'get_symbols', description: 'Return symbols extracted for one indexed file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'get_neighbours', description: 'Return import-graph neighbours of one indexed file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function moduleOf(file) {
  return String(file || '').includes('/') ? String(file).split('/').slice(0, -1).join('/') : '(root)';
}

function like(q) {
  return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function callTool(db, serviceId, name, args) {
  const a = args || {};
  if (name === 'search') {
    const query = String(a.q || '').trim().slice(0, 200);
    if (!query) return { query, hits: [] };
    const pat = like(query);
    const symbols = db.prepare(`SELECT path, name, kind, line FROM index_symbols WHERE service_id = ? AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ORDER BY path, line LIMIT 40`).all(serviceId, pat, pat);
    const files = db.prepare(`SELECT path FROM index_files WHERE service_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`).all(serviceId, pat);
    const mods = db.prepare(`SELECT module_path, summary FROM index_summaries WHERE service_id = ? AND (module_path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\') ORDER BY module_path LIMIT 20`).all(serviceId, pat, pat);
    const hits = [
      ...symbols.map((s) => ({ path: s.path, name: s.name, kind: s.kind, line: s.line, match: 'symbol' })),
      ...files.map((f) => ({ path: f.path, name: f.path, kind: 'file', line: null, match: 'path' })),
      ...mods.map((m) => ({ path: m.module_path, name: m.module_path, kind: 'module', line: null, match: 'summary' })),
    ];
    return { query, hits: hits.slice(0, 50) };
  }
  if (name === 'get_file_summary') {
    const file = String(a.path || '');
    const module_path = moduleOf(file);
    const row = db.prepare('SELECT module_path, summary, model FROM index_summaries WHERE service_id = ? AND module_path = ?').get(serviceId, module_path);
    return row || { module_path, summary: null, model: null };
  }
  if (name === 'get_symbols') {
    return db.prepare('SELECT name, kind, line FROM index_symbols WHERE service_id = ? AND path = ? ORDER BY line, name').all(serviceId, String(a.path || ''));
  }
  if (name === 'get_neighbours') {
    const file = String(a.path || '');
    const edges = db.prepare('SELECT from_path, to_path FROM index_edges WHERE service_id = ? AND (from_path = ? OR to_path = ?) ORDER BY from_path, to_path').all(serviceId, file, file);
    const neighbours = [];
    for (const e of edges) {
      const other = e.from_path === file ? e.to_path : e.from_path;
      if (other && !neighbours.includes(other)) neighbours.push(other);
    }
    return { path: file, neighbours };
  }
  const err = new Error(`unknown tool ${name}`);
  err.code = -32602;
  throw err;
}

function handle(db, serviceId, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  if (msg.id == null) return null;
  try {
    if (msg.method === 'initialize') {
      return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'orch-index', version: '1' } } };
    }
    if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
    if (msg.method === 'tools/call') {
      const params = msg.params || {};
      const data = callTool(db, serviceId, params.name, params.arguments);
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } };
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
  } catch (e) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32000, message: e.message } };
  }
}

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'), body]);
}

function attach(db, serviceId, input, output) {
  let buf = Buffer.alloc(0);
  input.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { output.write(frame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'missing Content-Length' } })); buf = buf.slice(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const raw = buf.slice(start, start + len).toString('utf8');
      buf = buf.slice(start + len);
      let msg;
      try { msg = JSON.parse(raw); }
      catch { output.write(frame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); continue; }
      const reply = handle(db, serviceId, msg);
      if (reply) output.write(frame(reply));
    }
  });
}

function main() {
  const serviceId = Number(process.env.ORCH_MCP_SERVICE_ID);
  if (!process.env.ORCH_DB || !Number.isInteger(serviceId) || serviceId < 1) {
    process.stderr.write('ORCH_DB and ORCH_MCP_SERVICE_ID are required\n');
    process.exit(1);
  }
  const db = require('../db').db;
  attach(db, serviceId, process.stdin, process.stdout);
}

module.exports = { TOOLS, callTool, handle, frame, attach, main };

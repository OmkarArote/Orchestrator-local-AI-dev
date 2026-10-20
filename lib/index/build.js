'use strict';
// Per-service project index. Reads the default-branch commit through git (lib/proc.js), never the working tree.
// One snapshot per service. A rebuild rewrites only files whose blob hash changed.
const crypto = require('node:crypto');
const path = require('node:path');
const { git } = require('../proc');
const reader = require('../repo-reader');
const context = require('../context');
const { compileIgnore, isIgnored } = require('./ignore');
const { extractSymbols, extractImports, resolveImport, detectFramework, isCode } = require('./extract');

const MAX_FILES = 4000;
const MAX_PARSE = 256 * 1024;
const ARCH_NAMES = [...context.TOP_FILES, ...context.BRIEF_FILES];

function store() { return require('../db'); }
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

async function show(repoRoot, sha, rel) {
  const r = await git(repoRoot, ['show', `${sha}:${rel}`], { maxBuffer: MAX_PARSE + 65536, timeoutMs: 15000 });
  if (r.code !== 0) return null;
  if (r.out.includes('\0')) return null;
  return r.out.length > MAX_PARSE ? null : r.out;
}

/** Files of the pinned commit that the index is allowed to keep. */
async function listFiles(opened) {
  const r = opened;
  const res = await git(r.repoRoot, ['ls-tree', '-r', '-z', '--long', r.sha, ...(r.sub ? ['--', `${r.sub}/`] : [])], { maxBuffer: 64 * 1024 * 1024, timeoutMs: 20000 });
  if (res.code !== 0) throw new Error(`could not list ${r.branch}: ${res.err || res.error || 'git ls-tree failed'}`);
  const ignoreText = [];
  for (const name of ['.gitignore', '.aiderignore', r.sub ? `${r.sub}/.gitignore` : null, r.sub ? `${r.sub}/.aiderignore` : null].filter(Boolean)) {
    const body = await show(r.repoRoot, r.sha, name);
    if (body) ignoreText.push(body);
  }
  const rules = compileIgnore(ignoreText.join('\n'));
  const files = [];
  let truncated = false;
  for (const rec of res.out.split('\0')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const [, mode, type, blob, size, full] = m;
    if (type !== 'blob' || mode === '120000') continue;
    const rel = r.sub ? (full.startsWith(`${r.sub}/`) ? full.slice(r.sub.length + 1) : null) : full;
    if (!rel) continue;
    if (reader.denyReason(full) || reader.denyReason(rel) || isIgnored(rel, rules)) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    const ext = path.posix.basename(rel).includes('.') ? path.posix.basename(rel).split('.').pop().toLowerCase() : '';
    files.push({ path: rel, size: Number(size) || 0, hash: blob, language: ext || null });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated };
}

function moduleOf(filePath) {
  const dir = path.posix.dirname(filePath);
  return dir === '.' ? '(root)' : dir;
}

function moduleHash(files, symbols) {
  const body = [
    ...files.map((f) => `${f.path}:${f.hash}`),
    ...symbols.map((s) => `${s.path}:${s.kind}:${s.name}`),
  ].sort();
  return sha256(body.join('\n'));
}

async function defaultSummarizer({ modulePath, symbols, files }) {
  const ollama = require('../ollama');
  let model = 'ornith:9b';
  try {
    const e = require('../models').effective('coding');
    if (e && e.model) model = e.model;
  } catch { /* coding role is optional */ }
  const names = symbols.map((s) => s.name).slice(0, 40).join(', ');
  const prompt = `Write one sentence on what the folder ${modulePath} is for. Symbols: ${names || files.map((f) => f.path).join(', ') || 'none'}. No preamble.`;
  const r = await ollama.chat('ollama', {
    model, stream: false, think: false,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.1, num_predict: 80, num_ctx: 4096 },
  }, { timeoutMs: 20000 });
  if (!r.ok || !String(r.content || '').trim()) throw new Error(r.message || 'no summary');
  return { text: String(r.content).trim().slice(0, 400), model };
}

function architectureOf(project) {
  if (!project) return [];
  return ARCH_NAMES.map((name) => ({ name, present: context.read(project, name) != null }));
}

function readRows(serviceId) {
  const d = store().db;
  const meta = d.prepare('SELECT * FROM index_meta WHERE service_id = ?').get(serviceId) || null;
  const files = d.prepare('SELECT id, path, size, hash, language, built_at FROM index_files WHERE service_id = ? ORDER BY path').all(serviceId);
  const symbols = d.prepare('SELECT id, path, name, kind, line FROM index_symbols WHERE service_id = ? ORDER BY path, line, name').all(serviceId);
  const edges = d.prepare('SELECT id, from_path, to_path FROM index_edges WHERE service_id = ? ORDER BY from_path, to_path').all(serviceId);
  const summaries = d.prepare('SELECT module_path, content_hash, summary, model, built_at FROM index_summaries WHERE service_id = ? ORDER BY module_path').all(serviceId);
  return { meta, files, symbols, edges, summaries };
}

function viewOf(service, project, head, rows) {
  const meta = rows.meta;
  let framework = { framework: 'other', dependencies: [], scripts: [] };
  if (meta) { try { framework = JSON.parse(meta.framework_json || '{}'); } catch { /* keep default */ } }
  const byMod = new Map();
  for (const f of rows.files) {
    const key = moduleOf(f.path);
    if (!byMod.has(key)) byMod.set(key, { path: key, files: [], symbols: [] });
    byMod.get(key).files.push(f);
  }
  for (const s of rows.symbols) {
    const key = moduleOf(s.path);
    if (!byMod.has(key)) byMod.set(key, { path: key, files: [], symbols: [] });
    byMod.get(key).symbols.push(s);
  }
  const sumBy = new Map(rows.summaries.map((s) => [s.module_path, s]));
  const modules = [...byMod.values()].sort((a, b) => a.path.localeCompare(b.path)).map((m) => {
    const hash = moduleHash(m.files, m.symbols);
    const saved = sumBy.get(m.path);
    return {
      path: m.path, files: m.files.length, symbols: m.symbols.length,
      summary: saved ? saved.summary : null, model: saved ? saved.model : null,
      summary_stale: !saved || saved.content_hash !== hash,
    };
  });
  return {
    service_id: service.id, built: !!meta, commit_sha: meta ? meta.commit_sha : null, head_sha: head,
    stale: !meta || meta.commit_sha !== head, built_at: meta ? meta.built_at : null,
    file_count: rows.files.length, framework, truncated: false,
    files: rows.files.map(({ path: p, size, hash, language, built_at }) => ({ path: p, size, hash, language, built_at })),
    symbols: rows.symbols.map(({ path: p, name, kind, line }) => ({ path: p, name, kind, line })),
    edges: rows.edges.map(({ from_path, to_path }) => ({ from: from_path, to: to_path })),
    modules, architecture: architectureOf(project),
  };
}

async function headOf(service) {
  const opened = await reader.open(service);
  if (!opened.ok) throw Object.assign(new Error(opened.reason), { status: 400 });
  return opened;
}

/**
 * Rebuild the structural index. `summaries: false` skips the local model (used when a v2 task finds a stale index).
 * An injected `summarizer` replaces the Ollama call. Returns the public view plus `changed` and `kept` paths.
 */
async function rebuild(service, project, { summaries = true, summarizer = defaultSummarizer } = {}) {
  const opened = await headOf(service);
  const { files, truncated } = await listFiles(opened.reader);
  const prev = readRows(service.id);
  const prevBy = new Map(prev.files.map((f) => [f.path, f]));
  const nextPaths = new Set(files.map((f) => f.path));
  const kept = [];
  const changed = [];
  for (const f of files) {
    const old = prevBy.get(f.path);
    if (old && old.hash === f.hash) kept.push(f.path);
    else changed.push(f);
  }
  const removed = prev.files.filter((f) => !nextPaths.has(f.path)).map((f) => f.path);
  const parsed = new Map();
  for (const f of changed) {
    if (!isCode(f.path)) { parsed.set(f.path, { symbols: [], imports: [] }); continue; }
    const text = await show(opened.reader.repoRoot, opened.reader.sha, opened.reader.sub ? `${opened.reader.sub}/${f.path}` : f.path);
    parsed.set(f.path, { symbols: text ? extractSymbols(text, f.path) : [], imports: text ? extractImports(text) : [] });
  }
  let framework = { framework: 'other', dependencies: [], scripts: [] };
  const pkg = files.find((f) => f.path === 'package.json');
  if (pkg && (changed.some((f) => f.path === 'package.json') || !prev.meta)) {
    const text = await show(opened.reader.repoRoot, opened.reader.sha, opened.reader.sub ? `${opened.reader.sub}/package.json` : 'package.json');
    if (text) { try { framework = detectFramework(JSON.parse(text)); } catch { /* not json */ } }
  } else if (prev.meta) {
    try { framework = JSON.parse(prev.meta.framework_json || '{}'); } catch { /* default */ }
  }
  const pathSet = nextPaths;
  const stamp = now();
  const d = store().db;
  d.exec('BEGIN IMMEDIATE');
  try {
    const delSym = d.prepare('DELETE FROM index_symbols WHERE service_id = ? AND path = ?');
    const delEdge = d.prepare('DELETE FROM index_edges WHERE service_id = ? AND from_path = ?');
    const delFile = d.prepare('DELETE FROM index_files WHERE service_id = ? AND path = ?');
    for (const p of removed) { delSym.run(service.id, p); delEdge.run(service.id, p); delFile.run(service.id, p); }
    const dropTo = d.prepare('DELETE FROM index_edges WHERE service_id = ? AND to_path = ?');
    for (const p of removed) dropTo.run(service.id, p);
    const insFile = d.prepare('INSERT INTO index_files (service_id, path, size, hash, language, built_at) VALUES (?,?,?,?,?,?)');
    const insSym = d.prepare('INSERT INTO index_symbols (service_id, path, name, kind, line) VALUES (?,?,?,?,?)');
    const insEdge = d.prepare('INSERT INTO index_edges (service_id, from_path, to_path) VALUES (?,?,?)');
    for (const f of changed) {
      delSym.run(service.id, f.path);
      delEdge.run(service.id, f.path);
      delFile.run(service.id, f.path);
      insFile.run(service.id, f.path, f.size, f.hash, f.language, stamp);
      const got = parsed.get(f.path) || { symbols: [], imports: [] };
      for (const s of got.symbols) insSym.run(service.id, f.path, s.name, s.kind, s.line);
      const seen = new Set();
      for (const spec of got.imports) {
        const to = resolveImport(f.path, spec, pathSet);
        if (!to || seen.has(to)) continue;
        seen.add(to);
        insEdge.run(service.id, f.path, to);
      }
    }
    d.prepare(`INSERT INTO index_meta (service_id, commit_sha, built_at, file_count, framework_json) VALUES (?,?,?,?,?)
               ON CONFLICT(service_id) DO UPDATE SET commit_sha = excluded.commit_sha, built_at = excluded.built_at, file_count = excluded.file_count, framework_json = excluded.framework_json`)
      .run(service.id, opened.reader.sha, stamp, files.length, JSON.stringify(framework));
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* none */ }
    throw e;
  }
  if (summaries) await writeSummaries(service, summarizer);
  const out = await getIndex(service, project);
  out.truncated = truncated;
  out.changed = changed.map((f) => f.path);
  out.kept = kept;
  out.removed = removed;
  return out;
}

async function writeSummaries(service, summarizer) {
  const rows = readRows(service.id);
  const groups = new Map();
  for (const f of rows.files) {
    const key = moduleOf(f.path);
    if (!groups.has(key)) groups.set(key, { path: key, files: [], symbols: [] });
    groups.get(key).files.push(f);
  }
  for (const s of rows.symbols) {
    const key = moduleOf(s.path);
    if (!groups.has(key)) groups.set(key, { path: key, files: [], symbols: [] });
    groups.get(key).symbols.push(s);
  }
  const have = new Map(rows.summaries.map((s) => [s.module_path, s]));
  const d = store().db;
  const upsert = d.prepare(`INSERT INTO index_summaries (service_id, module_path, content_hash, summary, model, built_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(service_id, module_path) DO UPDATE SET content_hash = excluded.content_hash, summary = excluded.summary, model = excluded.model, built_at = excluded.built_at`);
  for (const mod of groups.values()) {
    const hash = moduleHash(mod.files, mod.symbols);
    const prev = have.get(mod.path);
    if (prev && prev.content_hash === hash) continue;
    let text = `Folder ${mod.path}.`;
    let model = 'none';
    try {
      const got = await summarizer({ modulePath: mod.path, symbols: mod.symbols, files: mod.files });
      if (got && got.text) { text = String(got.text).slice(0, 400); model = got.model || 'local'; }
    } catch (e) { text = `Summary unavailable (${e.message})`; }
    upsert.run(service.id, mod.path, hash, text, model, now());
  }
  const live = new Set(groups.keys());
  for (const old of have.keys()) if (!live.has(old)) d.prepare('DELETE FROM index_summaries WHERE service_id = ? AND module_path = ?').run(service.id, old);
}

async function getIndex(service, project) {
  const opened = await headOf(service);
  const proj = project || store().getProject(service.project_id);
  return viewOf(service, proj, opened.reader.sha, readRows(service.id));
}

/** Structural rebuild when the indexed sha is missing or behind the service's default branch. No model call. */
async function ensureFresh(service, project) {
  const current = await getIndex(service, project);
  if (current.built && !current.stale) return { rebuilt: false, ...current };
  const next = await rebuild(service, project, { summaries: false });
  return { rebuilt: true, ...next };
}

function search(serviceId, q) {
  const query = String(q || '').trim().slice(0, 200);
  if (!query) return { query, hits: [] };
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const d = store().db;
  const symbols = d.prepare(`SELECT path, name, kind, line FROM index_symbols WHERE service_id = ? AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ORDER BY path, line LIMIT 40`).all(serviceId, like, like);
  const files = d.prepare(`SELECT path FROM index_files WHERE service_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`).all(serviceId, like);
  const mods = d.prepare(`SELECT module_path, summary FROM index_summaries WHERE service_id = ? AND (module_path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\') ORDER BY module_path LIMIT 20`).all(serviceId, like, like);
  const hits = [
    ...symbols.map((s) => ({ path: s.path, name: s.name, kind: s.kind, line: s.line, match: 'symbol' })),
    ...files.map((f) => ({ path: f.path, name: f.path, kind: 'file', line: null, match: 'path' })),
    ...mods.map((m) => ({ path: m.module_path, name: m.module_path, kind: 'module', line: null, match: 'summary' })),
  ];
  return { query, hits: hits.slice(0, 50) };
}

module.exports = { rebuild, getIndex, ensureFresh, search, moduleOf };

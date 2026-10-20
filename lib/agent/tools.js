'use strict';
// One JSON tool call. Paths stay inside the worktree. Patches are written in process.
const fs = require('node:fs');
const path = require('node:path');
const repo = require('../repo');

const NAMES = ['search_code', 'read_symbol', 'read_file_range', 'list_dir', 'run_check', 'apply_patch', 'ask_escalate'];

function parseCall(text) {
  let obj = null;
  const raw = String(text || '').trim();
  try { obj = JSON.parse(raw); } catch { /* slice */ }
  if (!obj) {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(raw.slice(a, b + 1)); } catch { return { ok: false, error: 'tool call is not JSON' }; } }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'tool call is not JSON' };
  const tool = obj.tool || obj.name;
  if (!NAMES.includes(tool)) return { ok: false, error: `unknown tool ${tool || ''}` };
  const args = obj.args && typeof obj.args === 'object' ? obj.args : obj;
  return { ok: true, tool, args };
}

function resolveInside(root, rel) {
  const clean = String(rel || '').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) throw new Error('path outside the repo');
  const abs = path.resolve(root, clean);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('path outside the repo');
  return { rel: clean, abs };
}

function walk(dir, out, depth) {
  if (depth > 4 || out.length > 400) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out, depth + 1);
    else if (st.isFile() && st.size < 200000) out.push(abs);
  }
}

async function exec(call, env) {
  const root = env.root;
  if (env.service) repo.assertUsable(env.service);
  const args = call.args || {};
  if (call.tool === 'ask_escalate') return { ok: true, escalate: true, summary: String(args.summary || args.reason || 'model asked to escalate').slice(0, 1200) };
  if (call.tool === 'list_dir') {
    const { abs, rel } = resolveInside(root, args.path || '.');
    const names = fs.readdirSync(abs).filter((n) => n !== '.git' && n !== 'node_modules');
    return { ok: true, note: `${rel}: ${names.slice(0, 40).join(', ')}` };
  }
  if (call.tool === 'read_file_range' || call.tool === 'read_symbol') {
    const { abs } = resolveInside(root, args.path || args.file);
    const text = fs.readFileSync(abs, 'utf8');
    if (call.tool === 'read_symbol') {
      const name = String(args.name || '');
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.includes(name));
      if (at < 0) return { ok: false, error: `symbol ${name} not found` };
      return { ok: true, note: lines.slice(at, at + 40).join('\n') };
    }
    const start = Math.max(1, Number(args.start) || 1);
    const end = Math.max(start, Number(args.end) || start + 40);
    return { ok: true, note: text.split('\n').slice(start - 1, end).join('\n') };
  }
  if (call.tool === 'search_code') {
    const q = String(args.query || '').slice(0, 200);
    if (!q) return { ok: false, error: 'search query is empty' };
    const files = [];
    walk(root, files, 0);
    const hits = [];
    for (const abs of files) {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (hits.length < 20 && line.includes(q)) hits.push(`${path.relative(root, abs)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    return { ok: true, note: hits.join('\n') || 'no matches' };
  }
  if (call.tool === 'run_check') {
    if (typeof env.runCheck !== 'function') return { ok: false, error: 'no check runner' };
    const check = await env.runCheck();
    return { ok: !!(check && check.ok), note: check && check.note, error: check && check.ok ? null : (check && check.note) || 'check failed' };
  }
  if (call.tool === 'apply_patch') {
    const { abs, rel } = resolveInside(root, args.file || args.path);
    if (env.approved && !env.approved.has(rel)) return { ok: false, error: `outside the approved files: ${rel}` };
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    let next = cur;
    if (typeof args.content === 'string') next = args.content;
    else if (typeof args.search === 'string') {
      if (!cur.includes(args.search)) return { ok: false, error: 'search text was not found' };
      next = cur.replace(args.search, String(args.replace ?? ''));
    } else return { ok: false, error: 'patch needs content or search' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    return { ok: true, note: `patched ${rel}` };
  }
  return { ok: false, error: 'unknown tool' };
}

module.exports = { NAMES, parseCall, resolveInside, exec };

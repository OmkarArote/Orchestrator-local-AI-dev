'use strict';
// Symbol, import and framework extraction with no dependencies. TypeScript compiler API is not required.
const path = require('node:path');

const SKIP_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'function', 'super']);
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);

function kindOf(keyword, name, file) {
  if (keyword === 'enum') return 'enum';
  if (keyword === 'interface' || keyword === 'type') return 'type';
  if (keyword === 'function') return 'function';
  if (keyword === 'class') {
    if (/Dto$|Query$/.test(name) || /\.dto\.[a-z]+$/i.test(file)) return 'dto';
    if (/Schema$/.test(name) || /\.schema\.[a-z]+$/i.test(file)) return 'schema';
    if (/Controller$/.test(name)) return 'controller';
    if (/Service$/.test(name)) return 'service';
    return 'class';
  }
  return keyword;
}

/** Exported and method-level symbols. `file` is the repo-relative path, used to tell a DTO from a schema. */
function extractSymbols(text, file) {
  const out = [];
  let controller = '';
  const seen = new Set();
  const add = (name, kind, line) => {
    const key = `${kind}\0${name}\0${line}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, line });
  };
  String(text || '').split('\n').forEach((line, i) => {
    const n = i + 1;
    const cm = line.match(/@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/);
    if (cm) controller = cm[1].replace(/^\/+|\/+$/g, '');
    const rm = line.match(/@(Get|Post|Put|Patch|Delete)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
    if (rm) {
      const tail = (rm[2] || '').replace(/^\/+|\/+$/g, '');
      add(`${rm[1].toUpperCase()} ${[controller, tail].filter(Boolean).join('/')}`.trim(), 'route', n);
    }
    const decl = line.match(/\b(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|enum|type|function)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (decl) add(decl[2], kindOf(decl[1], decl[2], file), n);
    const cnst = line.match(/\bexport\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cnst) add(cnst[1], 'const', n);
    const method = line.match(/^\s*(?:(?:public|private|protected|readonly|async|static|override)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/);
    if (method && !SKIP_METHOD.has(method[1]) && method[1].length >= 3 && /^\s+/.test(line)) add(method[1], 'function', n);
  });
  return out;
}

function extractImports(text) {
  const specs = new Set();
  const src = String(text || '');
  for (const re of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) if (m[1].startsWith('.')) specs.add(m[1]);
  }
  return [...specs];
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolve a relative specifier against the files present in the index. Returns a repo-relative path or null. */
function resolveImport(fromFile, spec, paths) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (base.startsWith('..')) return null;
  const set = paths instanceof Set ? paths : new Set(paths);
  for (const ext of EXTS) if (set.has(base + ext)) return base + ext;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx']) if (set.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

function detectFramework(pkg) {
  const json = pkg && typeof pkg === 'object' ? pkg : {};
  const deps = { ...(json.dependencies || {}), ...(json.devDependencies || {}) };
  const names = Object.keys(deps).sort();
  let framework = 'other';
  if (names.some((n) => n === '@nestjs/core' || n === '@nestjs/common' || n.startsWith('@nestjs/'))) framework = 'nestjs';
  else if (names.includes('next')) framework = 'next';
  else if (names.includes('express')) framework = 'express';
  return { framework, dependencies: names, scripts: Object.keys(json.scripts || {}).sort() };
}

function isCode(file) {
  const base = path.posix.basename(file);
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return CODE_EXT.has(ext);
}

module.exports = { extractSymbols, extractImports, resolveImport, detectFramework, isCode };

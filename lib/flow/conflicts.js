'use strict';
// Decide whether a conflicted merge may be resolved by the local model. Pure: no git, no network.

const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|go\.sum)$/;
const MIGRATION = /(^|\/)migrations?\//;
const ENVFILE = /(^|\/)\.env(\b|\.)/;

function hunks(text) {
  const out = [];
  const re = /^<<<<<<<[^\n]*\n[\s\S]*?^>>>>>>>[^\n]*$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ lines: m[0].split('\n').length, text: m[0] });
  return out;
}

function blocked(file, text) {
  const p = String(file || '').replace(/\\/g, '/');
  if (LOCK.test(p) || MIGRATION.test(p) || ENVFILE.test(p)) return 'protected path';
  if (String(text || '').includes('\0')) return 'binary';
  return null;
}

/** @param {{path:string,text:string}[]} files */
function canAutoResolve(files) {
  const list = files || [];
  if (!list.length) return { ok: false, reason: 'no conflicted files' };
  if (list.length > 3) return { ok: false, reason: `${list.length} conflicted files (max 3)` };
  for (const f of list) {
    const why = blocked(f.path, f.text);
    if (why) return { ok: false, reason: `${why}: ${f.path}` };
    const h = hunks(f.text);
    if (!h.length) return { ok: false, reason: `no conflict hunk in ${f.path}` };
    const big = h.find((x) => x.lines > 40);
    if (big) return { ok: false, reason: `hunk in ${f.path} is ${big.lines} lines (max 40)` };
  }
  return { ok: true, hunks: list.map((f) => ({ path: f.path, hunks: hunks(f.text) })) };
}

module.exports = { canAutoResolve, hunks, blocked };

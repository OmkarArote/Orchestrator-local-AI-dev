'use strict';
// Drop worktree edits that are outside the files the scope gate approved.
const { git } = require('../proc');

function parsePorcelain(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4).trim();
    if (file) out.push({ code, file });
  }
  return out;
}

async function revertOutside(wt, allowed) {
  const ok = allowed instanceof Set ? allowed : new Set(allowed || []);
  const st = await git(wt, ['status', '--porcelain', '--']);
  if (st.code !== 0) return { ok: false, error: st.err || st.error || 'git status failed', reverted: [] };
  const reverted = [];
  for (const row of parsePorcelain(st.out)) {
    if (ok.has(row.file)) continue;
    const untracked = row.code === '??' || row.code === '!!';
    const cmd = untracked ? ['clean', '-f', '--', row.file] : ['checkout', '--', row.file];
    const r = await git(wt, cmd);
    if (r.code === 0) reverted.push(row.file);
  }
  return { ok: true, reverted };
}

module.exports = { parsePorcelain, revertOutside };

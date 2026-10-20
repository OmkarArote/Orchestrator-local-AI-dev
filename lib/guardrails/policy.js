'use strict';
// Deny dangerous commands and diffs before a check runs or a commit is made.

const SECRET = /(^|\/)\.env($|\.)|credentials|id_rsa|\.pem$|secret/i;
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/;
const CMD = [
  [/\brm\s+-[^\n]*r/i, 'rm -rf'],
  [/\bdrop\s+(table|database)\b/i, 'drop database'],
  [/\bdelete\s+from\b/i, 'delete from'],
  [/\btruncate\s+table\b/i, 'truncate table'],
  [/push\s+[^\n]*--force|\bgit\s+push\b[^\n]*\s-f\b|\bforce[\s-]push\b/i, 'force push'],
];

function allows(taskText, needle) {
  return String(taskText || '').toLowerCase().includes(String(needle).toLowerCase());
}

function commandDenied(cmd, taskText) {
  const text = String(cmd || '');
  for (const [re, why] of CMD) {
    if (re.test(text) && !allows(taskText, why)) return why;
  }
  return null;
}

function diffDenied({ files = [], diffText = '', taskText = '', approved = null, maxFiles = 8, maxLines = 400 } = {}) {
  const names = files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  if (names.length > maxFiles) return { reason: `more than ${maxFiles} files`, file: names[maxFiles] };
  let lines = 0;
  for (const row of String(diffText).split('\n')) {
    if (row.startsWith('+') || row.startsWith('-')) {
      if (row.startsWith('+++') || row.startsWith('---')) continue;
      lines += 1;
    }
  }
  if (lines > maxLines) return { reason: `more than ${maxLines} changed lines`, file: names[0] || null };
  const allow = approved instanceof Set ? approved : (Array.isArray(approved) ? new Set(approved) : null);
  for (const file of names) {
    if (file.startsWith('/') || file.split('/').includes('..')) return { reason: 'path outside the repo', file };
    if (SECRET.test(file) && !allows(taskText, file.split('/').pop())) return { reason: 'secret file', file };
    if (LOCK.test(file) && !allows(taskText, file.split('/').pop())) return { reason: 'lockfile', file };
    if (allow && !allow.has(file)) return { reason: 'outside the approved files', file };
  }
  if (commandDenied(diffText, taskText)) return { reason: commandDenied(diffText, taskText), file: names[0] || null };
  return null;
}

module.exports = { commandDenied, diffDenied, allows };

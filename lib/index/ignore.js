'use strict';
// A small .gitignore / .aiderignore matcher. Last matching rule wins, including a leading '!'.
// A pattern with no slash matches the file name in any directory. A trailing slash matches that directory and everything under it.

function globToRegExp(pattern, { basenameOnly }) {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { src += '(?:.*/)?'; i += 2; }
      else { src += '.*'; i += 1; }
      continue;
    }
    if (c === '*') { src += '[^/]*'; continue; }
    if (c === '?') { src += '[^/]'; continue; }
    src += /[\\^$+?.()|[\]{}]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(basenameOnly ? `(?:^|/)${src}$` : `^${src}$`);
}

function compileIgnore(text) {
  const rules = [];
  for (const rawLine of String(text || '').split('\n')) {
    let line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1).trim(); }
    if (!line) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const basenameOnly = !anchored && !line.includes('/');
    rules.push({ neg, dirOnly, pattern: line, re: dirOnly ? null : globToRegExp(line, { basenameOnly }) });
  }
  return rules;
}

function dirMatch(rel, pattern) {
  if (rel === pattern || rel.startsWith(`${pattern}/`)) return true;
  if (pattern.includes('/')) return false;
  const segs = rel.split('/');
  return segs.slice(0, -1).includes(pattern);
}

function matches(rel, rule) {
  if (rule.dirOnly) return dirMatch(rel, rule.pattern);
  return rule.re.test(rel);
}

/** True when the combined rule list ignores this repo-relative file. */
function isIgnored(rel, rules) {
  let ignored = false;
  for (const rule of rules || []) if (matches(rel, rule)) ignored = !rule.neg;
  return ignored;
}

module.exports = { compileIgnore, isIgnored };

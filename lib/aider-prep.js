'use strict';
// Local (aider) request hygiene. Swap-relook tasks #5/#6/#8: the prompt said "Do not open ... package-lock.json ... README.md", aider
// auto-adds every repo file NAMED in the message (--yes-always), so those 22 files (227 KB lockfile, 104 KB README) went into one ~474 KB
// request and the 9B model stalled. Tasks #9-#13 had the opposite problem: no files and no repo map, so the model saw no code at all.
//  - stripDoNotOpen: moves "do not open/read ..." lists out of the aider message into ignore patterns (Cursor still gets the original);
//  - ignoreFileText: aider ignore file (lockfiles, docs, maps, build output, secrets, files over the size cap; pinned files stay allowed);
//  - mention budget: callers count files aider auto-adds from mentions and stop the run when the request would exceed the cap.
const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./proc');

const DEFAULT_IGNORE = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'uv.lock',
  'README*', 'LICENSE*', 'CHANGELOG*', '*.map', '*.min.js', '*.min.css', 'dist/', 'build/', 'coverage/', 'node_modules/', 'vendor/', '.next/', 'out/', '*.log',
  '.env*', '*.pem', '*.key', '.github/', '.husky/', '.DS_Store', '.aider*'];

const TRIGGER = /\b(do not|don't|dont|never|avoid|skip)\b[^.\n]{0,40}?\b(open|read|load|add|include|search|summari[sz]e|touch|look at|scan)\b/i;
const LIST_ITEM = /^\s*([-*\u2022]|\d+[.)])\s+/;
const STOP = new Set(['and', 'or', 'any', 'these', 'those', 'the', 'files', 'file', 'folders', 'folder', 'dirs', 'directory', 'other', 'secret', 'secrets', 'credential', 'credentials', 'e.g.', 'etc', 'etc.', 'i.e.']);

/**
 * Remove "do not open/read X, Y, Z" blocks (the trigger line + its bullet list) from `prompt` when they name at least one path.
 * Returns { text, patterns (gitignore-style, relative to the git root), removed (lines removed) }. `root` = service root (to recognise
 * bare directory names such as node_modules), `prefix` = service path inside the repo ('' for the whole repo).
 */
function stripDoNotOpen(prompt, { root = null, prefix = '' } = {}) {
  const lines = String(prompt).split('\n');
  const keep = [], patterns = new Set();
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!TRIGGER.test(lines[i])) { keep.push(lines[i]); continue; }
    const block = [lines[i]];
    let j = i + 1;
    const listFollows = /:\s*$/.test(lines[i]); // "Do not open these files:" + bullets; a plain sentence never swallows the next list
    if (listFollows) while (j < lines.length && LIST_ITEM.test(lines[j])) block.push(lines[j++]);
    const found = [];
    block.forEach((l, k) => {
      const body = k === 0 ? l.slice(l.search(TRIGGER)) : l.replace(LIST_ITEM, '');
      for (let tok of body.split(/[\s,;()]+/)) {
        tok = tok.replace(/^["'`*_]+|["'`*_]+$/g, '').replace(/[.:!?]+$/, '');
        if (!tok || STOP.has(tok.toLowerCase()) || tok.length > 120 || /^\.+$/.test(tok) || /^https?:/.test(tok)) continue;
        // bare names (node_modules, LICENSE) count only inside the bullet list and only when they exist in the service root
        const bare = !/[./*]/.test(tok);
        const kind = bare && k > 0 && root && /^[\w-]+$/.test(tok) ? (() => { try { return fs.statSync(path.join(root, tok)).isDirectory() ? 'dir' : 'file'; } catch { return null; } })() : null;
        if (bare && !kind) continue;
        let pat = tok.replace(/^\.\//, '');
        if (kind === 'dir' && !pat.endsWith('/')) pat += '/';
        if (prefix && pat.replace(/\/$/, '').includes('/')) pat = `${prefix}/${pat}`; // anchored paths are relative to the git root
        found.push(pat);
      }
    });
    if (!found.length) { keep.push(lines[i]); continue; } // a "do not" sentence without paths stays as written
    for (const p of found) patterns.add(p);
    removed += block.length;
    keep.push(`(Orchestrator: the ${found.length} path(s) from the "do not open" list above are excluded from this run by the aider ignore file.)`);
    i = j - 1;
  }
  return { text: keep.join('\n'), patterns: [...patterns], removed };
}

/** Tracked files of the worktree with sizes (paths relative to the git root, as aider prints them). */
async function trackedSizes(wt) {
  const r = await git(wt, ['ls-files', '-z']);
  const out = new Map();
  if (r.code !== 0) return out;
  for (const f of r.out.split('\0').filter(Boolean)) { try { const st = fs.lstatSync(path.join(wt, f)); if (st.isFile()) out.set(f, st.size); } catch { /* deleted in the worktree */ } }
  return out;
}

const esc = (p) => p.replace(/([\\[\]*?!# ])/g, '\\$1');

/** Text of the aider ignore file: repo .aiderignore + defaults + "do not open" patterns + oversized tracked files; pinned files are re-allowed. */
/**
 * pinOnly (with pinned files): every other path is ignored, so aider cannot auto-add a file the message mentions.
 * aider 0.86.2 has no --no-auto-add flag and --yes-always accepts every "Add file to the chat?" prompt; the ignore
 * file is the only switch (tasks #15-#21 and #30 stopped after 3-6 auto-added files). Pinned files are re-allowed last.
 */
function ignoreFileText({ wt, extra = [], sizes = new Map(), maxFileBytes, pinned = [], pinOnly = false }) {
  let own = '';
  try { own = fs.readFileSync(path.join(wt, '.aiderignore'), 'utf8'); } catch { /* none */ }
  const big = [...sizes].filter(([f, n]) => n > maxFileBytes && !pinned.includes(f)).map(([f]) => `/${esc(f)}`);
  return ['# generated by the orchestrator for one aider run (outside the repo; never committed)', ...(own.trim() ? ['# repo .aiderignore', own.trim()] : []),
    '# defaults: lockfiles, docs, maps, build output, secrets', ...DEFAULT_IGNORE, ...(extra.length ? ['# from the task prompt ("do not open")', ...extra] : []),
    ...(big.length ? [`# tracked files over ${maxFileBytes} bytes`, ...big] : []),
    ...(pinOnly && pinned.length ? ['# pin-only run (ORCH_AIDER_PIN_ONLY): nothing but the pinned files can be added', '/**'] : []), ...(pinned.length ? ['# pinned task files stay editable', ...pinned.map((f) => `!/${esc(f)}`)] : []), ''].join('\n');
}

module.exports = { stripDoNotOpen, trackedSizes, ignoreFileText, DEFAULT_IGNORE };

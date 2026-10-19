#!/usr/bin/env node
'use strict';
// Stub of `aider` for tests (no model, no network). Edits the files it is given (or creates stub-aider-out.txt).
// Keywords in the --message: STUB_FAIL -> exit 1; STUB_NOCHANGE -> exit 0 without edits.
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const LOG = process.env.STUB_AIDER_LOG || '/tmp/stub-aider.log';
const mi = a.indexOf('--message');
const message = mi >= 0 ? a[mi + 1] : '';
const files = mi >= 0 ? a.slice(mi + 2) : [];
const settingsIdx = a.indexOf('--model-settings-file');
let settings = null;
if (settingsIdx >= 0) { try { settings = fs.readFileSync(a[settingsIdx + 1], 'utf8'); } catch { settings = '(unreadable)'; } }
const ig = a.indexOf('--aiderignore');
fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), cwd: process.cwd(), model: a[a.indexOf('--model') + 1], files, settings, readFiles: a.filter((x, i) => a[i - 1] === '--read'), args: a.filter((x) => x !== message),
  message, aiderignore: ig >= 0 ? (() => { try { return fs.readFileSync(a[ig + 1], 'utf8'); } catch { return '(unreadable)'; } })() : null }) + '\n');
if (process.env.STUB_WRITE_AIDER_CACHE === '1') {
  const dir = path.join(process.cwd(), '.aider.tags.cache.v4');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache'), 'tags-new\n');
  fs.writeFileSync(path.join(process.cwd(), '.aider.chat.history.md'), 'hist\n');
}
console.log('stub-aider: starting');
console.error('stub-aider: stderr line');
const pr = message.match(/STUB_PRINT<<([^>]*)>>/); // STUB_PRINT<<a.txt|b.txt>> prints those lines like aider's "Add file to the chat?" subjects
if (pr) for (const l of pr[1].split('|')) console.log(l);
if (/STUB_FAIL/.test(message)) { console.log('stub-aider: failing on request'); process.exit(1); }
if (/STUB_SLOW/.test(message)) { setTimeout(() => process.exit(0), 600000); return; }
const ap = message.match(/STUB_APPEND<<([\s\S]*?)>>/); // STUB_APPEND<<text with \\n>> writes that text instead of the default line (feature/contract tests)
if (!/STUB_NOCHANGE/.test(message)) {
  const targets = files.length ? files : ['stub-aider-out.txt'];
  for (const f of targets) {
    const p = path.join(process.cwd(), f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, ap ? ap[1].replace(/\\n/g, '\n') + '\n' : `edited by stub-aider\n`);
  }
}
console.log('stub-aider: done');
process.exit(0);

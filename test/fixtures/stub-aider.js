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
fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), cwd: process.cwd(), model: a[a.indexOf('--model') + 1], files, settings, readFiles: a.filter((x, i) => a[i - 1] === '--read'), args: a.filter((x) => x !== message) }) + '\n');
console.log('stub-aider: starting');
console.error('stub-aider: stderr line');
if (/STUB_FAIL/.test(message)) { console.log('stub-aider: failing on request'); process.exit(1); }
if (/STUB_SLOW/.test(message)) { setTimeout(() => process.exit(0), 600000); return; }
if (!/STUB_NOCHANGE/.test(message)) {
  const targets = files.length ? files : ['stub-aider-out.txt'];
  for (const f of targets) {
    const p = path.join(process.cwd(), f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `edited by stub-aider\n`);
  }
}
console.log('stub-aider: done');
process.exit(0);

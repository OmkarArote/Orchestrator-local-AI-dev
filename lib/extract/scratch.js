'use strict';
// Short-lived directories for tool cwd. Removed with fsguard.removeOwnedDir even when the tool fails.
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const fsg = require('../fsguard');

async function withScratch(parent, fn) {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = require('node:path').join(parent, 's' + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  try { return await fn(dir); }
  finally {
    try { fsg.removeOwnedDir(dir, { ownedPrefixes: [parent], home: os.homedir() }); } catch { /* leave the failure visible to the caller of fn; the dir is still inside parent */ }
  }
}

module.exports = { withScratch };

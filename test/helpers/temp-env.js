'use strict';
// Require this FIRST in any test file that loads lib/* modules in-process: points ORCH_DB/ORCH_LOG_DIR/ORCH_WORKTREES at a throw-away dir
// (config.js refuses to fall back to the real dirs under node:test).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (!process.env.ORCH_DB) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inproc-'));
  process.env.ORCH_DB = path.join(d, 'o.db');
  process.env.ORCH_LOG_DIR = path.join(d, 'logs');
  process.env.ORCH_WORKTREES = path.join(d, 'wt');
  process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });
}

'use strict';
// Require this FIRST in any test file that loads lib/* modules in-process: points ORCH_DB/ORCH_LOG_DIR/ORCH_WORKTREES at a throw-away dir
// (config.js refuses to fall back to the real dirs under node:test).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// A preset ORCH_DB (the baseline command) must still get throw-away log and worktree dirs.
// Otherwise config.js throws under node:test and in-process suites never start.
if (!process.env.ORCH_DB || !process.env.ORCH_LOG_DIR || !process.env.ORCH_WORKTREES) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inproc-'));
  if (!process.env.ORCH_DB) process.env.ORCH_DB = path.join(d, 'o.db');
  if (!process.env.ORCH_LOG_DIR) process.env.ORCH_LOG_DIR = path.join(d, 'logs');
  if (!process.env.ORCH_WORKTREES) process.env.ORCH_WORKTREES = path.join(d, 'wt');
  process.on('exit', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });
}

'use strict';
// M50: a task whose branch already exists (task #1) reuses it when no worktree holds it, instead of failing.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo, git } = require('./helpers/harness');
const { branchPlan } = require('../lib/runner');

describe('M50 task branch reuse', () => {
  it('new when missing, reuse when free, busy when another worktree has it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm50-br-'));
    const r = makeRepo(path.join(dir, 'repo'), { 'a.txt': 'a\n' });
    assert.equal((await branchPlan(r, 'ai/task-1')).mode, 'new');
    git(r, 'branch', 'ai/task-1');
    assert.equal((await branchPlan(r, 'ai/task-1')).mode, 'reuse');
    const wt = path.join(dir, 'wt1');
    git(r, 'worktree', 'add', wt, 'ai/task-1');
    const b = await branchPlan(r, 'ai/task-1');
    assert.equal(b.mode, 'busy');
    assert.equal(fs.realpathSync(b.at), fs.realpathSync(wt));
  });
});

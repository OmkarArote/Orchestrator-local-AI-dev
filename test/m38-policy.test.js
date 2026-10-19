'use strict';
// M8 policy: one reason code per threshold. local2 only when a second installed model is in the chain.
delete process.env.ORCH_DB;
delete process.env.ORCH_WORKTREES;
delete process.env.ORCH_LOG_DIR;
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { decide, REASONS } = require('../lib/flow/policy');
const cfg = require('../config');

const base = {
  LOCAL_MAX_FILES: 5,
  LOCAL_MAX_REQUEST_CHARS: 60000,
  V2_DIFF_CURSOR: 300,
  V2_CURSOR_RUNS: 3,
  V2_LOCAL_MODELS: ['ornith:9b', 'qwen3.5:9b'],
};
const both = ['ornith:9b', 'qwen3.5:9b'];
const only = ['ornith:9b'];

describe('M38 policy', () => {
  it('stays on the installed local model when nothing is wrong', () => {
    const d = decide({ installed: both, currentModel: 'ornith:9b', files: 1, estDiff: 40 }, base);
    assert.equal(d.engine, 'local');
    assert.equal(d.model, 'ornith:9b');
    assert.deepEqual(d.reasons, []);
  });

  it('names each reason and steps ornith then qwen then cursor, or skips local2 when qwen is not installed', () => {
    const cases = [
      [{ files: 4 }, 'files'],
      [{ files: 3, dirs: 2 }, 'files'],
      [{ pinnedFiles: 6 }, 'max_files'],
      [{ riskArea: true }, 'risk_area'],
      [{ estDiff: 301 }, 'diff_size'],
      [{ requestChars: 60001 }, 'context_size'],
      [{ verifyFailed: 2 }, 'verify_failed>=2'],
      [{ noEdit: 2 }, 'no_edit'],
      [{ noProgress: true }, 'no_progress'],
      [{ loop: 3 }, 'loop'],
    ];
    for (const [sig, reason] of cases) {
      const d = decide({ ...sig, installed: both, currentModel: 'ornith:9b' }, base);
      assert.equal(d.engine, 'local2', reason);
      assert.equal(d.model, 'qwen3.5:9b');
      assert.ok(d.reasons.includes(reason), reason);
      const skip = decide({ ...sig, installed: only, currentModel: 'ornith:9b' }, base);
      assert.equal(skip.engine, 'cursor', reason);
      assert.equal(skip.model, null);
    }
    const second = decide({ verifyFailed: 2, installed: both, currentModel: 'qwen3.5:9b', local2Used: true }, base);
    assert.equal(second.engine, 'cursor');
    const spent = decide({ verifyFailed: 2, installed: both, currentModel: 'qwen3.5:9b', local2Used: true, cursorRuns: 3 }, base);
    assert.equal(spent.engine, 'fail');
    assert.ok(spent.reasons.includes('budget'));
    assert.deepEqual(REASONS.filter((r) => r !== 'budget').every((r) => cases.some((c) => c[1] === r)), true);
  });

  it('keeps a diff between the local and cursor thresholds on the local model', () => {
    const d = decide({ installed: both, currentModel: 'ornith:9b', estDiff: 200 }, base);
    assert.equal(d.engine, 'local');
  });

  it('reads the v2 defaults from config: cursor runs 3, diff 300, models ornith then qwen', () => {
    assert.equal(cfg.V2_CURSOR_RUNS, 3);
    assert.equal(cfg.V2_DIFF_CURSOR, 300);
    assert.deepEqual(cfg.V2_LOCAL_MODELS, ['ornith:9b', 'qwen3.5:9b']);
    assert.equal(cfg.V2_STEP_ATTEMPTS, 3);
  });
});

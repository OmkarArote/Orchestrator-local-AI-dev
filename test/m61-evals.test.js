'use strict';
// Eval scorer. A failed check wins over the judge. The run file is written without a live model.
require('./helpers/temp-env');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scoreTask, summarize } = require('../lib/evals/score');
const { judge } = require('../lib/evals/judge');
const { runEval, loadTasks } = require('../lib/evals/run');

const task = {
  id: 'checkout-outcome',
  files: ['src/modules/visit/visit.service.ts'],
  labels: {
    in_scope: { 'src/modules/visit/visit.service.ts': true, 'src/modules/book/book.service.ts': false },
    route: 'local-small',
    risk: 1,
  },
};

describe('eval scorer', () => {
  it('a failed check wins over a passing judge', () => {
    const row = scoreTask(task, {
      checkPassed: false,
      filesTouched: ['src/modules/visit/visit.service.ts'],
      judge: { skipped: false, pass: true },
      answers: { in_scope: { 'src/modules/visit/visit.service.ts': true, 'src/modules/book/book.service.ts': false }, route: 'local-small', risk: 1, confidence: 0.95 },
    });
    assert.equal(row.score, 0);
    assert.equal(row.judgeNote, 'check failed');
    assert.equal(row.decider.correct, 4);
  });

  it('skips the judge column when the model is absent', async () => {
    const got = await judge({ task, installed: ['ornith:9b'], model: 'qwen3.5:9b', chatJson: async () => { throw new Error('should not call'); } });
    assert.equal(got.skipped, true);
    const row = scoreTask(task, { checkPassed: true, filesTouched: task.files, judge: got, answers: null });
    assert.equal(row.score, 1);
    assert.equal(row.judgeNote, 'judge skipped');
  });

  it('suggests a threshold from the calibration buckets and does not write settings', () => {
    const rows = [scoreTask(task, {
      checkPassed: true,
      filesTouched: task.files,
      tokens: 40,
      escalated: false,
      answers: { in_scope: { 'src/modules/visit/visit.service.ts': true, 'src/modules/book/book.service.ts': false }, route: 'local-small', risk: 1, confidence: 0.95 },
    })];
    const summary = summarize(rows);
    assert.equal(summary.passRate, 1);
    assert.equal(summary.tokensPerTask, 40);
    assert.equal(summary.escalationRate, 0);
    assert.equal(summary.deciderAccuracy, 1);
    assert.match(summary.thresholdSuggestion, /0\.90/);
    assert.equal(process.env.ORCH_DECIDER_ACT, undefined);
  });

  it('writes a run file from the fixture tasks', async () => {
    const pack = loadTasks();
    assert.ok(pack.tasks.length >= 15 && pack.tasks.length <= 20);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-eval-'));
    const { file, doc } = await runEval({
      pack: { ...pack, tasks: pack.tasks.slice(0, 2) },
      outDir: dir,
      id: 'unit-run',
      execute: async (one) => ({ checkPassed: true, filesTouched: one.files, diffLines: 1, tokens: 3, ms: 4, escalated: false, answers: null }),
      judge: async () => ({ skipped: true, reason: 'stub' }),
    });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.id, 'unit-run');
    assert.equal(doc.summary.tasks, 2);
    assert.equal(doc.summary.judgeSkipped, true);
  });
});

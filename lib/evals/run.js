'use strict';
// Run the fixture tasks and write evals/results/<id>.json. Does not change settings.
const fs = require('node:fs');
const path = require('node:path');
const { scoreTask, summarize } = require('./score');

const ROOT = path.join(__dirname, '..', '..');

function loadTasks(file = path.join(ROOT, 'evals', 'tasks.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function executeCheck(task, fixtureDir, check) {
  const proc = require('../proc');
  const argv = task.check || check || ['node', '--check', 'scripts/ok.js'];
  const t0 = Date.now();
  const r = await proc.run(argv[0], argv.slice(1), { cwd: fixtureDir, timeoutMs: 20000 });
  return {
    checkPassed: r.code === 0 && !r.timedOut,
    filesTouched: task.files || [],
    diffLines: 0,
    tokens: 0,
    ms: Date.now() - t0,
    escalated: false,
    answers: null,
  };
}

async function runEval({ pack, execute, judge, outDir, flags, id } = {}) {
  const spec = pack || loadTasks();
  const fixtureDir = path.resolve(ROOT, spec.fixture || 'evals/fixtures/mini-api');
  const runId = id || new Date().toISOString().replace(/[:.]/g, '-');
  const rows = [];
  for (const task of spec.tasks || []) {
    const observed = execute
      ? await execute(task, fixtureDir)
      : await executeCheck(task, fixtureDir, spec.check);
    if (judge) observed.judge = await judge(task, observed);
    else observed.judge = { skipped: true, reason: 'no judge' };
    observed.tokens = (Number(observed.tokens) || 0) + (Number(observed.judge && observed.judge.tokens) || 0);
    rows.push(scoreTask(task, observed));
  }
  const summary = summarize(rows);
  const doc = { id: runId, flags: flags || {}, summary, tasks: rows };
  const dir = outDir || path.join(ROOT, 'evals', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return { file, doc };
}

function printSummary(doc) {
  const s = doc.summary || {};
  const lines = [
    `run ${doc.id}`,
    `pass rate ${s.passRate}`,
    `tokens per task ${s.tokensPerTask}`,
    `escalation rate ${s.escalationRate}`,
    `decider accuracy ${s.deciderAccuracy == null ? 'skipped' : s.deciderAccuracy}`,
    `judge ${s.judgeSkipped ? 'skipped' : 'scored'}`,
    `threshold: ${s.thresholdSuggestion}`,
  ];
  return lines.join('\n');
}

module.exports = { loadTasks, executeCheck, runEval, printSummary, ROOT };

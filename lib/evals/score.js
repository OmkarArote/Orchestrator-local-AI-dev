'use strict';
// Pure scorer for one eval task and for a run. A failed check wins over the judge.

function filesInside(touched, expected) {
  const want = new Set(expected || []);
  const got = touched || [];
  if (!want.size) return got.length === 0;
  return got.every((p) => want.has(p));
}

function compareDecider(labels, answers) {
  if (!labels || !answers) return { compared: 0, correct: 0, items: [], skipped: true };
  const items = [];
  const scope = labels.in_scope || {};
  const gotScope = answers.in_scope || {};
  for (const [file, want] of Object.entries(scope)) {
    const have = Object.prototype.hasOwnProperty.call(gotScope, file);
    const match = have && gotScope[file] === want;
    items.push({ id: `in_scope:${file}`, match, confidence: Number(answers.confidence) || 0 });
  }
  if (labels.route != null) items.push({ id: 'route', match: answers.route === labels.route, confidence: Number(answers.confidence) || 0 });
  if (labels.risk != null && answers.risk != null) items.push({ id: 'risk', match: Number(answers.risk) === Number(labels.risk), confidence: Number(answers.confidence) || 0 });
  const compared = items.length;
  const correct = items.filter((it) => it.match).length;
  return { compared, correct, items, skipped: compared === 0 };
}

function scoreTask(task, observed) {
  const labels = task.labels || {};
  const expected = Object.entries(labels.in_scope || {}).filter(([, on]) => on).map(([p]) => p);
  const filesOk = filesInside(observed.filesTouched, expected.length ? expected : task.files);
  const decider = compareDecider(labels, observed.answers);
  const checkPassed = !!observed.checkPassed;
  let score = checkPassed ? 1 : 0;
  let judgeNote = null;
  if (!checkPassed) judgeNote = 'check failed';
  else if (!observed.judge || observed.judge.skipped) judgeNote = 'judge skipped';
  else {
    score = observed.judge.pass ? 1 : 0;
    judgeNote = 'judge';
  }
  return {
    id: task.id,
    checkPassed,
    filesOk,
    diffLines: Number(observed.diffLines) || 0,
    tokens: Number(observed.tokens) || 0,
    ms: Number(observed.ms) || 0,
    escalated: !!observed.escalated,
    decider,
    judge: observed.judge || null,
    score,
    judgeNote,
  };
}

function rate(rows) {
  if (!rows.length) return null;
  return rows.reduce((s, n) => s + n, 0) / rows.length;
}

function suggestThreshold(calibration) {
  const act = calibration.act;
  const ask = calibration.ask;
  if (act != null && act < 0.9) return 'act-band matches are below 0.90; consider raising ORCH_DECIDER_ACT';
  if (ask != null && ask >= 0.9) return 'the ask band is already accurate; ORCH_DECIDER_ASK could move up toward 0.90';
  return 'keep ORCH_DECIDER_ACT at 0.90 and ORCH_DECIDER_ASK at 0.60';
}

function summarize(rows) {
  const n = rows.length || 1;
  const buckets = { low: [], ask: [], act: [] };
  let compared = 0;
  let correct = 0;
  for (const row of rows) {
    const d = row.decider || { compared: 0, correct: 0, items: [] };
    compared += d.compared || 0;
    correct += d.correct || 0;
    for (const item of d.items || []) {
      const b = item.confidence < 0.6 ? 'low' : item.confidence < 0.9 ? 'ask' : 'act';
      buckets[b].push(item.match ? 1 : 0);
    }
  }
  const calibration = { low: rate(buckets.low), ask: rate(buckets.ask), act: rate(buckets.act) };
  return {
    tasks: rows.length,
    passRate: rows.filter((r) => r.checkPassed).length / n,
    tokensPerTask: rows.reduce((s, r) => s + (r.tokens || 0), 0) / n,
    escalationRate: rows.filter((r) => r.escalated).length / n,
    deciderAccuracy: compared ? correct / compared : null,
    calibration,
    thresholdSuggestion: suggestThreshold(calibration),
    judgeSkipped: rows.every((r) => !r.judge || r.judge.skipped),
  };
}

module.exports = { filesInside, compareDecider, scoreTask, summarize, suggestThreshold };

'use strict';
// npm run eval. Writes evals/results/<id>.json and prints a threshold suggestion. Does not write settings.
const path = require('node:path');
const cfg = require('../config');
const { loadTasks, executeCheck, runEval, printSummary, ROOT } = require('../lib/evals/run');
const { judge } = require('../lib/evals/judge');

async function installedNames() {
  try {
    const listed = await require('../lib/ollama').listModels();
    return (listed && listed.models ? listed.models : []).map((m) => m.name || m.model).filter(Boolean);
  } catch {
    return [];
  }
}

async function maybeDecide(task) {
  if (!cfg.DECIDER) return null;
  const labels = task.labels || {};
  const files = Object.keys(labels.in_scope || {}).map((p) => ({ path: p, summary: '' }));
  try {
    const gate = await require('../lib/decider/gate').run({ prompt: task.prompt, files });
    const in_scope = {};
    for (const item of gate.items || []) {
      if (item.type === 'noul' && item.file) in_scope[item.file] = item.label === true;
    }
    return {
      in_scope,
      route: gate.route,
      risk: gate.risk,
      confidence: gate.confidence || 0,
      escalated: gate.action === 'escalate',
      backend: gate.backend,
    };
  } catch (e) {
    return { error: e.message, skipped: true };
  }
}

async function main() {
  const pack = loadTasks();
  const installed = await installedNames();
  const judgeName = cfg.JUDGE_MODEL;
  const judgeReady = installed.some((m) => m === judgeName || String(m).startsWith(`${judgeName}`) || judgeName.startsWith(String(m)));
  const fixtureDir = path.resolve(ROOT, pack.fixture);
  const flags = {
    ORCH_RAG: process.env.ORCH_RAG || '0',
    ORCH_DECIDER: process.env.ORCH_DECIDER || '0',
  };
  const { doc } = await runEval({
    pack,
    flags,
    execute: async (task) => {
      const observed = await executeCheck(task, fixtureDir, pack.check);
      const decided = await maybeDecide(task);
      if (decided && !decided.skipped && !decided.error) {
        observed.answers = decided;
        observed.escalated = !!decided.escalated;
        observed.tokens = (observed.tokens || 0) + (decided.tokens || 0);
      }
      return observed;
    },
    judge: async (task, observed) => {
      if (!judgeReady) return { skipped: true, model: judgeName, reason: 'model not installed' };
      if (!observed.checkPassed) return { skipped: true, model: judgeName, reason: 'check failed' };
      return judge({ task, diff: '', installed, model: judgeName });
    },
  });
  process.stdout.write(`${printSummary(doc)}\n`);
  if (!judgeReady) process.stdout.write(`skipped judge: ${judgeName} is not installed\n`);
  if (cfg.DECIDER && !installed.length) process.stdout.write('skipped decider model calls: Ollama is not reachable\n');
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e.message}\n`);
  process.exit(1);
});

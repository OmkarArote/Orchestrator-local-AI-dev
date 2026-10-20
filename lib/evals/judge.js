'use strict';
// Secondary score. A failed check wins; a missing judge model skips the column.
const cfg = require('../../config');

const RUBRIC = {
  type: 'object',
  required: ['pass'],
  properties: {
    pass: { type: 'boolean' },
    note: { type: 'string' },
  },
};

async function judge({ task, diff, model, chatJson, installed } = {}) {
  const name = model || cfg.JUDGE_MODEL;
  const have = installed || [];
  if (have.length && !have.some((m) => m === name || String(m).startsWith(`${name}:`) || name.startsWith(`${m}:`))) {
    return { skipped: true, model: name, reason: 'model not installed' };
  }
  const talk = chatJson || require('../llm').chatJson;
  const r = await talk({
    system: 'Score the change against the task. Reply with JSON {"pass": boolean, "note": string}. A failed check is already decisive; you only score a change whose check passed.',
    user: JSON.stringify({ id: task && task.id, prompt: task && task.prompt, diff: String(diff || '').slice(0, 8000) }),
    api: 'ollama',
    model: name,
    schema: RUBRIC,
    numCtx: 8192,
    maxTokens: 400,
    options: { think: false, temperature: 0, seed: 42 },
  });
  if (!r || !r.ok || !r.json || typeof r.json.pass !== 'boolean') return { skipped: true, model: name, reason: (r && r.error) || 'judge returned no pass flag' };
  return { skipped: false, model: name, pass: r.json.pass, note: r.json.note || '', tokens: (r.prompt_tokens || 0) + (r.completion_tokens || 0) };
}

module.exports = { judge, RUBRIC };

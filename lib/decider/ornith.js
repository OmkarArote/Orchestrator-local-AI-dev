'use strict';
// ornith:9b fallback. Forced JSON. A hosted Jev client can sit beside this later; it is not built here.
const cfg = require('../../config');

const SYSTEM = 'You are a scope judge. Reply with JSON only: {"answers":{...},"confidence":0.0}. A noul answer is {"p":0 to 1} (probability of yes). A choice answer is {"choice": one option, "probs": {option: probability}}. A score answer is {"value": integer, "p": probability of that value}.';

const SCHEMA = {
  type: 'object',
  properties: {
    answers: { type: 'object' },
    confidence: { type: 'number' },
  },
  required: ['answers'],
};

async function decide(state, questions, { chatJson, model } = {}) {
  const talk = chatJson || require('../llm').chatJson;
  const r = await talk({
    system: SYSTEM,
    user: JSON.stringify({ state, questions }),
    api: 'ollama',
    model: model || 'ornith:9b',
    schema: SCHEMA,
    numCtx: 8192,
    maxTokens: 800,
    options: { think: false, temperature: 0, seed: 42 },
  });
  if (!r || !r.ok || !r.json || !r.json.answers || typeof r.json.answers !== 'object') {
    return { ok: false, error: (r && r.error) || 'ornith returned no answers' };
  }
  return { ok: true, answers: r.json.answers, confidence: Number(r.json.confidence) || 0, model: model || 'ornith:9b', tokens: (r.prompt_tokens || 0) + (r.completion_tokens || 0) };
}

module.exports = { decide, SYSTEM, SCHEMA, model: () => cfg.LLM_MODEL };

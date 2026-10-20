'use strict';
// decide(state, questions) -> { answers, confidence, backend }.
// Order: local Laya, then ornith. The third slot is reserved for a hosted Jev backend.

const laya = require('./laya');
const ornith = require('./ornith');

async function decide(state, questions, { layaDecide, ornithDecide, skipLaya = false } = {}) {
  const errors = [];
  if (!skipLaya) {
    const local = layaDecide || ((s, q) => laya.decide(s, q));
    try {
      const got = await local(state, questions);
      if (got && got.ok && got.answers) return { answers: got.answers, confidence: got.confidence || 0, backend: 'laya' };
      errors.push((got && got.error) || 'laya down');
    } catch (e) { errors.push(e.message); }
  }
  const remote = ornithDecide || ((s, q) => ornith.decide(s, q));
  try {
    const got = await remote(state, questions);
    if (got && got.ok && got.answers) return { answers: got.answers, confidence: got.confidence || 0, backend: 'ornith', model: got.model || 'ornith:9b' };
    errors.push((got && got.error) || 'ornith failed');
  } catch (e) { errors.push(e.message); }
  return { answers: {}, confidence: 0, backend: null, error: errors.join('; ') || 'no decider backend' };
}

module.exports = { decide };

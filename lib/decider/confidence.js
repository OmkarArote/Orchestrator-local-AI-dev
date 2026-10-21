'use strict';
// Label confidence and the three bands. Thresholds come from config, overridable per call.

const cfg = require('../../config');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function invalid() {
  return { label: null, confidence: null, invalid: true };
}

function labelOf(question, answer) {
  if (!question || !answer || typeof answer !== 'object') return invalid();
  if (question.type === 'noul') {
    const p = num(answer.p);
    if (p === null || p < 0 || p > 1) return invalid();
    const yes = p >= 0.5;
    return { label: yes, confidence: yes ? p : 1 - p, invalid: false };
  }
  if (question.type === 'choice') {
    const choice = typeof answer.choice === 'string' ? answer.choice : null;
    const probs = answer.probs && typeof answer.probs === 'object' ? answer.probs : {};
    const listed = Array.isArray(question.options) ? question.options : [];
    if (!choice || (listed.length && !listed.includes(choice))) return invalid();
    const p = num(probs[choice]);
    if (p === null || p < 0 || p > 1) return invalid();
    return { label: choice, confidence: p, invalid: false };
  }
  if (question.type === 'score') {
    const value = Number(answer.value);
    const min = question.min == null ? 0 : question.min;
    const max = question.max == null ? 3 : question.max;
    const p = num(answer.p);
    if (!Number.isInteger(value) || value < min || value > max || p === null || p < 0 || p > 1) return invalid();
    return { label: value, confidence: p, invalid: false };
  }
  return invalid();
}

function band(confidence, act = cfg.DECIDER_ACT, ask = cfg.DECIDER_ASK) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return 'invalid';
  if (c >= act) return 'act';
  if (c >= ask) return 'ask';
  return 'escalate';
}

/** Ornith is a fallback. Its confidence cannot reach the act band. Laya stays raw. */
function capOf(backend, cap) {
  if (backend !== 'ornith') return null;
  const n = Number(cap);
  return Number.isFinite(n) ? n : cfg.DECIDER_FALLBACK_CAP;
}

module.exports = { labelOf, band, capOf };

'use strict';
// Confidence of the chosen label, and the act / ask / escalate band.

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Probability of the chosen label. noul uses max(p, 1-p). */
function labelOf(question, answer) {
  if (!question || !answer || typeof answer !== 'object') return { label: null, confidence: 0 };
  if (question.type === 'noul') {
    const p = clamp01(answer.p);
    const yes = p >= 0.5;
    return { label: yes, confidence: yes ? p : 1 - p, p };
  }
  if (question.type === 'choice') {
    const choice = typeof answer.choice === 'string' ? answer.choice : null;
    const probs = answer.probs && typeof answer.probs === 'object' ? answer.probs : {};
    const listed = Array.isArray(question.options) ? question.options : [];
    if (!choice || (listed.length && !listed.includes(choice))) return { label: null, confidence: 0 };
    return { label: choice, confidence: clamp01(probs[choice]), probs };
  }
  if (question.type === 'score') {
    const min = Number.isFinite(question.min) ? question.min : 0;
    const max = Number.isFinite(question.max) ? question.max : min;
    const value = Number(answer.value);
    if (!Number.isInteger(value) || value < min || value > max) return { label: null, confidence: 0 };
    return { label: value, confidence: clamp01(answer.p) };
  }
  return { label: null, confidence: 0 };
}

function band(confidence, act = 0.9, ask = 0.6) {
  const c = clamp01(confidence);
  if (c >= act) return 'act';
  if (c >= ask) return 'ask';
  return 'escalate';
}

module.exports = { clamp01, labelOf, band };

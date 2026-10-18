'use strict';
// Pure model choice. Never contacts Ollama, never downloads, never returns a cloud engine.
// Callers pass the installed list, what is loaded, and catalog hints. Same inputs always give the same score table.

const KIND_STRENGTH = {
  code_edit: 'code', chat_text: 'general', image_qa: 'vision', image_ocr: 'ocr',
  doc_qa: 'long_context', audio_transcribe: 'audio', video_summary: 'vision',
};
const NEED_CAP = { image_qa: 'vision', image_ocr: 'vision', video_summary: 'vision', audio_transcribe: 'audio' };

function strengthMatch(model, taskKind, difficulty) {
  const want = KIND_STRENGTH[taskKind];
  if (want && (model.strengths || []).includes(want)) return true;
  const name = String(model.name || '').toLowerCase();
  if (taskKind === 'code_edit' && /coder|code|ornith/.test(name)) return true;
  if ((taskKind === 'image_qa' || taskKind === 'video_summary') && ((model.capabilities || []).includes('vision') || /vl|vision|ocr/.test(name))) return true;
  if (taskKind === 'image_ocr' && /ocr/.test(name)) return true;
  if (difficulty === 'complex' && (model.capabilities || []).includes('thinking') && (model.strengths || []).includes('reasoning')) return true;
  return false;
}

function requiredCap(taskKind, needs) {
  if (needs && needs.vision) return 'vision';
  if (needs && needs.audio) return 'audio';
  if (needs && needs.tools) return 'tools';
  if (needs && needs.thinking) return 'thinking';
  return NEED_CAP[taskKind] || 'completion';
}

function swapPenalty(gb, loadMs) {
  if (Number.isFinite(loadMs) && loadMs > 0) return Math.min(40, Math.max(1, Math.round(loadMs / 1000)));
  const g = Number(gb) || 0;
  return 15 + Math.min(20, Math.round(g * 2));
}

function coreside(candidate, loadedNames, byName, ramBytes) {
  if (!ramBytes || !loadedNames.length) return true;
  const others = loadedNames.filter((n) => n !== candidate.name).map((n) => byName.get(n)).filter(Boolean);
  if (!others.length) return true;
  const sum = (candidate.weights_gb || 0) + others.reduce((a, m) => a + (m.weights_gb || 0), 0);
  return sum * 1e9 <= ramBytes * (2 / 3);
}

/**
 * @returns {{model: string|null, reason: string[], score_table: object[], alternatives: object[], swap: object, fit: string|null, warnings: string[], rule: string, missing: string|null, suggestion: object|null}}
 */
function selectModel({ taskKind = 'chat_text', needs = {}, difficulty = 'simple', installed = [], loaded = [], roles = {}, prefs = {} } = {}) {
  const cap = requiredCap(taskKind, needs);
  const minCtx = Number(needs.minCtxTokens) || 0;
  const loadedSet = new Set(loaded || []);
  const byName = new Map(installed.map((m) => [m.name, m]));
  const rejected = [];
  const candidates = [];
  for (const m of installed) {
    if (!m || typeof m.name !== 'string' || m.name.includes('/') || m.engine && m.engine !== 'ollama') { rejected.push('non-ollama'); continue; }
    const caps = m.capabilities || [];
    if (!caps.includes(cap)) { rejected.push(cap); continue; }
    if (needs.tools && !caps.includes('tools')) { rejected.push('tools'); continue; }
    if (needs.thinking && !caps.includes('thinking')) { rejected.push('thinking'); continue; }
    if (m.fit === 'too_large') { rejected.push('too_large'); continue; }
    if (minCtx && !(m.context_length >= minCtx)) { rejected.push('context'); continue; }
    candidates.push(m);
  }
  const suggestion = (prefs.suggestions || []).find((s) => (s.capabilities_expected || []).includes(cap)) || null;
  if (prefs.explicit) {
    const hit = installed.find((m) => m.name === prefs.explicit);
    return { model: prefs.explicit, rule: 'explicit', reason: hit ? [`explicit choice ${prefs.explicit}`] : [`explicit choice ${prefs.explicit} is not installed`], score_table: [], alternatives: [], swap: { needed: false, from: null, to: prefs.explicit, est_ms: null }, fit: hit ? hit.fit || null : null, warnings: hit ? [] : [`${prefs.explicit} is not installed`], missing: null, suggestion: null };
  }
  if (!candidates.length) {
    const missing = cap;
    const hint = suggestion ? `candidates to download: ${suggestion.name} ${suggestion.weights_gb} GB` : 'no catalog candidate';
    return { model: null, rule: 'none', reason: [`no installed model has \`${missing}\``, hint], score_table: [], alternatives: [], swap: { needed: false, from: null, to: null, est_ms: null }, fit: null, warnings: [], missing, suggestion };
  }
  const roleModel = roles.role || null;
  const def = roles.default || null;
  const scored = candidates.map((m) => {
    const parts = []; let score = 0;
    if (strengthMatch(m, taskKind, difficulty)) { score += 40; parts.push('+40 strength'); }
    const isLoaded = loadedSet.has(m.name);
    if (isLoaded) { score += 25; parts.push('+25 loaded'); }
    if (m.name === roleModel || m.name === def) { score += 10; parts.push('+10 role or default'); }
    if (difficulty === 'simple' && (m.weights_gb || 99) <= 4) { score += 5; parts.push('+5 small suffices'); }
    if (m.fit === 'tight') { score -= 10; parts.push('-10 tight'); }
    const swapping = !isLoaded && loadedSet.size > 0;
    if (swapping) { const p = swapPenalty(m.weights_gb, prefs.loadMs && prefs.loadMs[m.name]); score -= p; parts.push(`-${p} swap`); }
    if (prefs.taskRunning && !coreside(m, [...loadedSet], byName, prefs.ramBytes)) { score -= 30; parts.push('-30 cannot co-reside while a task runs'); }
    return { model: m.name, score, parts, weights_gb: m.weights_gb || 0, fit: m.fit || null };
  });
  scored.sort((a, b) => b.score - a.score || a.weights_gb - b.weights_gb || a.model.localeCompare(b.model));
  const top = scored[0];
  const swapNeeded = !loadedSet.has(top.model) && loadedSet.size > 0;
  const from = swapNeeded ? [...loadedSet][0] : null;
  const est = prefs.loadMs && prefs.loadMs[top.model];
  const alternatives = scored.slice(1, 3).map((s) => ({ model: s.model, score: s.score, delta: s.score - top.score }));
  const reason = [`${top.model} (${top.parts.join(', ') || 'no adjustments'})`, ...alternatives.map((a) => `alt ${a.model} ${a.delta}`)];
  if (prefs.taskRunning && swapNeeded) {
    return { model: top.model, rule: 'defer', reason: ['an aider task is using the GPU; this choice would swap', ...reason], score_table: scored, alternatives, swap: { needed: true, from, to: top.model, est_ms: Number.isFinite(est) ? est : null }, fit: top.fit, warnings: ['defer until the local task finishes, or switch anyway'], missing: null, suggestion: null };
  }
  return { model: top.model, rule: 'auto', reason, score_table: scored, alternatives, swap: { needed: swapNeeded, from, to: top.model, est_ms: Number.isFinite(est) ? est : null }, fit: top.fit, warnings: top.fit === 'tight' ? ['tight fit'] : [], missing: null, suggestion: null };
}

module.exports = { selectModel, strengthMatch, requiredCap };

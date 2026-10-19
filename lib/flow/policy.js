'use strict';
// Pure escalation policy. Every threshold comes from cfg. Nothing is downloaded.
// Fallback order: ornith:9b, then qwen3.5:9b, then Cursor (only models that are installed).

const REASONS = ['files', 'max_files', 'risk_area', 'diff_size', 'context_size', 'verify_failed>=2', 'no_edit', 'no_progress', 'loop', 'budget'];

function reasonsFor(signals, cfg) {
  const reasons = [];
  const files = Number(signals.files) || 0;
  const dirs = Number(signals.dirs) || 0;
  if (files >= 4 || (files === 3 && dirs > 1)) reasons.push('files');
  if (Number(signals.pinnedFiles) > cfg.LOCAL_MAX_FILES) reasons.push('max_files');
  if (signals.riskArea) reasons.push('risk_area');
  if (Number(signals.estDiff) > cfg.V2_DIFF_CURSOR) reasons.push('diff_size');
  if (Number(signals.requestChars) > cfg.LOCAL_MAX_REQUEST_CHARS) reasons.push('context_size');
  if (Number(signals.verifyFailed) >= 2) reasons.push('verify_failed>=2');
  if (Number(signals.noEdit) >= 2) reasons.push('no_edit');
  if (signals.noProgress) reasons.push('no_progress');
  if (Number(signals.loop) >= 3) reasons.push('loop');
  if (signals.budget || Number(signals.cursorRuns) >= cfg.V2_CURSOR_RUNS) reasons.push('budget');
  return reasons;
}

/** Next local model in the fallback chain that is installed and is not the one that just ran. */
function nextLocal(cfg, signals) {
  const installed = new Set(signals.installed || []);
  const chain = cfg.V2_LOCAL_MODELS || [];
  const current = signals.currentModel || null;
  return chain.find((m) => installed.has(m) && m !== current) || null;
}

function firstLocal(cfg, signals) {
  const installed = new Set(signals.installed || []);
  return (cfg.V2_LOCAL_MODELS || []).find((m) => installed.has(m)) || null;
}

/**
 * @returns {{engine:'local'|'local2'|'cursor'|'fail', model:string|null, reasons:string[]}}
 */
function decide(signals, cfg) {
  const reasons = reasonsFor(signals || {}, cfg);
  if (Number(signals.cursorRuns) >= cfg.V2_CURSOR_RUNS && reasons.includes('budget')) {
    return { engine: 'fail', model: null, reasons };
  }
  if (!reasons.length) {
    const model = signals.currentModel && (signals.installed || []).includes(signals.currentModel) ? signals.currentModel : firstLocal(cfg, signals);
    return model ? { engine: 'local', model, reasons: [] } : { engine: 'cursor', model: null, reasons: [] };
  }
  if (!signals.local2Used) {
    const model = nextLocal(cfg, signals);
    if (model) return { engine: 'local2', model, reasons };
  }
  if (Number(signals.cursorRuns) >= cfg.V2_CURSOR_RUNS) return { engine: 'fail', model: null, reasons };
  return { engine: 'cursor', model: null, reasons };
}

module.exports = { decide, reasonsFor, firstLocal, nextLocal, REASONS };

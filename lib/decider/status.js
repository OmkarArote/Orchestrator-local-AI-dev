'use strict';
// Laya health plus the import check from tools/laya-sidecar/setup.sh. This does not download weights.
const { spawn } = require('node:child_process');
const cfg = require('../../config');
const laya = require('./laya');

const SETUP_PYTHON = 'python3 was not found. Install Python 3, then install laya_mlx yourself.';
const SETUP_MISSING = 'laya_mlx is not installed. Install it yourself (no download is started by the orchestrator). The sidecar listens on 127.0.0.1 and ORCH_LAYA_PORT (default 4327).';

function importCheck() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const child = spawn(cfg.LAYA_PYTHON, ['-c', 'import laya_mlx'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      done({ ok: false, reason: SETUP_MISSING });
    }, 4000);
    child.on('error', () => { clearTimeout(timer); done({ ok: false, reason: SETUP_PYTHON }); });
    child.on('exit', (code) => { clearTimeout(timer); done(code === 0 ? { ok: true, reason: null } : { ok: false, reason: SETUP_MISSING }); });
  });
}

async function ornithInstalled(listModels) {
  try {
    const listed = await (listModels || require('../ollama').listModels)();
    const names = ((listed && listed.models) || []).map((m) => m.name || m.model || '');
    return names.some((n) => n === 'ornith:9b' || String(n).startsWith('ornith'));
  } catch { return false; }
}

async function status({ listModels, autostart = false } = {}) {
  if (autostart) await laya.ensureStarted();
  const [imp, health, ornith] = await Promise.all([importCheck(), laya.health(), ornithInstalled(listModels)]);
  const layaUp = !!(health && health.ok);
  const backend = layaUp ? 'laya' : ornith ? 'ornith' : 'down';
  const fallback = layaUp ? null : (imp.ok ? ((health && health.error) || 'sidecar down') : imp.reason);
  return { backend, laya: layaUp, ornith, setup: imp.ok ? null : imp.reason, fallback };
}

module.exports = { status, importCheck, SETUP_MISSING, SETUP_PYTHON };

'use strict';
// Local Laya sidecar. Health-check first. Start it only when the decider flag asks, and stop it before a coder model loads.
const path = require('node:path');
const { spawn } = require('node:child_process');
const cfg = require('../../config');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'laya-sidecar', 'server.py');
let child = null;

function port() {
  const n = Number(process.env.ORCH_LAYA_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : cfg.LAYA_PORT;
}

function base() {
  return `http://127.0.0.1:${port()}`;
}

async function health() {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(800) });
    const json = await r.json().catch(() => null);
    return { ok: r.ok && !!(json && json.ok), status: r.status, json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ensureStarted() {
  const up = await health();
  if (up.ok) return up;
  if (process.env.ORCH_LAYA_AUTOSTART === '0' || !cfg.LAYA_AUTOSTART) return up;
  if (child) return health();
  child = spawn(cfg.LAYA_PYTHON, [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, ORCH_LAYA_PORT: String(cfg.LAYA_PORT), ORCH_LAYA_MODEL: cfg.LAYA_MODEL || '' },
    stdio: 'ignore',
  });
  child.on('exit', () => { child = null; });
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const again = await health();
    if (again.ok) return again;
  }
  return health();
}

async function decide(state, questions) {
  const up = await ensureStarted();
  if (!up.ok) return { ok: false, error: (up.json && up.json.error) || up.error || 'laya sidecar is down' };
  const r = await fetch(`${base()}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || !json.answers) return { ok: false, error: (json && json.error) || `laya HTTP ${r.status}` };
  return { ok: true, answers: json.answers, confidence: Number(json.confidence) || 0 };
}

function stop() {
  if (!child) return false;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  child = null;
  return true;
}

module.exports = { health, ensureStarted, decide, stop };

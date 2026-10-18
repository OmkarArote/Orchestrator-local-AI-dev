'use strict';
const { spawn, execFile } = require('node:child_process');
const cfg = require('../config');

const PATH = [
  `${process.env.HOME}/.nvm/versions/node/v22.16.0/bin`,
  `${process.env.HOME}/.local/bin`,
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || '',
].join(':');
const baseEnv = () => ({ ...process.env, PATH, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' });

/**
 * Spawn a process with a HARD timeout (kills the whole process group), streaming
 * stdout+stderr line by line to onLine. Never rejects.
 * Resolves { code, signal, timedOut, error }.
 */
function run(cmd, args, { cwd, timeoutMs, onLine, env, onSpawn, maxLine = 20000, replaceEnv = false } = {}) {
  return new Promise((resolve) => {
    let child, done = false, timedOut = false, timer, hardTimer;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(hardTimer);
      resolve({ timedOut, ...r });
    };
    try {
      child = spawn(cmd, args, { cwd, env: replaceEnv ? { ...env } : { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { return finish({ code: -1, error: e.message }); }
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    if (onSpawn) onSpawn(() => kill('SIGTERM'));

    const bufs = { out: '', err: '' };
    const feed = (which) => (chunk) => {
      bufs[which] += chunk.toString('utf8');
      const parts = bufs[which].split(/\r\n|\n|\r/);
      bufs[which] = parts.pop();
      if (bufs[which].length > maxLine) { parts.push(bufs[which]); bufs[which] = ''; }
      if (onLine) for (const l of parts) if (l.trim() !== '') onLine(l, which);
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    child.on('error', (e) => finish({ code: -1, error: e.message }));
    child.on('close', (code, signal) => {
      for (const w of ['out', 'err']) if (bufs[w].trim() && onLine) onLine(bufs[w], w);
      finish({ code, signal });
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (onLine) onLine(`[orchestrator] TIMEOUT after ${Math.round(timeoutMs / 1000)}s - killing process group`, 'err');
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5000).unref();
      hardTimer = setTimeout(() => finish({ code: -1, error: 'timeout (no close event)' }), 10000);
    }, timeoutMs || 60000);
  });
}

/** Run git and collect output. Never rejects. */
function git(cwd, args, { timeoutMs = cfg.GIT_TIMEOUT_MS, maxBuffer = 32 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer, env: { ...baseEnv(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...env } },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        out: String(stdout || ''), err: String(stderr || ''), error: err ? err.message : null,
      }));
  });
}

module.exports = { run, git, PATH };

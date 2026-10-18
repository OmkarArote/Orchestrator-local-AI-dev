'use strict';
// Tiny in-memory job tracker for long operations (clone import, later model pulls). State is NOT persisted: a restart forgets jobs
// (the fs journal + startup sweep clean up whatever a killed job left on disk). Everything shown goes through redact().
const crypto = require('node:crypto');
const { redact } = require('./safegit');

const jobs = new Map();
const MAX_KEEP = 60, TTL_MS = 60 * 60 * 1000, MAX_LINES = 300;

function prune() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.finished_at && now - j.finished_at > TTL_MS) jobs.delete(id);
  if (jobs.size > MAX_KEEP) for (const [id, j] of jobs) { if (j.finished_at) { jobs.delete(id); if (jobs.size <= MAX_KEEP) break; } }
}

function create(kind, label, meta = {}) {
  prune();
  const job = {
    id: crypto.randomBytes(8).toString('hex'), kind, label: redact(String(label)).slice(0, 200), meta,
    state: 'queued', phase: 'queued', percent: 0, lines: [], result: null, error: null, error_code: null,
    created_at: Date.now(), started_at: null, finished_at: null, cancelled: false, _cancel: null,
  };
  jobs.set(job.id, job);
  return job;
}
const get = (id) => jobs.get(String(id)) || null;
const list = () => [...jobs.values()].sort((a, b) => b.created_at - a.created_at);
const running = (kind) => [...jobs.values()].filter((j) => !j.finished_at && (!kind || j.kind === kind));

function log(job, line) {
  const t = redact(String(line)).slice(0, 500);
  job.lines.push(t);
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
}
function setPhase(job, phase, percent) { job.phase = phase; if (typeof percent === 'number') job.percent = Math.max(job.percent, Math.min(100, percent)); }
function start(job) { job.state = 'running'; job.started_at = Date.now(); }
function finish(job, state, { result = null, error = null, code = null } = {}) {
  if (job.finished_at) return;
  job.state = state; job.finished_at = Date.now(); job.result = result; job.error = error ? redact(String(error)).slice(0, 600) : null; job.error_code = code;
  if (state === 'done') { job.percent = 100; job.phase = 'done'; }
  job._cancel = null;
}
/** Request cancellation: marks the job and runs the registered canceller (kills the child process group). */
function cancel(job) {
  if (job.finished_at) return false;
  job.cancelled = true;
  if (job._cancel) { try { job._cancel(); } catch { /* process already gone */ } }
  return true;
}
function view(job) {
  return {
    id: job.id, kind: job.kind, label: job.label, meta: job.meta, state: job.state, phase: job.phase, percent: job.percent,
    lines: job.lines.slice(-60), result: job.result, error: job.error, error_code: job.error_code, cancelled: job.cancelled,
    created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
    elapsed_ms: (job.finished_at || Date.now()) - (job.started_at || job.created_at),
  };
}
module.exports = { create, get, list, running, log, setPhase, start, finish, cancel, view };

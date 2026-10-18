'use strict';
// Clone import: `git clone` of an https/ssh remote into a STAGING directory next to the final target, then an atomic rename and the DB row.
// Safety (docs/PLAN 3.4): URL validated by safegit.parseRemote (https/ssh only, no credentials, no option injection), ls-remote pre-flight,
// hardened git (env allowlist, no prompts, hooks off, no submodule recursion), staging dir `.orch-clone-*` inside an authorized root and journaled,
// cancel/failure removes ONLY the staging dir (fsguard.removeOwnedDir), a crash is swept at startup, nothing from the repo is ever executed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../config');
const store = require('./db');
const roots = require('./roots');
const fsg = require('./fsguard');
const sg = require('./safegit');
const projects = require('./projects');
const so = require('./service-ops');
const jobs = require('./jobs');
const { bad, conflict, forbidden } = require('./errors');

const MAX_PARALLEL = 2;
const CLONE_TIMEOUT_MS = Number(process.env.ORCH_CLONE_TIMEOUT_MS) || 20 * 60 * 1000;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const inFlight = new Set(); // target paths and normalized remotes currently being imported

function deriveDirName(parsed) {
  const last = parsed.path.replace(/\/+$/, '').split('/').pop().replace(/\.git$/i, '');
  return last;
}

const cloneParents = () => roots.list().map((r) => r.path);
const policyFor = (extra = {}) => ({ ...so.ownPolicy(), cloneParents: cloneParents(), ...extra });

/** Synchronous validation; returns the plan or throws a ProjectError (400/403/409). Nothing is written. */
function plan(project, body) {
  if (project.archived) throw conflict(`project '${project.name}' is archived`);
  const parsed = sg.parseRemote(body.url);
  const name = so.checkName(body.name || deriveDirName(parsed));
  so.uniqueServiceName(project, name);
  const dirName = so.checkName(body.dir_name || deriveDirName(parsed) || name, 'dir_name');
  let branch = null;
  if (body.branch !== undefined && body.branch !== null && String(body.branch).trim() !== '') {
    branch = String(body.branch).trim();
    if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) throw bad('invalid branch name');
  }
  const type = so.checkType(body.type), stack = so.checkStack(body.stack);
  const parent = roots.guard.resolveInRoots(body.dest_parent || project.root_dir || cfg.PROJECTS_PARENT, { label: 'dest_parent', mustExist: true });
  if (!fs.statSync(parent).isDirectory()) throw bad('dest_parent is not a directory');
  let target;
  try { target = roots.guard.resolveInRoots(path.join(parent, dirName), { label: 'target directory', forCreate: true, allowRoot: false }); }
  catch (e) { if (e && e.extra && e.extra.code === 'exists') throw conflict(e.message, e.extra); throw e; }
  const dup = store.findServiceByRemote(parsed.normalized);
  if (dup) throw conflict(`this remote is already registered as service '${dup.name}' (project #${dup.project_id}); a remote can back only one active service (archive that one first)`, { service_id: dup.id });
  if (store.allServices({ includeArchived: true }).some((s) => s.local_path && fsg.same(fsg.real(s.local_path) || s.local_path, target))) throw conflict('target directory is already registered as a service');
  if (inFlight.has(target) || inFlight.has(parsed.normalized)) throw conflict('an import of this remote or into this directory is already running');
  if (jobs.running('import').length >= MAX_PARALLEL) throw conflict(`at most ${MAX_PARALLEL} imports run at once; wait for one to finish`);
  return { parsed, name, dirName, branch, type, stack, parent, target, description: String(body.description ?? '').trim().slice(0, 2000),
    check_cmd: projects.checkCmdOf(body.check_cmd, 'check_cmd') || null, install_cmd: projects.checkCmdOf(body.install_cmd, 'install_cmd') || null };
}

/** Validate, create the job and start cloning in the background. Returns the job view immediately. */
function start(project, body) {
  const p = plan(project, body);
  const job = jobs.create('import', `Import ${sg.redact(p.parsed.url)} as ${p.name}`, { project_id: project.id, name: p.name, target: p.target, url: sg.redact(p.parsed.url) });
  inFlight.add(p.target); inFlight.add(p.parsed.normalized);
  run(job, project, p).catch((e) => { jobs.finish(job, 'failed', { error: e.message || String(e) }); }).finally(() => { inFlight.delete(p.target); inFlight.delete(p.parsed.normalized); });
  return jobs.view(job);
}

async function run(job, project, p) {
  jobs.start(job);
  let staging = null, stagingJid = null, finalJid = null, renamed = false;
  const cleanup = () => {
    if (staging) { try { fsg.removeOwnedDir(staging, policyFor({ isOwned: (x) => store.journalOpenHas(x) || x === staging })); } catch (e) { console.error('[importer] staging cleanup refused:', e.message); } }
    if (renamed) { try { fsg.removeOwnedDir(p.target, policyFor()); } catch (e) { console.error('[importer] target cleanup refused:', e.message); } }
    if (stagingJid) store.journalSet(stagingJid, 'cleaned');
    if (finalJid) store.journalSet(finalJid, 'cleaned');
  };
  const fail = (msg, code) => { cleanup(); jobs.finish(job, job.cancelled ? 'cancelled' : 'failed', { error: job.cancelled ? 'cancelled' : msg, code }); };
  try {
    // 1. pre-flight: reachability/auth/default branch with zero disk writes
    jobs.setPhase(job, 'checking remote', 1); jobs.log(job, `ls-remote ${sg.redact(p.parsed.url)}`);
    job._cancel = null;
    const pre = await sg.lsRemote(p.parsed.url, { timeoutMs: 30000 });
    if (job.cancelled) return fail('cancelled');
    if (!pre.ok) { jobs.log(job, `pre-flight failed: ${pre.error}`); return fail(pre.error, 'preflight'); }
    if (pre.empty) { return fail('the remote repository is empty (no commits); nothing to import', 'empty'); }
    for (const w of p.parsed.warnings) jobs.log(job, `warning: ${w}`);

    // 2. staging clone (journaled; hidden `.orch-clone-*` sibling of the target so the final rename is atomic on the same file system)
    staging = path.join(p.parent, `.orch-clone-${crypto.randomBytes(6).toString('hex')}`);
    roots.guard.resolveInRoots(staging, { label: 'staging directory', forCreate: true, allowHidden: true });
    stagingJid = store.journalAdd('clone_staging', staging);
    jobs.setPhase(job, 'cloning', 3);
    const args = ['clone', '--progress', '--no-recurse-submodules', ...(p.branch ? ['--branch', p.branch] : []), '--', p.parsed.url, staging];
    const r = await sg.gitStream(p.parent, args, {
      timeoutMs: CLONE_TIMEOUT_MS, hooks: 'off',
      onSpawn: (kill) => { job._cancel = kill; },
      onLine: (line) => { const pc = sg.parseProgress(line); if (pc !== null) jobs.setPhase(job, 'cloning', pc); if (!/^\s*$/.test(line)) { if (pc === null || /done\.?$/.test(line)) jobs.log(job, line); } },
    });
    job._cancel = null;
    if (job.cancelled) return fail('cancelled');
    if (r.timedOut) return fail(`clone timed out after ${Math.round(CLONE_TIMEOUT_MS / 60000)} min`, 'timeout');
    if (r.code !== 0) return fail(sg.friendlyGitError(job.lines.slice(-8).join('\n')) || 'git clone failed', 'clone');

    // 3. verify what we got, then move into place atomically
    jobs.setPhase(job, 'verifying', 96);
    roots.guard.recheck(staging, 'staging directory');
    const info = await so.gitInfo(staging);
    if (!info.is_git_repo || !info.is_toplevel || !info.has_commits || !info.default_branch) return fail('the clone did not produce a usable git repository (no commits / no default branch)', 'unusable');
    const branch = p.branch || info.default_branch;
    if (job.cancelled) return fail('cancelled');
    try { fs.lstatSync(p.target); return fail(`target directory appeared while cloning: ${p.target}`, 'exists'); } catch { /* absent: good */ }
    finalJid = store.journalAdd('new_service', p.target);
    fs.renameSync(staging, p.target); renamed = true; staging = null;
    roots.guard.recheck(p.target, 'target directory');
    store.journalSet(stagingJid, 'committed');
    const stack = p.stack || ((projects.detectStack(p.target) || {}).kind !== 'unknown' ? (projects.detectStack(p.target) || {}).kind : '') || '';
    const warnings = [...p.parsed.warnings];
    const id = store.createService({ project_id: project.id, name: p.name, path: '.', description: p.description, check_cmd: p.check_cmd || (projects.detectStack(p.target) || {}).suggested_check_cmd || null, install_cmd: p.install_cmd,
      local_path: p.target, remote_url: p.parsed.url, normalized_remote: p.parsed.normalized, default_branch: branch, type: p.type, stack, status: 'active', origin: 'import' });
    store.journalSet(finalJid, 'committed'); finalJid = null; renamed = false;
    jobs.log(job, `imported as service '${p.name}' (${branch}) at ${p.target}`);
    jobs.finish(job, 'done', { result: { service_id: id, service: store.getService(id), path: p.target, default_branch: branch, warnings } });
  } catch (e) {
    return fail(sg.redact(e.message || String(e)), 'error');
  }
}

function cancelJob(job) { return jobs.cancel(job); }

module.exports = { start, plan, cancelJob, inFlight, MAX_PARALLEL };

'use strict';
// Service -> repo resolution. Every former `project.path` / `project.default_branch` read goes through here.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const store = require('./db');
const roots = require('./roots');
const fsg = require('./fsguard');

const realOr = (p) => fsg.real(p) || path.resolve(p);

/** Canonical repo key of a service: realpath(local_path). Concurrency/worktree key (two services may share a repo). */
const repoKeyOf = (service) => (service && service.local_path ? realOr(service.local_path) : null);

/** Two services conflict when they share a repo and their subdirs overlap ('.' overlaps everything). */
function overlaps(a, b) {
  if (!a || !b) return true; // unknown = conservative
  if (repoKeyOf(a) !== repoKeyOf(b)) return false;
  const x = a.path || '.', y = b.path || '.';
  if (x === '.' || y === '.') return true;
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

/** Worktree dir for a NEW run: <WORKTREES>/<project.slug>/<service.name>/task-<id>. Tasks that recorded worktree_path keep it. */
const worktreeFor = (task, project, service) => task.worktree_path || path.join(cfg.WORKTREES, project.slug || project.name, service.name, `task-${task.id}`);

/** Throws a human-readable Error when the service cannot be used (before any git command is run). */
function assertUsable(service) {
  if (!service) throw new Error('task has no service');
  if (!service.local_path) throw new Error(`service '${service.name}' has no repository location`);
  const lp = service.local_path;
  if (!fs.existsSync(lp)) throw new Error(`service '${service.name}': repository ${lp} does not exist (status ${service.status})`);
  try { roots.guard.resolveInRoots(lp, { label: `service '${service.name}' location`, mustExist: true, allowHidden: true }); }
  catch (e) { throw new Error(`service '${service.name}': ${e.message} - authorize the root in the dashboard first`); }
  return realOr(lp);
}

/** Everything the runner/merge/diff code needs about the repo behind a task. */
function resolveService(task) {
  const service = task.service_id ? store.getService(task.service_id) : null;
  if (!service) return null;
  const project = store.getProject(task.project_id);
  return { service, project, repoRoot: service.local_path ? realOr(service.local_path) : null, subdir: service.path || '.', defaultBranch: service.default_branch || 'main', repoKey: repoKeyOf(service) };
}

/** The repo-level view used by git-ops/memory when only a task is at hand. Throws if unusable. */
function repoOfTask(task) {
  const r = resolveService(task);
  if (!r) throw new Error(`task #${task.id} has no service`);
  r.repoRoot = assertUsable(r.service);
  return r;
}

/** The service that stands for the whole repo of a project (legacy 'add project' flows; monorepo subfolder services hang off it). */
function homeService(project) {
  const all = store.listServices(project.id).filter((s) => s.local_path);
  return all.find((s) => s.path === '.') || all[0] || null;
}

module.exports = { homeService, repoKeyOf, overlaps, worktreeFor, assertUsable, resolveService, repoOfTask, realOr };

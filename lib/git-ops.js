'use strict';
// Diff / merge / worktree cleanup of a task branch. Everything operates on the repo of the task's SERVICE (never on a "project repo").
const fs = require('node:fs');
const cfg = require('../config');
const { git } = require('./proc');
const { branchOf } = require('./paths');
const repo = require('./repo');

/** Diff of a task's branch vs its service's default branch (text, truncated). */
async function taskDiff(task) {
  if (!task.branch) return { stat: '', diff: '', note: 'no branch yet' };
  let r;
  try { r = repo.repoOfTask(task); } catch (e) { return { stat: '', diff: '', note: e.message }; }
  const base = task.base_ref || r.defaultBranch; // stacked sequence steps diff against the previous step's branch
  const wt = repo.worktreeFor(task, r.project, r.service);
  const live = ['running', 'checking'].includes(task.status) && fs.existsSync(wt);
  let args, statArgs, cwd;
  if (live) { // in-progress: working tree vs merge-base (tracked files only)
    const mb = (await git(wt, ['merge-base', base, 'HEAD'])).out.trim();
    cwd = wt; args = ['diff', mb]; statArgs = ['diff', '--stat', mb];
  } else {
    const range = `${base}...${task.branch}`;
    cwd = r.repoRoot; args = ['diff', range]; statArgs = ['diff', '--stat', range];
  }
  const [d, s] = await Promise.all([git(cwd, args), git(cwd, statArgs)]);
  if (d.code !== 0) return { stat: '', diff: '', note: `git diff failed: ${(d.err || d.error || '').trim()}` };
  let diff = d.out, truncated = false;
  if (Buffer.byteLength(diff) > cfg.MAX_DIFF_BYTES) { diff = diff.slice(0, cfg.MAX_DIFF_BYTES); truncated = true; }
  return { stat: s.out, diff, truncated, note: live ? 'live (uncommitted, tracked files only)' : `${base}...${task.branch}`, repo: r.repoRoot, service: r.service.name };
}

/** Read-only merge pre-flight for ONE task (its service's repo): on the base branch, clean working copy, branch exists, tip unchanged since review. */
async function mergePreflight(task) {
  let r;
  try { r = repo.repoOfTask(task); } catch (e) { return { ok: false, message: e.message, repo: null }; }
  const root = r.repoRoot, base = r.defaultBranch, branch = task.branch || branchOf(task);
  const out = { ok: false, message: '', repo: root, base, branch, service: r.service.name, root, tip: null };
  const cur = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (cur !== base) { out.message = `service repo is on '${cur}', not '${base}'; refusing to merge`; return out; }
  const st = await git(root, ['status', '--porcelain']);
  if (st.code !== 0) { out.message = `git status failed: ${st.err || st.error}`; return out; }
  if (st.out.trim()) { out.message = `service repo working copy is not clean; commit/stash first:\n${st.out.trim().slice(0, 600)}`; return out; }
  const tip = (await git(root, ['rev-parse', '--verify', `${branch}^{commit}`])).out.trim();
  if (!tip) { out.message = `branch ${branch} not found`; return out; }
  out.tip = tip;
  if (task.head_sha && tip !== task.head_sha) { out.message = `branch ${branch} moved since review (${task.head_sha.slice(0, 7)} -> ${tip.slice(0, 7)}); re-review needed`; return out; }
  out.ok = true; out.message = 'ready to merge';
  return out;
}

/** Pre-flight + merge of a reviewed task branch into the SERVICE's default branch with --no-ff, only if safe (per-task approval, one repo). */
async function mergeTask(task) {
  const pf = await mergePreflight(task);
  if (!pf.ok) return { ok: false, message: pf.message };
  const { root, base, branch } = pf;
  const msg = `Merge ${branch}: ${task.title}\n\nApproved by human via local AI dev dashboard.`;
  const m = await git(root, ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost', 'merge', '--no-ff', '-m', msg, branch]);
  if (m.code !== 0) {
    const ab = await git(root, ['merge', '--abort']);
    return { ok: false, message: `merge failed (aborted, exit ${ab.code}): ${(m.err + m.out).trim().slice(0, 600)}` };
  }
  const sha = (await git(root, ['rev-parse', 'HEAD'])).out.trim();
  return { ok: true, message: `merged ${branch} into ${base} @ ${sha.slice(0, 7)}`, sha };
}

/** A branch this task created. Never a default, dev, uat, or live name. */
function ownTaskBranch(task, branch) {
  const id = Number(task.id);
  return Number.isInteger(id) && id > 0 && (branch === `ai/task-${id}` || branch.startsWith(`ai/task-${id}-`));
}

/** Remove the worktree, then delete the task's own local branch. The service checkout and protected branches are left alone. Nothing is pushed. */
async function discardTaskBranch(task) {
  let r;
  try { r = repo.repoOfTask(task); } catch (e) {
    if (!task.branch) return { ok: true, message: 'no branch to delete' };
    return { ok: false, message: e.message };
  }
  const branch = task.branch;
  if (!branch) return { ok: true, message: 'no branch to delete' };
  if (!ownTaskBranch(task, branch)) return { ok: false, message: `refusing to delete '${branch}' (not this task's branch)` };
  const protectedNames = new Set([r.defaultBranch, r.service.dev_branch, r.service.uat_branch, r.service.live_branch].filter(Boolean));
  if (protectedNames.has(branch)) return { ok: false, message: `refusing to delete protected branch '${branch}'` };
  const root = r.repoRoot;
  const cur = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  if (cur === branch) return { ok: false, message: `refusing to delete '${branch}': it is checked out in the service repo` };
  const wtNote = await removeWorktree(task);
  if (String(wtNote).startsWith('worktree remove failed')) return { ok: false, message: wtNote };
  await git(root, ['worktree', 'prune']);
  const exists = await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists.code !== 0) return { ok: true, message: `branch ${branch} already gone; ${wtNote}` };
  const del = await git(root, ['branch', '-D', '--', branch]);
  if (del.code !== 0) return { ok: false, message: `could not delete branch ${branch}: ${(del.err || del.out || del.error || '').trim().slice(0, 400)}` };
  return { ok: true, message: `deleted branch ${branch}; ${wtNote}` };
}

/** Remove a task's worktree (keeps the branch). */
async function removeWorktree(task) {
  let r;
  try { r = repo.repoOfTask(task); } catch (e) { return `worktree not removed: ${e.message}`; }
  const wt = repo.worktreeFor(task, r.project, r.service);
  if (!fs.existsSync(wt)) return 'no worktree';
  const rm = await git(r.repoRoot, ['worktree', 'remove', '--force', wt]);
  return rm.code === 0 ? 'worktree removed' : `worktree remove failed: ${(rm.err || rm.error || '').trim()}`;
}

module.exports = { taskDiff, mergeTask, mergePreflight, removeWorktree, discardTaskBranch };

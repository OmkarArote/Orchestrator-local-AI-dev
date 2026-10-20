'use strict';
// Merge a task branch into a service's dev, uat, or live branch.
// The merge happens in a temporary worktree. The user's checkout is never the cwd.
// The target ref moves only after the check passes, and only as a fast-forward of the sha recorded first.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../../config');
const store = require('../db');
const repoMod = require('../repo');
const { git } = require('../proc');

const ROLES = ['dev', 'uat', 'live'];
const PROTECTED = new Set(['uat', 'live']);

function roleBranch(service, role) {
  if (!ROLES.includes(role)) return null;
  const name = service && service[`${role}_branch`];
  return name ? String(name) : null;
}

function logMerge(id, obj) {
  store.addEvent(id, 'merge', JSON.stringify({ phase: 'merge', ...obj }));
}

async function refSha(root, branch) {
  const r = await git(root, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  return r.code === 0 ? r.out.trim() : null;
}

async function removeWorktree(root, dir) {
  if (!dir || !fs.existsSync(dir)) return;
  await git(root, ['worktree', 'remove', '--force', dir]);
}

function mergeDir(task, role, label) {
  const dir = path.join(cfg.WORKTREES, '_env-merge', `${label}-${task.id}-${role}-${Date.now()}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return dir;
}

async function taskTipClean(task, root) {
  const branch = task.branch;
  const tip = branch ? await refSha(root, branch) : null;
  if (!tip) return { error: `branch ${branch || '(none)'} not found` };
  if (task.head_sha && tip !== task.head_sha) return { error: `branch ${branch} moved since review (${String(task.head_sha).slice(0, 7)} -> ${tip.slice(0, 7)})` };
  const wt = task.worktree_path && fs.existsSync(task.worktree_path) ? task.worktree_path : null;
  if (wt) {
    const st = await git(wt, ['status', '--porcelain']);
    if ((st.out || '').trim()) return { error: 'task branch worktree is not clean' };
    const head = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
    if (head !== tip) return { error: 'task worktree HEAD does not match the branch tip' };
  }
  return { tip, wt };
}

async function checkAt(task, project, service, cwd) {
  const runner = require('../runner');
  const sub = service.path && service.path !== '.' ? path.join(cwd, service.path) : cwd;
  return runner.runCheck({
    task, project, service, root: sub, wt: cwd,
    checkCmd: task.check_cmd || service.check_cmd || project.check_cmd || cfg.DEFAULT_CHECK,
    checkLines: [], state: { cancelled: false }, onSpawn() {},
  });
}

async function rolledBack(task, root, wt, { role, source, target, recorded, reason, cursorTaskId }) {
  if (wt) {
    await git(wt, ['merge', '--abort']);
    if (recorded) await git(wt, ['reset', '--hard', recorded]);
    await removeWorktree(root, wt);
  }
  const now = target ? await refSha(root, target) : null;
  logMerge(task.id, { status: 'merge_rolled_back', role, source, target, target_sha: recorded, reason, target_unchanged: now === recorded, cursor_task_id: cursorTaskId || null });
  return { ok: false, status: 409, message: reason, target_sha: recorded, target_unchanged: now === recorded, cursor_task_id: cursorTaskId || null };
}

/**
 * @param {object} task
 * @param {string} role dev|uat|live
 * @param {{confirm?: boolean, source?: string, target?: string}} opts
 */
async function mergeTo(task, role, opts = {}) {
  if (!ROLES.includes(role)) return { ok: false, status: 400, message: `role must be one of ${ROLES.join(', ')}` };
  if (!['review', 'done'].includes(task.status)) return { ok: false, status: 409, message: `cannot merge: status is '${task.status}'` };
  let located;
  try { located = repoMod.repoOfTask(task); }
  catch (e) { return { ok: false, status: 409, message: e.message }; }
  const { service, project, repoRoot: root } = located;
  const target = roleBranch(service, role);
  const source = task.branch || null;
  if (!target) return { ok: false, status: 400, message: `service '${service.name}' has no ${role}_branch configured` };
  if (!source) return { ok: false, status: 409, message: 'task has no branch' };
  if (PROTECTED.has(role) && (!opts.confirm || opts.source !== source || opts.target !== target)) {
    return { ok: false, status: 409, needs_confirm: true, source, target, role, message: `Merge ${source} into ${target}? Confirm to merge the protected ${role} branch.` };
  }
  const recorded = await refSha(root, target);
  if (!recorded) return { ok: false, status: 400, message: `branch '${target}' not found in ${root}` };
  const clean = await taskTipClean(task, root);
  if (clean.error) return rolledBack(task, root, null, { role, source, target, recorded, reason: clean.error });

  let checkWt = clean.wt;
  let ownedCheck = false;
  if (!checkWt) {
    checkWt = mergeDir(task, role, 'check');
    const add = await git(root, ['worktree', 'add', '--detach', checkWt, clean.tip]);
    if (add.code !== 0) return rolledBack(task, root, null, { role, source, target, recorded, reason: `could not check out the task branch: ${(add.err || add.out || '').trim()}` });
    ownedCheck = true;
  }
  const first = await checkAt(task, project, service, checkWt);
  if (ownedCheck) await removeWorktree(root, checkWt);
  if (!first.ok) return rolledBack(task, root, null, { role, source, target, recorded, reason: `check on ${source} failed: ${first.note}` });
  if ((await refSha(root, target)) !== recorded) return rolledBack(task, root, null, { role, source, target, recorded, reason: `${target} moved before the merge` });

  const wt = mergeDir(task, role, 'merge');
  const added = await git(root, ['worktree', 'add', '--detach', wt, recorded]);
  if (added.code !== 0) return rolledBack(task, root, null, { role, source, target, recorded, reason: `could not create the merge worktree: ${(added.err || added.out || '').trim()}` });
  const merged = await git(wt, ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost', 'merge', '--no-edit', '-m', `Merge ${source} into ${target}`, source]);
  let resolvedConflicts = false;
  if (merged.code !== 0) {
    const resolved = await resolveConflicts(wt, task, { role, source, target, recorded, root, checkNote: first.note, mergeOutput: (merged.err + merged.out).trim() });
    if (!resolved.ok) return resolved;
    resolvedConflicts = true;
  }
  const second = await checkAt(task, project, service, wt);
  if (!second.ok) {
    const reason = `check on the merged tree failed: ${second.note}`;
    if (resolvedConflicts) {
      const cursorTaskId = await openCursorTask(task, { role, source, target, base: task.base_ref || target, files: [], checkNote: second.note, reason });
      return rolledBack(task, root, wt, { role, source, target, recorded, reason, cursorTaskId });
    }
    return rolledBack(task, root, wt, { role, source, target, recorded, reason });
  }
  const newSha = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
  const ff = await git(root, ['merge-base', '--is-ancestor', recorded, newSha]);
  if (ff.code !== 0) return rolledBack(task, root, wt, { role, source, target, recorded, reason: 'merged result is not a descendant of the recorded target' });
  const upd = await git(root, ['update-ref', `refs/heads/${target}`, newSha, recorded]);
  if (upd.code !== 0) return rolledBack(task, root, wt, { role, source, target, recorded, reason: `fast-forward of ${target} refused: ${(upd.err || upd.out || '').trim()}` });
  await removeWorktree(root, wt);
  const now = await refSha(root, target);
  logMerge(task.id, { status: 'merged', role, source, target, target_sha: recorded, sha: now, check: second.note });
  return { ok: true, role, source, target, sha: now, message: `merged ${source} into ${target} @ ${String(now).slice(0, 7)}` };
}

async function pushTarget(task, role) {
  if (!ROLES.includes(role)) return { ok: false, status: 400, message: `role must be one of ${ROLES.join(', ')}` };
  let located;
  try { located = repoMod.repoOfTask(task); }
  catch (e) { return { ok: false, status: 409, message: e.message }; }
  const target = roleBranch(located.service, role);
  if (!target) return { ok: false, status: 400, message: `service '${located.service.name}' has no ${role}_branch configured` };
  const events = store.eventsAfter(task.id, 0, 5000);
  const merged = events.some((e) => {
    if (e.kind !== 'merge' || !e.message || e.message[0] !== '{') return false;
    try { const j = JSON.parse(e.message); return j.status === 'merged' && j.role === role && j.target === target; }
    catch { return false; }
  });
  if (!merged) return { ok: false, status: 409, message: `merge into ${target} before pushing` };
  const pushed = await git(located.repoRoot, ['push', 'origin', `refs/heads/${target}:refs/heads/${target}`]);
  if (pushed.code !== 0) {
    logMerge(task.id, { status: 'push_failed', role, target, reason: (pushed.err || pushed.out || '').trim().slice(0, 400) });
    return { ok: false, status: 409, message: `push of ${target} failed: ${(pushed.err || pushed.out || '').trim().slice(0, 400)}` };
  }
  logMerge(task.id, { status: 'pushed', role, target });
  return { ok: true, message: `pushed ${target}` };
}

async function unmerged(wt) {
  const r = await git(wt, ['diff', '--name-only', '--diff-filter=U']);
  return (r.out || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function readConflict(wt, name) {
  const abs = path.join(wt, name);
  let buf = Buffer.alloc(0);
  try { buf = fs.readFileSync(abs); } catch { /* missing */ }
  const binary = buf.includes(0);
  return { path: name, text: binary ? '\0' : buf.toString('utf8'), binary };
}

async function openCursorTask(task, info) {
  const hunkText = (info.files || []).map((f) => `## ${f.path}\n${String(f.text || '').slice(0, 8000)}`).join('\n\n');
  const prompt = [
    `Resolve the merge of task #${task.id} (${task.branch}) into ${info.target}.`,
    `Base branch: ${info.base}. Target branch: ${info.target}.`,
    `Original task prompt:\n${task.prompt || ''}`,
    `Plan:\n${task.plan_text || '(no plan)'}`,
    `Check output:\n${info.checkNote || '(none)'}`,
    `Why the local merge stopped: ${info.reason}`,
    `Conflicted files and hunks:\n${hunkText || '(none)'}`,
  ].join('\n\n').slice(0, 50000);
  const id = store.createTask({
    project_id: task.project_id, service_id: task.service_id, title: `Resolve merge of #${task.id} into ${info.target}`.slice(0, 200),
    prompt, files: (info.files || []).map((f) => f.path).slice(0, 20), engine: 'cursor', allow_escalation: false, plan_first: false, routing_source: 'manual',
  });
  store.updateFields(id, { flow: 'v1' });
  store.addEvent(id, 'system', `created from merge_rolled_back of task #${task.id} (pending; Cursor runs after approve-start)`);
  return id;
}

async function resolveConflicts(wt, task, info) {
  const names = await unmerged(wt);
  if (!names.length) return rolledBack(task, info.root, wt, { ...info, reason: `merge of ${info.source} into ${info.target} failed: ${String(info.mergeOutput || '').slice(0, 500)}` });
  const files = names.map((n) => readConflict(wt, n));
  const gate = require('./conflicts').canAutoResolve(files);
  const base = task.base_ref || info.target;
  const fail = async (reason) => {
    const cursorTaskId = await openCursorTask(task, { ...info, base, files, reason });
    return rolledBack(task, info.root, wt, { ...info, reason, cursorTaskId });
  };
  if (!gate.ok) return fail(gate.reason);
  const ollama = require('../ollama');
  const model = require('../models').effective('coding').model;
  for (const f of files) {
    const reply = await ollama.chat('ollama', {
      model, stream: false, ...require('./roles').chatFields('merge'),
      messages: [
        { role: 'system', content: 'Resolve this git conflict. Return only the file body. No conflict markers, no markdown fences.' },
        { role: 'user', content: `File ${f.path}:\n${f.text}` },
      ],
    });
    let body = reply && reply.ok ? String(reply.content || '').trim() : '';
    body = body.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    if (!body || body.includes('<<<<<<<') || body.includes('>>>>>>>')) return fail(`resolution failed for ${f.path}`);
    fs.writeFileSync(path.join(wt, f.path), body.endsWith('\n') ? body : `${body}\n`);
  }
  const added = await git(wt, ['add', '--', ...names]);
  if (added.code !== 0) return fail(`could not stage the resolution: ${(added.err || '').trim()}`);
  const committed = await git(wt, ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost', 'commit', '--no-edit']);
  if (committed.code !== 0) return fail(`could not commit the resolution: ${(committed.err || committed.out || '').trim().slice(0, 300)}`);
  return { ok: true };
}

async function describe(task, role) {
  if (!ROLES.includes(role)) return { ok: false, status: 400, message: `role must be one of ${ROLES.join(', ')}` };
  if (!['review', 'done'].includes(task.status)) return { ok: false, status: 409, message: `cannot merge: status is '${task.status}'` };
  let located;
  try { located = repoMod.repoOfTask(task); }
  catch (e) { return { ok: false, status: 409, message: e.message }; }
  const target = roleBranch(located.service, role);
  if (!target) return { ok: false, status: 400, message: `service '${located.service.name}' has no ${role}_branch configured` };
  if (!task.branch) return { ok: false, status: 409, message: 'task has no branch' };
  return { ok: true, source: task.branch, target, role };
}

module.exports = { mergeTo, pushTarget, describe, ROLES, PROTECTED, roleBranch };

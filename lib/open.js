'use strict';
// "Open in Cursor": hand a task's worktree (scoped to its service folder) to a human, either in the Cursor IDE or in an interactive
// `agent` CLI session in Terminal. The shared context bundle is placed in the opened folder as .cursor/rules/orch-context.mdc
// (alwaysApply) and kept out of commits (orchestrator pathspec + the repo's .git/info/exclude). Nothing here touches Cursor's own
// settings/state: the IDE's Agent mode + model cannot be set from outside (see README), the CLI session gets `--model auto` explicitly.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const cfg = require('../config');
const store = require('./db');
const context = require('./context');
const settings = require('./settings');
const { git, PATH } = require('./proc');

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./ ~-]+$/;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const asq = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); // AppleScript string literal

function findIdeBin() {
  if (cfg.CURSOR_IDE_BIN) return cfg.CURSOR_IDE_BIN;
  for (const d of [...PATH.split(':'), '/usr/local/bin', '/Applications/Cursor.app/Contents/Resources/app/bin']) {
    const f = path.join(d, 'cursor');
    try { if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; } } catch { /* next */ }
  }
  return null;
}

/** Resolve + verify the folder to open: the task worktree, or its service folder inside it. */
function targetFor(task, project) {
  const wt = task.worktree_path;
  const rw = wt && real(wt), root = real(cfg.WORKTREES);
  if (!rw || !root || !rw.startsWith(root + path.sep)) throw new Error('task has no worktree under the worktrees root (it must have started at least once)');
  let target = rw;
  const service = task.service_id ? store.getService(task.service_id) : null;
  if (service) {
    const rs = real(path.join(rw, service.path));
    if (!rs || (rs !== rw && !rs.startsWith(rw + path.sep))) throw new Error(`service folder ${service.path} is missing from the worktree`);
    target = rs;
  }
  if (!SAFE_PATH.test(target)) throw new Error(`refusing to open a path with unusual characters: ${target}`);
  return { worktree: rw, target, service };
}

/** Write the context bundle as an always-applied Cursor rule in the opened folder; exclude it from git. */
async function writeRules(task, project, target, worktree, service) {
  await context.ensureSeeded(project);
  const st = settings.effective(project);
  const b = context.buildBundle({ project, service, services: store.listServices(project.id), taskText: `${task.title}\n${task.prompt}`, maxChars: st.context_max_chars });
  if (!b.text) return null;
  const dir = path.join(target, '.cursor', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'orch-context.mdc');
  fs.writeFileSync(file, `---\ndescription: Shared project context from the local AI dev orchestrator (rules, service map, memory)\nalwaysApply: true\n---\n\n${b.text}`);
  // keep it out of commits even if a human commits from Cursor: .git/info/exclude of the repo (untracked metadata, shared by worktrees)
  const common = (await git(worktree, ['rev-parse', '--git-common-dir'])).out.trim();
  if (common) {
    const gd = path.isAbsolute(common) ? common : path.join(worktree, common);
    const ex = path.join(gd, 'info', 'exclude'); const line = '**/.cursor/rules/orch-context.mdc';
    try {
      fs.mkdirSync(path.dirname(ex), { recursive: true });
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!cur.split('\n').includes(line)) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
    } catch { /* the orchestrator's own commit pathspec still excludes it */ }
  }
  return { file, manifest: b.manifest };
}

const run = (bin, args) => new Promise((resolve) => execFile(bin, args, { timeout: 20000, env: { ...process.env, PATH } }, (e, so, se) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(so || ''), err: String(se || '') || (e ? e.message : '') })));

/** mode: 'ide' | 'terminal'. Returns { ok, mode, path, command, rules_file, notes[] }. */
async function openTask(task, project, mode) {
  const { worktree, target, service } = targetFor(task, project);
  const rules = await writeRules(task, project, target, worktree, service);
  const notes = [];
  let command, ok = true, detail = '';
  if (mode === 'ide') {
    const bin = findIdeBin();
    const args = bin ? ['-n', target] : ['-a', 'Cursor', target];
    const exe = bin || '/usr/bin/open';
    command = [exe, ...args].map(shq).join(' ');
    if (!cfg.OPEN_DRY_RUN) {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', env: { ...process.env, PATH } });
      child.on('error', () => {}); child.unref();
    }
    notes.push('Cursor IDE: the Agent mode / model picker cannot be set from outside. One-time manual step: in the chat panel choose mode "Agent" and model "Auto" (Cursor remembers it).');
  } else if (mode === 'terminal') {
    const inner = `cd ${shq(target)} && ${shq(cfg.CURSOR_BIN)} --workspace ${shq(target)} --model auto`;
    const script = `tell application "Terminal"\nactivate\ndo script "${asq(inner)}"\nend tell`;
    command = `${cfg.OSASCRIPT_BIN} -e ${shq(script)}`;
    if (!cfg.OPEN_DRY_RUN) {
      const r = await run(cfg.OSASCRIPT_BIN, ['-e', script]);
      if (r.code !== 0) { ok = false; detail = (r.err || 'osascript failed').trim().slice(0, 300); }
    }
    notes.push('Interactive `agent` session (default mode = agent, model auto, no --force: Cursor asks before running commands). It is NOT counted against the daily cap (the orchestrator cannot see interactive usage), but it does use your Pro plan.');
  } else throw new Error("mode must be 'ide' or 'terminal'");
  if (cfg.OPEN_DRY_RUN) notes.push('dry run (ORCH_OPEN_DRY_RUN=1): nothing was launched');
  return { ok, mode, path: target, command, detail, rules_file: rules && rules.file, context_chars: rules && rules.manifest.total_chars, notes };
}

module.exports = { openTask, targetFor, findIdeBin };

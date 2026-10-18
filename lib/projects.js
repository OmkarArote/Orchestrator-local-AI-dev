'use strict';
// Project registry helpers: path safety, inspect, add-existing, create-new, stack detection.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const store = require('./db');
const { git } = require('./proc');

const GIT_ID = ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TEMPLATES = ['empty', 'node'];
const MAX_BASELINE_FILES = 2000;

const { ProjectError } = require('./errors'); // one error class for the whole app (server.js maps it to HTTP)
const bad = (m, extra) => new ProjectError(400, m, extra);
const conflict = (m, extra) => new ProjectError(409, m, extra);

const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Resolve user input to a canonical absolute path INSIDE an authorized root (not-yet-existing paths allowed). Throws 400/403 with the reason. */
function resolveAllowed(input, label = 'path') {
  return require('./roots').guard.resolveInRoots(input, { label });
}

function validName(name, label = 'name') {
  const n = String(name ?? '').trim();
  if (!NAME_RE.test(n) || /^task-\d+$/.test(n)) throw bad(`${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (used as a directory name)`);
  return n;
}
const slugify = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);

/** package.json scripts (+ a single root *.test.js) -> suggested check command. */
function detectStack(dir) {
  const out = { kind: 'unknown', scripts: {}, suggested_check_cmd: null, suggested_install_cmd: null, notes: [] };
  const pj = path.join(dir, 'package.json');
  if (fs.existsSync(pj)) {
    out.kind = 'node';
    let j = null;
    try { if (fs.statSync(pj).size < 1024 * 1024) j = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { out.notes.push('package.json is not valid JSON'); }
    const sc = (j && j.scripts) || {};
    for (const k of ['build', 'test', 'lint']) if (typeof sc[k] === 'string') out.scripts[k] = sc[k];
    const realTest = out.scripts.test && !/no test specified/i.test(out.scripts.test);
    const parts = [];
    if (out.scripts.build) parts.push('npm run build');
    if (realTest) parts.push('npm test');
    out.suggested_check_cmd = parts.join(' && ') || null;
    if (!out.suggested_check_cmd) out.notes.push('package.json has no build or test script; set a check command manually');
    if (out.scripts.lint) out.notes.push('lint script exists but is not in the suggestion (add `npm run lint` if it is clean on main)');
    out.suggested_install_cmd = 'npm install --no-audit --no-fund --loglevel=error';
    if (!fs.existsSync(path.join(dir, 'node_modules'))) out.notes.push('node_modules not present here; worktrees will run the install command before checks');
  } else {
    let tests = [];
    try { tests = fs.readdirSync(dir).filter((f) => /\.test\.(c|m)?js$/.test(f)); } catch { /* ignore */ }
    if (tests.length === 1) { out.kind = 'node-script'; out.suggested_check_cmd = `node ${tests[0]}`; }
    else out.notes.push('no package.json; set a check command manually');
  }
  return out;
}

async function inspectPath(input) {
  const abs = resolveAllowed(input);
  const info = {
    path: abs, exists: fs.existsSync(abs), is_dir: false, is_git_repo: false, toplevel: null, has_commits: false,
    default_branch: null, branches: [], dirty: false, stack: null, suggested_name: slugify(path.basename(abs)),
    needs_git_init: false, can_add: false, warnings: [],
  };
  if (!info.exists) { info.warnings.push('path does not exist'); return info; }
  info.is_dir = fs.statSync(abs).isDirectory();
  if (!info.is_dir) { info.warnings.push('path is not a directory'); return info; }
  info.stack = detectStack(abs);
  const top = await git(abs, ['rev-parse', '--show-toplevel']);
  const topReal = top.code === 0 ? real(top.out.trim()) : null;
  if (topReal && topReal === abs) {
    info.is_git_repo = true; info.toplevel = topReal;
    info.has_commits = (await git(abs, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).code === 0;
    const heads = await git(abs, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    info.branches = heads.out.split('\n').map((s) => s.trim()).filter(Boolean);
    let b = (await git(abs, ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim();
    if (!b) { // detached HEAD: try origin/HEAD, then main/master
      const o = (await git(abs, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).out.trim().replace(/^origin\//, '');
      b = (o && info.branches.includes(o) && o) || ['main', 'master'].find((x) => info.branches.includes(x)) || '';
      if (b) info.warnings.push(`HEAD is detached; using '${b}' as default branch`);
    }
    info.default_branch = b || null;
    info.dirty = (await git(abs, ['status', '--porcelain'])).out.trim().length > 0;
    if (info.dirty) info.warnings.push('working copy has uncommitted changes (task worktrees are cut from the committed default branch; merges are refused while the repo is dirty)');
    info.needs_git_init = !info.has_commits;
    if (!info.has_commits) info.warnings.push('git repo has no commits; a baseline commit is needed (requires confirm_git_init)');
    info.can_add = info.has_commits && !!info.default_branch;
  } else {
    info.needs_git_init = true;
    if (topReal) { info.toplevel = topReal; info.warnings.push(`path is inside another git repo (${topReal}); add that repo root, or confirm_git_init to make this directory its own nested repo`); }
    else info.warnings.push('not a git repository; confirm_git_init will run `git init -b main` and make a baseline commit');
  }
  return info;
}

const DEFAULT_GITIGNORE = 'node_modules/\ndist/\nbuild/\n.env\n.env.*\n*.log\n.DS_Store\n.aider*\n';

async function baselineCommit(dir, { init }) {
  if (init) {
    const r = await git(dir, ['init', '-b', 'main']);
    if (r.code !== 0) throw bad(`git init failed: ${(r.err || r.error).trim()}`);
  }
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), DEFAULT_GITIGNORE);
  const untracked = (await git(dir, ['ls-files', '-o', '--exclude-standard'])).out.split('\n').filter(Boolean);
  if (untracked.length > MAX_BASELINE_FILES) throw bad(`refusing baseline commit: ${untracked.length} files to add (max ${MAX_BASELINE_FILES}); add a .gitignore or commit manually`);
  await git(dir, ['add', '-A']);
  const c = await git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'Baseline commit (created by local AI dev orchestrator)']);
  if (c.code !== 0) throw bad(`baseline commit failed: ${(c.err || c.error).trim()}`);
}

function checkEngine(e) {
  if (e === undefined || e === null || e === '') return 'local';
  if (!store.ENGINES.includes(e)) throw bad(`engine must be one of ${store.ENGINES.join(', ')}`);
  return e;
}
function checkCmdOf(v, name) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (s.length > 1000) throw bad(`${name} too long`);
  return s;
}
function assertUniquePath(abs) {
  for (const sv of store.allServices({ includeArchived: true })) {
    if (!sv.local_path || sv.path !== '.') continue;
    const rp = real(sv.local_path) || path.resolve(sv.local_path);
    if (rp === abs) {
      const p = store.getProject(sv.project_id);
      throw conflict(`path is already registered as service '${sv.name}' of project '${p ? p.name : '?'}'${sv.archived ? ' (archived; unarchive it instead)' : ''}`);
    }
  }
}
function assertUniqueName(name) {
  if (store.listProjects({ includeArchived: true }).some((p) => p.name.toLowerCase() === name.toLowerCase())) throw conflict(`a project named '${name}' already exists`);
}

/** Legacy alias: a LOGICAL project + ONE service for an existing local directory (same engine as services/add-existing; never runs `git init` unless confirm_git_init === true). */
async function addExisting(body) {
  const info = await inspectPath(body.path);
  if (!info.exists || !info.is_dir) throw bad(`not a directory: ${info.path}`);
  const name = validName(body.name || info.suggested_name);
  const engine = checkEngine(body.engine);
  assertUniqueName(name);
  assertUniquePath(info.path);
  const project = createLogical({ name, engine, check_cmd: body.check_cmd, install_cmd: body.install_cmd });
  try {
    const r = await require('./service-ops').addExisting(project, { path: info.path, name, default_branch: body.default_branch, check_cmd: body.check_cmd, install_cmd: body.install_cmd,
      confirm_git_init: body.confirm_git_init, type: body.type, stack: body.stack, description: body.description });
    return { project: projectView(store.getProject(project.id)), service: r.service, inspect: r.inspect, git_initialized: r.git_initialized };
  } catch (e) { store.deleteProjectRows(project.id); throw e; }
}

/** Legacy alias: create a LOGICAL project + ONE brand-new repo-level service (git init -b main, initial commit) under the authorized roots. */
async function createNew(body) {
  const name = validName(body.name);
  const template = String(body.template || 'empty');
  if (!TEMPLATES.includes(template)) throw bad(`template must be one of ${TEMPLATES.join(', ')}`);
  const engine = checkEngine(body.engine);
  const parent = resolveAllowed(body.parent_dir || cfg.PROJECTS_PARENT, 'parent_dir');
  assertUniqueName(name);
  const project = createLogical({ name, engine, check_cmd: body.check_cmd || (template === 'node' ? 'npm test' : cfg.EMPTY_CHECK), install_cmd: body.install_cmd });
  try {
    const r = await require('./service-ops').createNew(project, { name, parent_dir: parent, template, check_cmd: body.check_cmd, install_cmd: body.install_cmd, readme: true });
    return { project: projectView(store.getProject(project.id)), service: r.service, template, note: r.note };
  } catch (e) { store.deleteProjectRows(project.id); throw e; }
}

/**
 * Delete a project: DB rows only + the managed context dir is MOVED to <data>/trash/. It never touches service repositories, worktrees or
 * branches (they are listed in the result so the user can clean up by hand). Refused while any task is not finished.
 */
function deleteProject(project, confirm) {
  if (String(confirm ?? '') !== project.name) throw bad(`confirmation required: send {"confirm": "${project.name}"}`);
  const open = store.openTasksInProject(project.id);
  if (open.length) throw conflict(`project has unfinished tasks (${open.slice(0, 6).map((t) => `#${t.id} ${t.status}`).join(', ')}${open.length > 6 ? ', ...' : ''}); finish or reject them, or archive the project instead`);
  const services = store.listServices(project.id, { includeArchived: true });
  const leftovers = { worktrees: [...new Set(store.listTasks(project.id).map((t) => t.worktree_path).filter(Boolean))], branches: store.listTasks(project.id).map((t) => t.branch).filter(Boolean) };
  const ctxDir = require('./context').dirFor(project);
  let trashed = null;
  if (fs.existsSync(ctxDir)) {
    const trash = path.join(path.dirname(cfg.DB_PATH), 'trash');
    fs.mkdirSync(trash, { recursive: true });
    trashed = path.join(trash, `${project.slug || project.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.renameSync(ctxDir, trashed);
  }
  let rows;
  try { rows = store.deleteProjectRows(project.id); }
  catch (e) { if (trashed) { try { fs.renameSync(trashed, ctxDir); } catch { /* keep in trash */ } } throw e; }
  return { deleted: true, project: project.name, rows, services_unregistered: services.map((s) => ({ name: s.name, local_path: s.local_path, subdir: s.path })),
    context_moved_to: trashed, repositories_untouched: true, leftovers };
}

const slugOf = (name) => { let s = slugify(name) || 'project'; if (!store.slugTaken(s)) return s; for (let i = 2; i < 1000; i++) if (!store.slugTaken(`${s}-${i}`)) return `${s}-${i}`; throw conflict('cannot derive a unique slug'); };

/** Resolve an optional root_dir (default parent folder of the project's services): must be inside an authorized root. */
function checkRootDir(input) {
  if (input === undefined || input === null || String(input).trim() === '') return null;
  return require('./roots').guard.resolveInRoots(input, { label: 'root_dir' });
}

/** Create a LOGICAL project (a container: name, description, optional root_dir, config). It owns no repo; services are added afterwards. */
function createLogical(body) {
  const name = validName(body.name);
  assertUniqueName(name);
  const description = String(body.description ?? '').trim().slice(0, 4000);
  const engine = checkEngine(body.engine);
  const root_dir = checkRootDir(body.root_dir);
  const check_cmd = checkCmdOf(body.check_cmd, 'check_cmd') || undefined;
  const install_cmd = checkCmdOf(body.install_cmd, 'install_cmd');
  let config = {};
  if (body.config !== undefined) { const v = validateConfig(body.config, { config: {}, id: -1 }); if (v.error) throw bad(v.error); config = v.config; }
  const id = store.createProject({ name, slug: slugOf(name), description, root_dir, engine, check_cmd, install_cmd, config });
  return projectView(store.getProject(id));
}

/** Project fields editable through the API (name, description, root_dir, engine, check/install defaults, settings, config). Returns the field map for store.updateProject. */
function logicalUpdate(project, body) {
  const f = {};
  if (body.name !== undefined && body.name !== project.name) {
    const name = validName(body.name);
    if (store.listProjects({ includeArchived: true }).some((p) => p.id !== project.id && p.name.toLowerCase() === name.toLowerCase())) throw conflict(`a project named '${name}' already exists`);
    f.name = name; // slug (worktree + context dirs) stays as it was
  }
  if (body.description !== undefined) f.description = String(body.description ?? '').trim().slice(0, 4000);
  if (body.root_dir !== undefined) f.root_dir = checkRootDir(body.root_dir);
  return f;
}

function projectView(p) {
  if (!p) return p;
  const home = require('./repo').homeService(p);
  return { ...p, path: home ? home.local_path : null, default_branch: home ? home.default_branch : null, exists: !!(home && home.local_path && fs.existsSync(home.local_path)), settings_effective: require('./settings').effective(p), services: store.listServices(p.id).length,
    check_warning: p.check_cmd.trim() === 'true' ? "check_cmd is 'true' (no real check); set a real one or use 'git diff --check'" : undefined };
}

/** project.config (JSON): currently only ai_dir {service_id, import, export}. Validated shape; the service must belong to the project. */
function validateConfig(input, project) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { error: 'config must be an object' };
  const out = { ...(project.config || {}) };
  for (const [k, v] of Object.entries(input)) {
    if (v === null) { delete out[k]; continue; }
    if (k !== 'ai_dir') return { error: `unknown config key '${k}'` };
    if (typeof v !== 'object' || Array.isArray(v)) return { error: 'ai_dir must be an object {service_id, import, export}' };
    const ai = { import: !!v.import, export: !!v.export };
    if (v.service_id !== undefined && v.service_id !== null && v.service_id !== '') {
      const sv = store.getService(Number(v.service_id));
      if (!sv || sv.project_id !== project.id) return { error: `ai_dir.service_id ${v.service_id} is not a service of this project` };
      ai.service_id = sv.id;
    } else if (ai.import || ai.export) return { error: 'ai_dir.service_id is required when import/export is enabled (choose the service whose repo holds .ai/)' };
    out.ai_dir = ai;
  }
  return { config: out };
}

module.exports = { slugify, baselineCommit, deleteProject, createLogical, logicalUpdate, checkRootDir, validateConfig, ProjectError, resolveAllowed, validName, detectStack, inspectPath, addExisting, createNew, projectView, checkEngine, checkCmdOf };

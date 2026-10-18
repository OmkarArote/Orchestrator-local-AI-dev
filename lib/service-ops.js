'use strict';
// Service lifecycle: inspect / add existing / create new (and unregister, status, journal sweep). Clone-import lives in lib/importer.js.
// Safety rules (see docs/PLAN, 3.4): every path passes the authorized-roots guard (canonical, realpath, no hidden segments, never inside the
// orchestrator's own dirs), git only through safegit (hooks off, env allowlist), directories we create are journaled and only those are ever
// removed again (fsguard.removeOwnedDir), nothing existing is ever overwritten, no credentials are read/stored.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const store = require('./db');
const roots = require('./roots');
const fsg = require('./fsguard');
const sg = require('./safegit');
const repo = require('./repo');
const projects = require('./projects');
const { bad, conflict, forbidden, notFound } = require('./errors');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TYPES = ['api', 'web', 'worker', 'library', 'cli', 'infra', 'docs', 'other'];
const STACK_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+\/#-]{0,59}$/;
const SECRETISH_KEY = /(secret|token|passw|api[_-]?key|private|credential|auth)/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const checkName = (n, label = 'service name') => {
  const v = String(n ?? '').trim();
  if (!NAME_RE.test(v) || /^task-\d+$/.test(v)) throw bad(`${label} must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (used as a directory name)`);
  return v;
};
function uniqueServiceName(project, name) {
  if (store.listServices(project.id, { includeArchived: true }).some((s) => s.name.toLowerCase() === name.toLowerCase())) throw conflict(`service '${name}' already exists in project '${project.name}'`);
}
function checkType(t) {
  if (t === undefined || t === null || t === '') return 'other';
  if (!TYPES.includes(t)) throw bad(`type must be one of ${TYPES.join(', ')}`);
  return t;
}
function checkStack(s) {
  if (s === undefined || s === null || String(s).trim() === '') return '';
  const v = String(s).trim();
  if (!STACK_RE.test(v)) throw bad('stack must be a short label like "node", "python/fastapi" (letters, digits, space . _ + / # -)');
  return v;
}
/** env_config is NON-secret only (it is stored in the DB in clear and shown in the UI). */
function checkEnvConfig(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('env_config must be an object of NAME: value strings');
  const out = {}; const keys = Object.keys(v);
  if (keys.length > 40) throw bad('env_config: at most 40 entries');
  for (const k of keys) {
    if (!ENV_KEY.test(k)) throw bad(`env_config: invalid variable name '${k}'`);
    if (SECRETISH_KEY.test(k)) throw bad(`env_config: '${k}' looks like a secret; secrets are never stored by the orchestrator (use your shell/keychain)`);
    const val = String(v[k] ?? '');
    if (val.length > 500 || /[\x00-\x1f]/.test(val)) throw bad(`env_config: invalid value for '${k}'`); // eslint-disable-line no-control-regex
    if (sg.redact(val) !== val || /^[A-Za-z0-9+\/=_-]{32,}$/.test(val)) throw bad(`env_config: the value of '${k}' looks like a secret/token; not stored`);
    out[k] = val;
  }
  return out;
}

// ------------------------------------------------------------------ repo inspection (read-only)
async function gitInfo(dir) {
  const o = { is_git_repo: false, toplevel: null, is_toplevel: false, has_commits: false, default_branch: null, branches: [], dirty: false, remote_url: null, warnings: [] };
  const top = await sg.git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 15000 });
  const topReal = top.code === 0 ? fsg.real(top.out.trim()) : null;
  if (!topReal) return o;
  o.toplevel = topReal; o.is_git_repo = true; o.is_toplevel = fsg.same(topReal, fsg.real(dir) || dir);
  o.has_commits = (await sg.git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])).code === 0;
  o.branches = (await sg.git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).out.split('\n').map((s) => s.trim()).filter(Boolean);
  let b = (await sg.git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim();
  if (!b) {
    const od = (await sg.git(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).out.trim().replace(/^origin\//, '');
    b = (od && o.branches.includes(od) && od) || ['main', 'master'].find((x) => o.branches.includes(x)) || '';
    if (b) o.warnings.push(`HEAD is detached; using '${b}' as default branch`);
  }
  o.default_branch = b || null;
  o.dirty = (await sg.git(dir, ['status', '--porcelain'])).out.trim().length > 0;
  if (o.dirty) o.warnings.push('working copy has uncommitted changes (task worktrees are cut from the committed default branch; merges are refused while the repo is dirty)');
  const rem = (await sg.git(dir, ['config', '--get', 'remote.origin.url'])).out.trim();
  if (rem) { try { const p = sg.parseRemote(rem); o.remote_url = p.url; o.normalized_remote = p.normalized; } catch { o.remote_url = null; o.warnings.push('remote.origin.url is not an https/ssh URL; ignored'); } }
  return o;
}

/** Read-only look at a path: what the guard says, what git says, whether it is already registered, what to do next. Never writes. */
async function inspect(project, body) {
  const out = { path: null, authorized: false, auth_error: null, exists: false, is_dir: false, can_add: false, needs_git_init: false, registered_as: null, subdir: '.', warnings: [], stack: null };
  let abs;
  try { abs = roots.guard.resolveInRoots(body.path, { label: 'path', mustExist: true }); out.authorized = true; }
  catch (e) {
    out.auth_error = e.message; out.auth_code = (e.extra && e.extra.code) || null;
    if (e.status === 403 || /does not exist/.test(e.message)) { out.exists = !/does not exist/.test(e.message); return out; }
    throw e;
  }
  out.path = abs; out.exists = true;
  if (!fs.statSync(abs).isDirectory()) { out.warnings.push('path is not a directory'); return out; }
  out.is_dir = true;
  out.stack = projects.detectStack(abs);
  out.suggested_name = projects.slugify(path.basename(abs)).slice(0, 64) || 'service';
  const g = await gitInfo(abs);
  Object.assign(out, g, { warnings: [...out.warnings, ...g.warnings] });
  let repoRoot = abs, subdir = '.';
  if (g.is_git_repo && !g.is_toplevel) {
    repoRoot = g.toplevel; subdir = path.relative(g.toplevel, abs).split(path.sep).join('/');
    out.warnings.push(`path is inside the git repo ${g.toplevel}; it can be registered as a subfolder service (subdir '${subdir}')`);
    try { roots.guard.resolveInRoots(g.toplevel, { label: 'repository', mustExist: true, allowHidden: true }); } catch (e) { out.warnings.push(`the repository root is not authorized: ${e.message}`); out.can_add = false; out.repo_unauthorized = true; }
  }
  out.repo_root = repoRoot; out.subdir = subdir;
  out.needs_git_init = !g.is_git_repo || !g.has_commits;
  if (!g.is_git_repo) out.warnings.push('not a git repository; confirm_git_init will run `git init -b main` and make a baseline commit');
  else if (!g.has_commits) out.warnings.push('git repo has no commits; a baseline commit is needed (requires confirm_git_init)');
  const dup = store.allServices({ includeArchived: true }).find((s) => s.local_path && fsg.same(fsg.real(s.local_path) || s.local_path, repoRoot) && s.path === subdir);
  if (dup) { const p = store.getProject(dup.project_id); out.registered_as = { service_id: dup.id, service: dup.name, project_id: dup.project_id, project: p && p.name, archived: dup.archived }; }
  const rem = out.normalized_remote && store.findServiceByRemote(out.normalized_remote);
  if (rem) out.warnings.push(`the same remote is already registered as service '${rem.name}' (project #${rem.project_id})`);
  out.can_add = !out.repo_unauthorized && !out.registered_as && (g.is_git_repo ? !!g.default_branch || out.needs_git_init : true);
  return out;
}

// ------------------------------------------------------------------ add existing
async function addExisting(project, body) {
  if (project.archived) throw conflict(`project '${project.name}' is archived`);
  const info = await inspect(project, { path: body.path });
  if (!info.authorized) { if (info.exists === false) throw bad(info.auth_error || 'path does not exist', { inspect: info }); throw forbidden(info.auth_error || 'path is not authorized', { code: info.auth_code, inspect: info }); }
  if (!info.exists || !info.is_dir) throw bad(`not a directory: ${info.path || body.path}`);
  if (info.registered_as) throw conflict(`this location is already registered as service '${info.registered_as.service}' of project '${info.registered_as.project}'${info.registered_as.archived ? ' (archived; unarchive it instead)' : ''}`, { inspect: info });
  if (info.repo_unauthorized) throw forbidden('the repository containing this folder is outside the authorized roots', { inspect: info });
  const name = checkName(body.name || info.suggested_name);
  uniqueServiceName(project, name);
  const type = checkType(body.type), stack = checkStack(body.stack !== undefined ? body.stack : (info.stack && info.stack.kind !== 'unknown' ? info.stack.kind : ''));
  const check_cmd = projects.checkCmdOf(body.check_cmd, 'check_cmd') || (info.stack && info.stack.suggested_check_cmd) || null;
  const install_cmd = projects.checkCmdOf(body.install_cmd, 'install_cmd') || null;
  const description = String(body.description ?? '').trim().slice(0, 2000);
  let repoRoot = info.repo_root, subdir = info.subdir;
  if (info.needs_git_init) {
    if (body.confirm_git_init !== true) throw conflict('directory is not a git repo with commits; resend with confirm_git_init:true to run git init + baseline commit', { needs_git_init: true, inspect: info });
    if (info.is_git_repo && !info.is_toplevel) throw bad('refusing to init a nested repo inside another repository; register the repository root instead');
    await projects.baselineCommit(info.path, { init: !info.is_git_repo });
    repoRoot = info.path; subdir = '.';
  }
  const after = info.needs_git_init ? await gitInfo(info.path) : info;
  const branch = String(body.default_branch || after.default_branch || '').trim();
  if (!branch || branch.startsWith('-')) throw bad('could not detect a default branch; pass default_branch');
  if ((await sg.git(repoRoot, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`])).code !== 0) throw bad(`branch '${branch}' does not exist or has no commits`);
  if (subdir !== '.' && !fs.existsSync(path.join(repoRoot, subdir))) throw bad(`subfolder '${subdir}' does not exist in ${repoRoot}`);
  let id;
  try {
    id = store.createService({ project_id: project.id, name, path: subdir, description, check_cmd, install_cmd, local_path: repoRoot, remote_url: after.remote_url || null, normalized_remote: after.normalized_remote || null,
      default_branch: branch, type, stack, status: 'active', origin: 'existing' });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict('this location or remote is already registered as a service'); throw e; }
  return { service: store.getService(id), inspect: after, git_initialized: !!info.needs_git_init, warnings: after.warnings };
}

// ------------------------------------------------------------------ create new
const GITIGNORES = {
  node: 'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n*.log\n.DS_Store\n.aider*\n',
  python: '__pycache__/\n*.pyc\n.venv/\nvenv/\n.env\n.env.*\n*.log\n.DS_Store\n.aider*\n',
  generic: 'node_modules/\ndist/\nbuild/\n.env\n.env.*\n*.log\n.DS_Store\n.aider*\n',
};
const TEMPLATES = ['empty', 'node']; // `node` is opt-in only (decision: default is an empty repo)

const ownPolicy = () => ({
  isOwned: (p) => store.journalOpenHas(p),
  protect: (p) => store.allServices({ includeArchived: true }).some((s) => s.local_path && fsg.same(fsg.real(s.local_path) || s.local_path, p)) || roots.list().some((r) => fsg.same(r.path, p)),
  home: cfg.HOME,
});

/**
 * Create a brand-new repo directory under an authorized root, journaled; `finalize({path, branch})` runs while the journal is open (DB insert);
 * any failure removes ONLY the directory this call created. Returns whatever finalize returns.
 */
async function createRepoDir({ parent, dirName, files, branch = 'main', identity }, finalize) {
  const parentAbs = roots.guard.resolveInRoots(parent, { label: 'parent_dir', mustExist: true });
  if (!fs.statSync(parentAbs).isDirectory()) throw bad('parent_dir is not a directory');
  const target = roots.guard.resolveInRoots(path.join(parentAbs, dirName), { label: 'target directory', forCreate: true, allowRoot: false });
  const jid = store.journalAdd('new_service', target);
  let made = false;
  try {
    fs.mkdirSync(target, { recursive: false }); made = true;     // atomic: fails when it exists (never overwrites)
    roots.guard.recheck(target, 'target directory');
    if (process.env.ORCH_TEST_FAIL_AFTER_MKDIR === '1') throw new Error('injected failure after mkdir');
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(target, f), c, { flag: 'wx' });
    const idn = identity === undefined ? await sg.userIdentity() : identity;
    const used = await sg.initRepo(target, { branch, identity: idn, add: ['.'] });
    roots.guard.recheck(target, 'target directory');
    const res = await finalize({ path: target, branch, identity: used });
    store.journalSet(jid, 'committed');
    return res;
  } catch (e) {
    if (made) { try { fsg.removeOwnedDir(target, ownPolicy()); } catch (e2) { console.error('[service-ops] cleanup refused:', e2.message); } }
    store.journalSet(jid, 'cleaned');
    throw e;
  }
}

async function createNew(project, body) {
  if (project.archived) throw conflict(`project '${project.name}' is archived`);
  const name = checkName(body.name);
  uniqueServiceName(project, name);
  const dirName = checkName(body.dir_name || name, 'dir_name');
  const parent = body.parent_dir || project.root_dir || cfg.PROJECTS_PARENT;
  const template = String(body.template || 'empty');
  if (!TEMPLATES.includes(template)) throw bad(`template must be one of ${TEMPLATES.join(', ')}`);
  const type = checkType(body.type), stack = checkStack(body.stack !== undefined ? body.stack : (template === 'node' ? 'node' : ''));
  const description = String(body.description ?? '').trim().slice(0, 2000);
  const wantReadme = body.readme === undefined ? true : body.readme === true || body.readme === 'true';
  const gi = body.gitignore === undefined ? 'generic' : body.gitignore === false || body.gitignore === 'none' ? null : (GITIGNORES[body.gitignore === true ? 'generic' : body.gitignore] ? (body.gitignore === true ? 'generic' : body.gitignore) : (() => { throw bad(`gitignore must be one of ${Object.keys(GITIGNORES).join(', ')}, none`); })());
  const files = {};
  if (wantReadme) files['README.md'] = `# ${name}\n\n${description ? description + '\n\n' : ''}Created by the Local AI Dev Orchestrator.\n`;
  if (gi) files['.gitignore'] = GITIGNORES[gi];
  if (template === 'node') {
    files['package.json'] = JSON.stringify({ name: name.toLowerCase().replace(/[^a-z0-9-_.]/g, '-'), version: '0.1.0', private: true, scripts: { test: 'node --test' } }, null, 2) + '\n';
    files['index.js'] = "'use strict';\nmodule.exports = {};\n";
    files['index.test.js'] = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\ntest('placeholder', () => { assert.ok(require('./index')); });\n";
  }
  const check_cmd = projects.checkCmdOf(body.check_cmd, 'check_cmd') || (template === 'node' ? 'npm test' : cfg.EMPTY_CHECK);
  const install_cmd = projects.checkCmdOf(body.install_cmd, 'install_cmd') || null;
  return createRepoDir({ parent, dirName, files, branch: 'main' }, ({ path: p, identity }) => {
    const id = store.createService({ project_id: project.id, name, path: '.', description, check_cmd, install_cmd, local_path: p, default_branch: 'main', type, stack, status: 'active', origin: 'create' });
    return { service: store.getService(id), template, identity_used: identity.email === 'ai-orchestrator@localhost' ? 'orchestrator' : 'your git identity',
      note: !body.check_cmd && template === 'empty' ? `check_cmd defaulted to '${cfg.EMPTY_CHECK}' (whitespace/conflict-marker check only, not a behaviour test); set a real one` : undefined };
  });
}

// ------------------------------------------------------------------ update / unregister / status
function update(project, service, body) {
  const f = {};
  if (body.name !== undefined && body.name !== service.name) { const name = checkName(body.name); uniqueServiceName({ ...project }, name); f.name = name; }
  if (body.description !== undefined) f.description = String(body.description).trim().slice(0, 2000);
  if (body.notes !== undefined) f.notes = String(body.notes).trim().slice(0, 4000);
  for (const k of ['check_cmd', 'install_cmd', 'build_cmd', 'test_cmd']) if (body[k] !== undefined) f[k] = projects.checkCmdOf(body[k], k);
  if (body.type !== undefined) f.type = checkType(body.type);
  if (body.stack !== undefined) f.stack = checkStack(body.stack);
  if (body.env_config !== undefined) f.env_config = checkEnvConfig(body.env_config);
  if (body.default_branch !== undefined) f.default_branch = body.default_branch;
  if (body.path !== undefined) f.path = require('./services').normalizePath(service.local_path, body.path);
  if (!Object.keys(f).length) throw bad('nothing to update (name, description, notes, type, stack, check_cmd, build_cmd, test_cmd, install_cmd, env_config, default_branch, path)');
  store.updateService(service.id, f);
  return store.getService(service.id);
}

/** Unregister (never deletes files): only when no task ever used it; otherwise archive. */
function unregister(service) {
  const used = store.listTasks(service.project_id).filter((t) => t.service_id === service.id);
  if (used.length) throw conflict(`service has ${used.length} task(s) in its history; archive it instead (unregistering would orphan them)`);
  store.deleteServiceRow(service.id);
  return { removed: service.name, files_untouched: true, local_path: service.local_path };
}

/** Local-only state of a service repo (no fetch, no network). */
async function status(service) {
  const out = { service: service.name, local_path: service.local_path, subdir: service.path, exists: false, usable: false, problem: null, branch: null, head: null, clean: null, default_branch: service.default_branch, on_default_branch: null };
  if (!service.local_path || !fs.existsSync(service.local_path)) { out.problem = 'repository directory does not exist'; return out; }
  out.exists = true;
  try { repo.assertUsable(service); out.usable = true; } catch (e) { out.problem = e.message; return out; }
  const b = (await sg.git(service.local_path, ['symbolic-ref', '--short', '-q', 'HEAD'])).out.trim();
  out.branch = b || null; out.on_default_branch = b === service.default_branch;
  out.head = (await sg.git(service.local_path, ['rev-parse', '--short', 'HEAD'])).out.trim() || null;
  out.clean = (await sg.git(service.local_path, ['status', '--porcelain'])).out.trim() === '';
  return out;
}

/** Startup sweep: directories journaled as open (a crash between mkdir/clone and commit) are removed if we own them and no service uses them. */
function sweepJournal() {
  const done = [];
  for (const j of store.journalOpen()) {
    try {
      const registered = store.allServices({ includeArchived: true }).some((s) => s.local_path && fsg.same(fsg.real(s.local_path) || s.local_path, j.path));
      if (registered) { store.journalSet(j.id, 'committed'); continue; }
      const removed = fsg.removeOwnedDir(j.path, { ...ownPolicy(), isOwned: (p) => p === j.path || fsg.same(p, j.path), cloneParents: roots.list().map((r) => r.path) });
      store.journalSet(j.id, 'cleaned'); done.push({ path: j.path, removed });
    } catch (e) { console.error(`[service-ops] journal sweep: ${j.path}: ${e.message}`); store.journalSet(j.id, 'cleaned'); }
  }
  return done;
}

module.exports = { inspect, addExisting, createNew, createRepoDir, update, unregister, status, sweepJournal, gitInfo, checkName, checkType, checkStack, checkEnvConfig, uniqueServiceName, ownPolicy, TYPES, TEMPLATES };

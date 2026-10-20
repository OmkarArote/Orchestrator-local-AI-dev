'use strict';
// Services = the unit that owns ONE git repo (service.local_path) and optionally a subfolder of it (service.path = subdir, kept in the
// legacy column name). A project is a logical container of services (possibly in different repos / parent folders).
// Monorepo-style subfolder services are created with (local_path of an existing service of the project, subdir).
const fs = require('node:fs');
const path = require('node:path');
const store = require('./db');
const { git } = require('./proc');
const repo = require('./repo');
const { ProjectError, validName, checkCmdOf } = require('./projects');

const bad = (m, extra) => new ProjectError(400, m, extra);
const conflict = (m, extra) => new ProjectError(409, m, extra);
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Normalise a service subdir to a repo-relative posix path ('.' = whole repo). Absolute paths must be inside the service's repo. */
function normalizePath(repoRoot, input) {
  let p = String(input ?? '').trim();
  if (p.includes('\0')) throw bad('invalid path');
  if (!p || p === '.' || p === './') return '.';
  const root = real(repoRoot) || path.resolve(repoRoot);
  if (path.isAbsolute(p)) {
    const abs = real(p) || path.resolve(p);
    if (!inside(abs, root)) throw bad(`service path ${p} is outside the repository ${root}; add that location as its own service`);
    p = path.relative(root, abs) || '.';
  }
  p = path.posix.normalize(p.split(path.sep).join('/')).replace(/\/+$/, '');
  if (p === '' || p === '.') return '.';
  if (p === '..' || p.startsWith('../') || p.startsWith('-') || path.posix.isAbsolute(p)) throw bad(`invalid service path '${input}' (must be inside the repo)`);
  const full = path.join(repoRoot, p);
  const rf = real(full);
  if (rf && !inside(rf, root)) throw bad(`service path '${p}' resolves (symlink) outside the repository`);
  return p;
}

function serviceView(project, s) {
  if (!s) return s;
  const repoExists = !!s.local_path && fs.existsSync(s.local_path);
  return { ...s, repo_exists: repoExists, exists: repoExists && fs.existsSync(path.join(s.local_path, s.path)), project_name: project && project.name,
    branch_protection: { dev: false, uat: true, live: true } };
}

function list(project, opts) { return store.listServices(project.id, opts).map((s) => serviceView(project, s)); }

/** The repo that legacy-style "subfolder" services of this project live in (the project's whole-repo service). */
function homeOf(project) {
  const h = repo.homeService(project);
  if (!h) throw bad(`project '${project.name}' has no repository yet; add a service (import / create / add existing) first`);
  return h;
}

function create(project, body) {
  const name = validName(body.name, 'service name');
  const home = homeOf(project);
  const p = normalizePath(home.local_path, body.path);
  if (store.findServiceByLocation(home.local_path, p)) throw conflict(`'${p}' of ${home.local_path} is already registered as a service`);
  if (store.listServices(project.id, { includeArchived: true }).some((s) => s.name.toLowerCase() === name.toLowerCase())) throw conflict(`service '${name}' already exists in project '${project.name}'`);
  const description = String(body.description ?? '').trim().slice(0, 2000);
  const notes = String(body.notes ?? '').trim().slice(0, 4000);
  const check_cmd = checkCmdOf(body.check_cmd, 'check_cmd');
  const id = store.createService({ project_id: project.id, name, path: p, description, check_cmd, notes, local_path: home.local_path, default_branch: home.default_branch,
    type: home.type, stack: home.stack, status: 'active', origin: 'existing' });
  return serviceView(project, store.getService(id));
}

const MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'Dockerfile', 'mix.exs'];
const CONTAINERS = new Set(['services', 'packages', 'apps', 'libs', 'modules', 'microservices', 'backend', 'frontend', 'workers', 'functions']);
const SKIP = /^(node_modules|dist|build|vendor|venv|\.[^/]*|__pycache__|coverage|target)$/;

/** Suggest services from the committed layout of the default branch: top-level dirs with a project marker, plus one level under services/packages/apps/... */
async function detect(project, home = homeOf(project)) {
  const root = repo.assertUsable(home), branch = home.default_branch;
  const ls = await git(root, ['ls-tree', '-r', '--name-only', branch]);
  if (ls.code !== 0) throw bad(`cannot list ${branch}: ${(ls.err || ls.error || '').trim().slice(0, 200)}`);
  const files = ls.out.split('\n').filter(Boolean);
  const found = new Map(); // dir -> markers
  for (const f of files) {
    const parts = f.split('/');
    const base = parts[parts.length - 1];
    if (!MARKERS.includes(base) && !/\.csproj$/.test(base)) continue;
    const dirParts = parts.slice(0, -1);
    if (dirParts.some((d) => SKIP.test(d))) continue;
    if (dirParts.length === 1 || (dirParts.length === 2 && CONTAINERS.has(dirParts[0]))) {
      const dir = dirParts.join('/');
      found.set(dir, [...(found.get(dir) || []), base]);
    } else if (dirParts.length === 0) found.set('.', [...(found.get('.') || []), base]);
  }
  if (found.size > 1) found.delete('.'); // root marker is just the monorepo manifest when there are sub-services
  const registered = new Set(store.allServices({ includeArchived: false }).filter((s) => s.local_path === home.local_path).map((s) => s.path));
  const out = [];
  for (const [dir, markers] of [...found.entries()].sort()) {
    let description = '', check = null;
    if (markers.includes('package.json')) {
      const pj = await git(root, ['show', `${branch}:${dir === '.' ? '' : dir + '/'}package.json`]);
      try {
        const j = JSON.parse(pj.out);
        description = String(j.description || '').slice(0, 300);
        const t = j.scripts && j.scripts.test;
        if (t && !/no test specified/i.test(t)) check = 'npm test';
        else if (j.scripts && j.scripts.build) check = 'npm run build';
      } catch { /* ignore */ }
    }
    const kind = markers.includes('package.json') ? 'node' : markers.includes('go.mod') ? 'go' : markers.some((m) => /py/.test(m)) ? 'python' : markers.includes('Cargo.toml') ? 'rust' : markers.includes('pom.xml') || markers.some((m) => /gradle/.test(m)) ? 'jvm' : 'other';
    const name = dir === '.' ? home.name : dir.split('/').pop();
    out.push({ name: /^[A-Za-z0-9]/.test(name) ? name.slice(0, 64) : 'svc', path: dir, kind, markers, description, suggested_check_cmd: check, registered: registered.has(dir) });
  }
  return out;
}

module.exports = { normalizePath, serviceView, list, create, detect, homeOf };

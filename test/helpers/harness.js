'use strict';
// Test harness: boots the orchestrator on a random port with a throw-away HOME/DB/log/worktree dir, stub engines and a fake Ollama.
// Nothing here touches the real data/orchestrator.db, the real worktrees dir, or any real repo.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { startFakeOllama } = require('./fake-ollama');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.resolve(__dirname, '..', 'fixtures');
const REAL_HOME = os.homedir();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
}
/** Create a git repo with files {name: content} and one commit on `main`. */
function makeRepo(dir, files = { 'README.md': '# t\n' }, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}
/** sha of a tree-ish: hash of `git ls-files -s` + HEAD + status - cheap "repo untouched" fingerprint */
function fingerprint(dir) {
  return [git(dir, 'rev-parse', 'HEAD').trim(), git(dir, 'status', '--porcelain'), git(dir, 'branch', '--list').trim(), git(dir, 'worktree', 'list')].join('|');
}

async function startServer(opts = {}) {
  const base = opts.base || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  for (const d of ['.nvm', '.local']) { try { fs.symlinkSync(path.join(REAL_HOME, d), path.join(home, d)); } catch { /* ignore */ } }
  const fake = opts.fakeOllama === false ? null : await startFakeOllama(opts.fakeOpts || {});
  const port = await freePort();
  const dbPath = opts.dbPath || path.join(base, 'data', 'orchestrator.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const env = {
    ...process.env, HOME: home, ORCH_PORT: String(port), ORCH_DB: dbPath, ORCH_LOG_DIR: path.join(base, 'logs'), ORCH_WORKTREES: path.join(base, 'worktrees'),
    ORCH_AIDER_BIN: path.join(FIX, 'stub-aider.js'), ORCH_CURSOR_BIN: path.join(FIX, 'stub-agent.js'), STUB_LOG: path.join(base, 'stub-agent.log'),
    STUB_AIDER_LOG: path.join(base, 'stub-aider.log'), STUB_SLEEP_MS: '200', ORCH_OPEN_DRY_RUN: '1', ORCH_OLLAMA_REGISTRY: 'http://127.0.0.1:9', ORCH_POLL_MS: '150',
    OLLAMA_API_BASE: fake ? fake.url : 'http://127.0.0.1:9', ORCH_PROJECTS_PARENT: path.join(home, 'work'), ORCH_ROUTER_TIMEOUT_MS: '8000', ORCH_MEMORY_TIMEOUT_MS: '8000',
    ORCH_MODEL: 'ollama_chat/ornith:9b', ORCH_ESCALATION_REQUIRE_APPROVAL: '1', ORCH_FLOW: 'v1',
    ...(opts.env || {}),
  };
  delete env.ORCH_REPO;
  const out = [];
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  let exited = false; child.on('exit', () => { exited = true; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const S = {
    base, home, work: path.join(home, 'work'), port, url: baseUrl, fake, env, dbPath, logs: () => out.join(''), child,
    async raw(method, p, body, headers = {}) {
      const r = await fetch(baseUrl + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text };
    },
    /** API call; throws on non-2xx unless allowFail. Returns parsed JSON. */
    async api(method, p, body, { allowFail = false } = {}) {
      const r = await S.raw(method, '/api' + p, body === undefined && method === 'POST' ? {} : body);
      if (!allowFail && (r.status < 200 || r.status >= 300)) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 400)}`);
      return allowFail ? r : r.json;
    },
    get: (p, o) => S.api('GET', p, undefined, o),
    post: (p, b, o) => S.api('POST', p, b ?? {}, o),
    async stop() {
      if (!exited) { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.on('exit', r)), sleep(3000)]); if (!exited) child.kill('SIGKILL'); }
      if (fake) await fake.close();
      if (!opts.keep) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    async waitFor(fn, { timeout = process.env.CI ? 60000 : 40000, every = 100, what = 'condition' } = {}) {
      const t0 = Date.now();
      for (;;) {
        let v; try { v = await fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}\n--- server log ---\n${S.logs().slice(-3000)}`);
        await sleep(every);
      }
    },
    async waitStatus(id, wanted, o = {}) {
      const set = Array.isArray(wanted) ? wanted : [wanted];
      return S.waitFor(async () => { const t = await S.get(`/tasks/${id}`); return set.includes(t.status) ? t : null; }, { what: `task ${id} -> ${set.join('|')}`, ...o });
    },
    /** Add a repo as a project through the legacy alias (works before and after the project/service split). Returns {project, id, serviceId}. */
    async addProject(repoPath, name, check_cmd = 'true', extra = {}) {
      const r = await S.post('/projects/add', { path: repoPath, name, check_cmd, ...extra });
      const id = r.project.id;
      return { project: r.project, id, serviceId: await S.defaultServiceId(id) };
    },
    /** The service that stands for the whole repo of a project (null on pre-service-split code). */
    async defaultServiceId(pid) {
      const l = await S.get(`/projects/${pid}/services`, { allowFail: true });
      const arr = l.json;
      if (!Array.isArray(arr)) return null;
      const s = arr.find((x) => x.path === '.' && x.local_path) || arr.find((x) => x.local_path);
      return s ? s.id : null;
    },
    /** Create a task; injects the project's default service when the code requires one. */
    async createTask(pid, body) {
      const b = { project_id: pid, ...body };
      if (b.service_id === undefined) { const sid = await S.defaultServiceId(pid); if (sid) b.service_id = sid; }
      return S.post('/tasks', b);
    },
    async runToReview(pid, body, finalStatus = 'review') {
      const t = await S.createTask(pid, body);
      await S.post(`/tasks/${t.id}/approve-start`, {});
      return S.waitStatus(t.id, finalStatus);
    },
  };
  S.cleanupPaths = () => base;
  try {
    await S.waitFor(async () => { if (exited) throw new Error('server exited early:\n' + S.logs()); const r = await fetch(baseUrl + '/api/health').catch(() => null); return r && r.ok; }, { timeout: 15000, what: 'server start' });
  } catch (e) { await S.stop(); throw e; }
  return S;
}

module.exports = { startServer, makeRepo, git, fingerprint, sleep, freePort, ROOT, FIX, REAL_HOME };

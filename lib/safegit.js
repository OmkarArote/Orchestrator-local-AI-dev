'use strict';
// Hardened git access + remote URL validation. Every git invocation of the orchestrator for untrusted/remote data goes through here:
//  - execFile/spawn with an argv ARRAY only (never a shell, never string concatenation), `--` before URLs/paths,
//  - environment ALLOWLIST (the parent's environment, including tokens/keys, is never inherited),
//  - GIT_TERMINAL_PROMPT=0, protocol allowlist (https + ssh only), no hooks for untrusted repos, no submodule recursion,
//  - credentials are never read, stored, logged or returned; everything printed passes redact().
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { run, PATH } = require('./proc');
const { bad } = require('./errors');

const ENV_ALLOW = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'TERM'];
const TEST_FILE_FLAG = 'ORCH_TEST_ALLOW_FILE'; // test-only escape hatch: allows file:// clones of local bare repos

const testFileAllowed = () => process.env[TEST_FILE_FLAG] === '1';

/** The ONLY environment a git child gets. */
function buildEnv(extra = {}) {
  const env = { PATH };
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true', GIT_EDITOR: 'true', GIT_PAGER: 'cat', GCM_INTERACTIVE: 'never',
    GIT_ALLOW_PROTOCOL: testFileAllowed() ? 'https:ssh:file' : 'https:ssh',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15 -o NumberOfPasswordPrompts=0',
    GIT_CONFIG_NOSYSTEM: process.env.ORCH_GIT_CONFIG_NOSYSTEM === '1' ? '1' : undefined,
    NO_COLOR: '1', LC_MESSAGES: 'C',
  }, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** -c options applied to every invocation. `hooks:'off'` for repos we have not reviewed. */
function baseConfig({ hooks = 'off' } = {}) {
  const c = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'submodule.recurse=false', '-c', 'core.fsmonitor=false'];
  if (testFileAllowed()) c.push('-c', 'protocol.file.allow=always');
  if (hooks === 'off') c.push('-c', 'core.hooksPath=/dev/null');
  return c;
}

// ------------------------------------------------------------------ redaction
const REDACTIONS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\/@\s'"]+@/gi, '$1***@'],                            // scheme://user:pass@ -> scheme://***@
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})\b/g, '***'],
  [/(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi, '$1***'],
  [/((?:Load key|identity file|Identity file|key file)\s+)"?[^\s"]+"?/g, '$1***'],     // ssh key paths are not echoed
  [/(\/[^\s'"]*\/\.ssh\/[^\s'"]*)/g, '~/.ssh/***'],
  [/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1***'],
];
function redact(text) {
  let s = String(text ?? '');
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s;
}

// ------------------------------------------------------------------ remote URL validation
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const HTTPS_PATH_RE = /^\/[A-Za-z0-9._~%+@\/-]+$/;
const SCP_PATH_RE = /^[A-Za-z0-9._~%+\/-]+$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BAD_CHARS = /[\s\x00-\x1f\x7f`$;|&\\?#<>(){}*!^'"\u0080-\uffff]/; // eslint-disable-line no-control-regex
const LONG = 2048;

function hostClass(host) {
  const h = host.toLowerCase();
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([m[1], m[2], m[3], m[4]].some((x) => Number(x) > 255)) return 'invalid';
    if (a === 127 || a === 0) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
    if (a === 169 && b === 254) return 'link-local';
    return 'public';
  }
  if (/^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/i.test(h)) return 'invalid'; // 0x7f.1, 2130706433: ambiguous numeric hosts
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (!h.includes('.') || /\.(local|lan|internal|home|corp|intranet|localdomain)$/.test(h)) return 'lan';
  return 'public';
}

function checkPath(p, what) {
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) throw bad(`${what}: '.'/'..' path segments are not allowed`);
  if (p.includes('//')) throw bad(`${what}: empty path segments are not allowed`);
  if (/%(2e|2f|5c|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(p)) throw bad(`${what}: encoded dots, slashes or control characters are not allowed`);
  if (p.split('/').some((seg) => seg.startsWith('-'))) throw bad(`${what}: path segments must not start with '-'`);
}

/**
 * Validate and normalise a remote URL. Accepts ONLY https://host[:port]/path, ssh://user@host[:port]/path and scp-like user@host:path.
 * Returns { kind, host, port, path, user, normalized, url, lan, warnings }. Throws ProjectError(400) with a precise reason otherwise.
 */
function parseRemote(input) {
  if (typeof input !== 'string') throw bad('remote URL must be a string');
  const s = input.trim();
  if (!s) throw bad('remote URL required');
  if (s.length > LONG) throw bad(`remote URL too long (max ${LONG})`);
  if (s.startsWith('-')) throw bad("remote URL must not start with '-'");
  if (/[\s\x00-\x1f\x7f]/.test(s)) throw bad('remote URL must not contain whitespace or control characters'); // eslint-disable-line no-control-regex
  if (testFileAllowed()) { const fm = s.match(/^file:\/\/(\/[A-Za-z0-9._~\/-]+)$/); if (fm) return { kind: 'file', host: '', port: null, path: fm[1], user: null, normalized: `file${fm[1].toLowerCase()}`, url: s, lan: true, warnings: ['TEST ONLY: file:// remote'] }; }
  if (BAD_CHARS.test(s)) throw bad('remote URL contains forbidden characters (quotes, ?, #, \\, `, $, ;, |, &, non-ASCII ...)');
  if (/^(ext|fd)::/i.test(s)) throw bad('transport helpers (ext::, fd::) are not allowed');
  const lower = s.toLowerCase();
  let m, kind, user = null, host, port = null, p;
  if (lower.startsWith('https://')) {
    m = s.match(/^https:\/\/([^\/]*)(\/.*)?$/i);
    if (!m) throw bad('malformed https URL');
    const auth = m[1];
    if (auth.includes('@')) throw bad('credentials in the URL (user:password@) are not allowed; use your git credential helper or ssh-agent');
    const hp = auth.match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!hp) throw bad('malformed host/port in https URL');
    host = hp[1]; port = hp[2] ? Number(hp[2]) : null; p = m[2] || '';
    kind = 'https';
  } else if (lower.startsWith('ssh://')) {
    m = s.match(/^ssh:\/\/([^\/]*)(\/.*)?$/i);
    if (!m) throw bad('malformed ssh URL');
    const auth = m[1];
    const at = auth.lastIndexOf('@');
    if (at < 0) throw bad('ssh URLs need a user, e.g. ssh://git@host/owner/repo.git');
    user = auth.slice(0, at);
    if (!USER_RE.test(user)) throw bad('invalid ssh user (passwords/colons are not allowed)');
    const hp = auth.slice(at + 1).match(/^([^:]+)(?::(\d{1,5}))?$/);
    if (!hp) throw bad('malformed host/port in ssh URL');
    host = hp[1]; port = hp[2] ? Number(hp[2]) : null; p = m[2] || '';
    kind = 'ssh';
  } else if (/^[A-Za-z0-9._-]+@[^:\/]+:/.test(s)) { // scp-like git@host:owner/repo.git
    m = s.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9._~%+\/-]+)$/);
    if (!m) throw bad('malformed scp-style URL (expected user@host:owner/repo.git)');
    user = m[1]; host = m[2]; p = '/' + m[3].replace(/^\/+/, ''); kind = 'ssh';
    if (!SCP_PATH_RE.test(m[3])) throw bad('invalid characters in scp-style path');
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    throw bad(`scheme '${s.split(':')[0]}' is not allowed (only https and ssh)${/^http:/i.test(s) ? '; plain-text http:// is refused' : ''}`);
  } else {
    throw bad('not a remote URL (local paths are added with the "add existing" flow; allowed: https://..., ssh://user@host/..., user@host:path)');
  }
  if (!HOST_RE.test(host)) throw bad('invalid host name');
  if (port !== null && (port < 1 || port > 65535)) throw bad('invalid port');
  if (!p || p === '/') throw bad('URL has no repository path');
  if (kind === 'https' && !HTTPS_PATH_RE.test(p)) throw bad('invalid characters in the URL path');
  checkPath(p, 'URL path');
  const cls = hostClass(host);
  if (cls === 'invalid') throw bad('ambiguous or malformed numeric host');
  const warnings = [];
  if (cls === 'lan' || cls === 'loopback' || cls === 'link-local') warnings.push(`host '${host}' looks like a local/LAN address (${cls}); make sure you trust it`);
  const defPort = kind === 'https' ? 443 : 22;
  const normPath = p.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  const normalized = `${host.toLowerCase()}${port && port !== defPort ? ':' + port : ''}/${normPath.toLowerCase()}`;
  return { kind, host: host.toLowerCase(), port, path: p, user, normalized, url: s, lan: cls !== 'public', warnings };
}
const normalizeRemote = (u) => parseRemote(u).normalized;

// ------------------------------------------------------------------ git execution
/** Run git with an argv array; collect output. Never rejects: {code, out, err, error}. opts: cwd, timeoutMs, hooks, maxBuffer, env */
function git(cwd, args, { timeoutMs = 60000, maxBuffer = 32 * 1024 * 1024, hooks = 'off', env } = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) return Promise.resolve({ code: -1, out: '', err: '', error: 'invalid git arguments' });
  return new Promise((resolve) => {
    execFile('git', [...baseConfig({ hooks }), ...args], { cwd, timeout: timeoutMs, maxBuffer, env: buildEnv(env), killSignal: 'SIGKILL' },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        out: String(stdout || ''), err: String(stderr || ''), error: err ? err.message : null,
      }));
  });
}

/** Streamed git (clone/fetch): process-group kill on timeout/cancel, line callback, same hardening. Resolves {code, signal, timedOut, error}. */
function gitStream(cwd, args, { timeoutMs = 10 * 60 * 1000, onLine, onSpawn, hooks = 'off', env } = {}) {
  return run('git', [...baseConfig({ hooks }), ...args], { cwd, timeoutMs, onLine, onSpawn, env: buildEnv(env), replaceEnv: true });
}

/** Map git/ssh error text to something a human can act on. Input may contain secrets: output is redacted. */
function friendlyGitError(text) {
  const t = redact(String(text || ''));
  const has = (re) => re.test(t);
  if (has(/terminal prompts disabled|could not read Username|could not read Password|Authentication failed|HTTP Basic: Access denied/i)) return 'repository not found, or not accessible with your existing git credentials (private repositories need a credential helper or ssh-agent; the orchestrator never asks for or stores passwords)';
  if (has(/Permission denied \(publickey|Permission denied, please try again/i)) return 'ssh authentication failed (no usable key in ssh-agent for this host)';
  if (has(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i)) return 'ssh host key is not trusted yet. Run `ssh -T git@<host>` once in a terminal, accept the key, then retry';
  if (has(/Repository not found|repository '.*' not found|does not appear to be a git repository|not found/i)) return 'repository not found (or not accessible with your existing credentials)';
  if (has(/Could not resolve host|Name or service not known|nodename nor servname/i)) return 'could not resolve the host name (network/DNS problem)';
  if (has(/Connection (refused|timed out)|timed out|Operation timed out/i)) return 'could not connect to the server (connection refused or timed out)';
  if (has(/not allowed|transport .* not allowed/i)) return 'this transport/protocol is not allowed (only https and ssh are enabled)';
  if (has(/SSL certificate|certificate verify/i)) return 'TLS certificate problem while contacting the server';
  return t.trim().split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) || 'git failed';
}

/** Pre-flight: reachability + auth + default branch, no disk writes. Returns {ok, default_branch, head, error}. */
async function lsRemote(url, { timeoutMs = 30000 } = {}) {
  const r = parseRemote(url);
  const res = await git(undefined, ['ls-remote', '--symref', '--', r.url, 'HEAD'], { timeoutMs });
  if (res.code !== 0) return { ok: false, error: friendlyGitError(res.err || res.error), raw: redact(res.err).slice(0, 500) };
  const sym = res.out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  const head = res.out.match(/^([0-9a-f]{40})\s+HEAD/m);
  return { ok: true, default_branch: sym ? sym[1] : null, head: head ? head[1] : null, empty: !head };
}

/** Progress parser for `git clone --progress` stderr lines. Returns percent 0..100 or null. */
function parseProgress(line) {
  const m = String(line).match(/(Receiving objects|Resolving deltas|Checking out files|Counting objects|Compressing objects|Updating files):\s+(\d+)%/);
  if (!m) return null;
  const w = { 'Counting objects': [0, 5], 'Compressing objects': [5, 10], 'Receiving objects': [10, 80], 'Resolving deltas': [80, 95], 'Updating files': [95, 100], 'Checking out files': [95, 100] }[m[1]];
  return Math.round(w[0] + (w[1] - w[0]) * Number(m[2]) / 100);
}

/** `git init -b main` + initial commit (always; --allow-empty) in an EMPTY directory we just created. identity: {name,email} or null (-> orchestrator identity). */
async function initRepo(dir, { branch = 'main', identity = null, message = 'Initial commit (created by local AI dev orchestrator)', add = [] } = {}) {
  const id = identity && identity.name && identity.email ? identity : { name: 'AI Dev Orchestrator', email: 'ai-orchestrator@localhost' };
  const i = await git(dir, ['init', '-b', branch], { hooks: 'off' });
  if (i.code !== 0) throw bad(`git init failed: ${redact(i.err || i.error).trim()}`);
  if (add.length) { const a = await git(dir, ['add', '--', ...add], { hooks: 'off' }); if (a.code !== 0) throw bad(`git add failed: ${redact(a.err || a.error).trim()}`); }
  const c = await git(dir, ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-q', '--allow-empty', '--no-verify', '-m', message], { hooks: 'off' });
  if (c.code !== 0) throw bad(`initial commit failed: ${redact(c.err || c.error).trim()}`);
  return id;
}

/** The user's configured git identity (global/system config) or null. */
async function userIdentity() {
  const n = (await git(undefined, ['config', '--get', 'user.name'], { timeoutMs: 5000 })).out.trim();
  const e = (await git(undefined, ['config', '--get', 'user.email'], { timeoutMs: 5000 })).out.trim();
  return n && e ? { name: n.slice(0, 200), email: e.slice(0, 200) } : null;
}

module.exports = { parseRemote, normalizeRemote, git, gitStream, buildEnv, baseConfig, redact, friendlyGitError, lsRemote, parseProgress, initRepo, userIdentity, TEST_FILE_FLAG, ENV_ALLOW };

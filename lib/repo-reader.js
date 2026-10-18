'use strict';
// READ-ONLY reader of a registered service's repository for chat context. Source = the git OBJECT DATABASE of the service's default branch
// (a pinned commit), never the working tree: an untracked .env or a dirty checkout can never be read, and symlinks are never followed (mode 120000 is skipped).
// Gates, re-checked on EVERY open(): service active + not archived, repo.assertUsable (authorized roots + own-dirs exclusion, realpath based, so a symlinked
// local_path that escapes the roots is refused), subdir confinement. Only these git sub-commands run: rev-parse, ls-tree, show, grep (see gitRO). No writes.
const path = require('node:path');
const { git } = require('./proc');
const repo = require('./repo');

const LIMITS = { fileBytes: 64 * 1024, files: 40, scanBytes: 200 * 1024, grepMs: 5000, treeEntries: 150, treeDepth: 3, listEntries: 20000 };
const RO_GIT = new Set(['rev-parse', 'ls-tree', 'show', 'grep']);
const gitRO = (cwd, args, o = {}) => {
  if (!RO_GIT.has(args[0])) throw new Error(`repo-reader: git ${args[0]} is not allowed (read-only)`);
  return git(cwd, args, { timeoutMs: LIMITS.grepMs * 3, ...o });
};

// ---------------------------------------------------------------- deny rules (default-deny, not overridable from the UI)
const DENY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.aws', '.ssh', '.terraform', '.venv', '__pycache__', '.gnupg']);
const DENY_DIR_RE = [/^secrets?($|[._-])/i, /^credentials?($|[._-])/i];
const ENV_OK = /^\.env\.(example|sample|template|dist)$/i;
const DENY_FILE_RE = [
  /^\.env(rc|\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx|crt|cer|der|asc|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd|pgpass)$/i,
  /^credentials/i, /^secrets?($|[._-])/i, /\.secrets?($|\.)/i, /\.tfstate/i, /\.tfvars/i, /^service-account.*\.json$/i, /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|Pipfile\.lock)$/,
  /\.min\.(js|css)$/i, /\.map$/i, /\.(sqlite3?|db|db-wal|db-shm)$/i, /^\.DS_Store$/,
];
const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'pdf', 'zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'class', 'jar', 'war', 'so', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'o', 'a', 'pyc', 'psd', 'sketch', 'dmg', 'iso', 'parquet']);

/** Why a repo-relative posix path must never be shown to the model, or null when allowed. */
function denyReason(p) {
  const segs = String(p).split('/').filter(Boolean);
  if (!segs.length) return 'empty path';
  const base = segs[segs.length - 1];
  for (const s of segs.slice(0, -1)) {
    if (DENY_DIRS.has(s)) return `ignored directory (${s})`;
    if (DENY_DIR_RE.some((re) => re.test(s))) return `secrets-like directory (${s})`;
  }
  if (segs.length >= 2 && segs[segs.length - 2] === '.kube' && base === 'config') return 'kube config (secret)';
  if (ENV_OK.test(base)) return null;
  if (DENY_FILE_RE.some((re) => re.test(base))) return /lock|\.min\.|\.map$|sqlite|\.db/i.test(base) ? 'ignored file type (lockfile/minified/db)' : 'secret-like file name';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  if (BINARY_EXT.has(ext)) return 'binary file';
  return null;
}

// ---------------------------------------------------------------- redaction of secret-looking content (counted in the manifest)
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'], [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'], [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, '[REDACTED AUTH HEADER]'],
];
const KV_RE = /((?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|private[_-]?key|access[_-]?key|authorization)[\w-]*['"]?\s*[:=]\s*)(['"]?)([^\s'",;]{8,})\2/gi;
function redact(text) {
  let n = 0; let out = String(text);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, () => { n++; return rep; });
  out = out.replace(KV_RE, (m, pre) => { n++; return `${pre}[REDACTED]`; });
  return { text: out, count: n };
}

// ---------------------------------------------------------------- opening a service (all gates)
/** Safe repo-relative path inside the service dir: no '..', no absolute, no NUL, no leading '-', posix. Returns the SERVICE-relative path or null. */
function cleanRel(input) {
  let p = String(input ?? '').trim().replace(/\\/g, '/');
  if (!p || p.includes('\0') || p.length > 512 || path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return null;
  p = path.posix.normalize(p).replace(/^\.\//, '');
  if (!p || p === '.' || p === '..' || p.startsWith('../') || p.startsWith('-')) return null;
  return p;
}
const subdirOf = (service) => { const s = String(service.path || '.').replace(/\\/g, '/'); return s === '.' || s === './' || !s ? '' : cleanRel(s); };

/**
 * Open a service for reading. Returns { ok:true, reader } or { ok:false, reason } (never throws): the caller records the reason in the manifest.
 */
async function open(service) {
  if (!service) return { ok: false, reason: 'service not found' };
  if (service.archived) return { ok: false, reason: 'service is archived' };
  if (service.status && service.status !== 'active') return { ok: false, reason: `service status is '${service.status}' (not active)` };
  let repoRoot;
  try { repoRoot = repo.assertUsable(service); } catch (e) { return { ok: false, reason: String(e.message).replace(/\s+- authorize the root.*$/, '') }; }
  const sub = subdirOf(service);
  if (sub === null) return { ok: false, reason: `service path '${service.path}' is not a safe repo-relative path` };
  const branch = String(service.default_branch || 'HEAD');
  if (branch.startsWith('-')) return { ok: false, reason: 'unsafe branch name' };
  const rp = await gitRO(repoRoot, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  const sha = rp.out.trim();
  if (rp.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, reason: `branch '${branch}' not found in the repository` };
  return { ok: true, reader: { service, repoRoot, branch, sha, short: sha.slice(0, 8), sub, scanned: 0, filesRead: 0 } };
}

// ---------------------------------------------------------------- tree (cached per commit)
const treeCache = new Map(); // `${repoRoot}\0${sha}\0${sub}` -> { at, entries }
const TREE_TTL = 30000;
const toRepoPath = (r, rel) => (r.sub ? `${r.sub}/${rel}` : rel);

/** All readable files of the service dir at the pinned commit: [{path (service-relative), size}] + counts of what was left out. */
async function tree(r) {
  const key = `${r.repoRoot}\0${r.sha}\0${r.sub}`;
  const hit = treeCache.get(key);
  if (hit && Date.now() - hit.at < TREE_TTL) return hit.value;
  const args = ['ls-tree', '-r', '-z', '--long', r.sha, ...(r.sub ? ['--', `${r.sub}/`] : [])];
  const res = await gitRO(r.repoRoot, args, { maxBuffer: 64 * 1024 * 1024 });
  const entries = []; const left = { symlink: 0, denied: 0, large: 0, other: 0 };
  if (res.code === 0) {
    let seen = 0;
    for (const rec of res.out.split('\0')) {
      const m = /^(\d{6}) (\w+) [0-9a-f]+\s+(-|\d+)\t([\s\S]+)$/.exec(rec);
      if (!m) continue;
      if (++seen > LIMITS.listEntries) break;
      const [, mode, type, size, full] = m;
      if (type !== 'blob') { left.other++; continue; }
      if (mode === '120000') { left.symlink++; continue; }
      const rel = r.sub ? full.slice(r.sub.length + 1) : full;
      if (denyReason(full) || denyReason(rel)) { left.denied++; continue; }
      entries.push({ path: rel, size: Number(size) });
    }
  }
  const value = { entries, left, ok: res.code === 0 };
  treeCache.set(key, { at: Date.now(), value });
  if (treeCache.size > 50) treeCache.delete(treeCache.keys().next().value);
  return value;
}

/** Read one file (service-relative path) from the pinned commit. Returns {ok, text, redactions} or {ok:false, reason}. Enforces deny list, size, binary sniff, per-request budgets. */
async function readFile(r, rel, { maxBytes = LIMITS.fileBytes } = {}) {
  const p = cleanRel(rel);
  if (!p) return { ok: false, reason: 'invalid path' };
  const full = toRepoPath(r, p);
  const d = denyReason(full) || denyReason(p);
  if (d) return { ok: false, reason: `skipped: ${d}` };
  if (r.filesRead >= LIMITS.files) return { ok: false, reason: `skipped: per-request file limit (${LIMITS.files})` };
  if (r.scanned >= LIMITS.scanBytes) return { ok: false, reason: `skipped: per-request read limit (${Math.round(LIMITS.scanBytes / 1024)} KB)` };
  const t = await tree(r);
  const ent = t.entries.find((e) => e.path === p);
  if (!ent) return { ok: false, reason: 'not found in the default branch (or a symlink/ignored entry)' };
  if (ent.size > maxBytes) return { ok: false, reason: `skipped: file too large (${Math.round(ent.size / 1024)} KB > ${Math.round(maxBytes / 1024)} KB)` };
  const res = await gitRO(r.repoRoot, ['show', `${r.sha}:${full}`], { maxBuffer: maxBytes + 4096 });
  if (res.code !== 0) return { ok: false, reason: 'could not be read' };
  r.filesRead++; r.scanned += ent.size;
  if (res.out.includes('\0')) return { ok: false, reason: 'skipped: binary file' };
  const red = redact(res.out.replace(/\r\n/g, '\n'));
  return { ok: true, text: red.text, redactions: red.count, size: ent.size };
}

/** Files (service-relative) containing each keyword: Map(keyword -> Set(path)). git grep on the commit; fixed strings, case-insensitive; hard timeout. */
async function grepFiles(r, keywords) {
  const allowed = new Map((await tree(r)).entries.map((e) => [e.path, e]));
  const out = new Map();
  for (const kw of keywords) {
    const args = ['grep', '-l', '-z', '-I', '-F', '-i', '-e', kw, r.sha, ...(r.sub ? ['--', `:(literal)${r.sub}`] : [])];
    const res = await gitRO(r.repoRoot, args, { timeoutMs: LIMITS.grepMs, maxBuffer: 8 * 1024 * 1024 });
    const set = new Set();
    if (res.code === 0) for (const rec of res.out.split('\0')) {
      if (!rec) continue;
      const full = rec.startsWith(`${r.sha}:`) ? rec.slice(r.sha.length + 1) : rec;
      const rel = r.sub ? (full.startsWith(`${r.sub}/`) ? full.slice(r.sub.length + 1) : null) : full;
      if (rel && allowed.has(rel)) set.add(rel);
    }
    out.set(kw, set);
  }
  return out;
}

module.exports = { open, tree, readFile, grepFiles, denyReason, redact, cleanRel, subdirOf, LIMITS, gitRO };

'use strict';
// Filesystem guard: authorized roots, path canonicalisation, and the ONLY recursive-delete primitive of the orchestrator.
// Pure functions (no DB): callers pass the roots / protected dirs, so the module is unit-testable.
//   createGuard({ home, ownDirs, getRoots }) -> { validateRoot, resolveInRoots, recheck, ... }
//   removeOwnedDir(target, policy)           -> the only code path allowed to `rm -rf` anything.
const fs = require('node:fs');
const path = require('node:path');
const { bad, forbidden } = require('./errors');

const DARWIN = process.platform === 'darwin' || process.platform === 'win32'; // case-insensitive file systems by default
const fold = (p) => (DARWIN ? p.normalize('NFC').toLowerCase() : p.normalize('NFC'));
const CTRL = /[\x00-\x1f\x7f]/; // eslint-disable-line no-control-regex
const SYSTEM_DIRS = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Applications', '/dev', '/opt', '/cores', '/Network', '/proc', '/sys', '/boot', '/root', '/lib', '/lib64', '/run', '/srv', '/mnt'];

/** boundary-safe containment (child === parent counts as inside); case/NFC-folded on darwin. */
function inside(child, parent) {
  const c = fold(child), p = fold(parent);
  if (c === p) return true;
  const pp = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(pp);
}
const same = (a, b) => fold(a) === fold(b);

function real(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

/** Canonicalise a (possibly not yet existing) absolute path: realpath of the nearest existing ancestor + the remaining segments. */
function canonical(p) {
  let anc = p; const rest = [];
  for (let i = 0; i < 4096; i++) {
    let st = null;
    try { st = fs.lstatSync(anc); } catch { /* missing */ }
    if (st) break;
    rest.unshift(path.basename(anc));
    const up = path.dirname(anc);
    if (up === anc) break;
    anc = up;
  }
  const ra = real(anc);
  if (!ra) throw bad(`cannot resolve path (broken symlink or loop): ${anc}`);
  return { resolved: path.join(ra, ...rest), existing: rest.length === 0, ancestor: ra, rest };
}

/** Basic syntactic checks shared by every entry point. Returns the absolute, ~-expanded, normalised path (not canonicalised). */
function syntactic(input, label, home) {
  if (typeof input !== 'string') throw bad(`${label} required`);
  let p = input.trim();
  if (!p) throw bad(`${label} required`);
  if (p.length > 4096) throw bad(`${label} too long`);
  if (CTRL.test(p)) throw bad(`invalid ${label} (control characters)`);
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  else if (p.startsWith('~')) throw bad(`invalid ${label} ('~user' is not supported)`);
  if (!path.isAbsolute(p)) throw bad(`${label} must be an absolute path (or start with ~/)`);
  return path.resolve(p);
}

/**
 * @param {{home:string, ownDirs?:string[]|(()=>string[]), getRoots?:()=>string[]}} o
 *   ownDirs: the orchestrator's own directories (code, data, logs, worktrees, context): no target may be inside them.
 *   getRoots: returns the currently authorized roots (already validated, canonical).
 */
function createGuard({ home, ownDirs = [], getRoots = () => [] }) {
  const homeReal = real(home) || home;
  const own = () => (typeof ownDirs === 'function' ? ownDirs() : ownDirs).map((d) => real(d) || path.resolve(d));

  /** Validate a directory proposed as an authorized root. Returns {path, warnings}. Throws a 400/403 error with the reason. */
  function validateRoot(input, label = 'root') {
    const p = syntactic(input, label, home);
    let st;
    try { st = fs.statSync(p); } catch { throw bad(`${label} does not exist: ${p}`); }
    if (!st.isDirectory()) throw bad(`${label} is not a directory: ${p}`);
    const r = real(p);
    if (!r) throw bad(`cannot resolve ${label}`);
    const warnings = [];
    if (r === path.parse(r).root) throw forbidden(`${label} must not be the file system root`);
    if (same(r, homeReal)) throw forbidden(`${label} must not be your home directory itself`);
    const inHome = inside(r, homeReal);
    if (!inHome) {
      for (const s of SYSTEM_DIRS) if (inside(r, s) && !inside(r, '/private/var/folders')) throw forbidden(`${label} must not be inside the system directory ${s}`);
      if (same(r, '/Volumes')) throw forbidden(`${label} must not be /Volumes itself (use a folder on a volume)`);
    } else {
      const rel = path.relative(homeReal, r).split(path.sep);
      if (rel.some((seg) => seg.startsWith('.'))) throw forbidden(`${label} must not be (inside) a hidden directory (${r})`);
      if (rel[0] === 'Library') throw forbidden(`${label} must not be inside ~/Library`);
    }
    for (const d of own()) {
      if (inside(r, d)) throw forbidden(`${label} is inside the orchestrator's own directory ${d}`);
      if (inside(d, r)) warnings.push(`${label} contains the orchestrator's own directory ${d}; those paths stay off limits for every operation`);
    }
    return { path: r, warnings };
  }

  /**
   * Resolve user input to a canonical absolute path that is inside an authorized root.
   * opts: label, mustExist, forCreate (final component must not exist and must not be a symlink), allowRoot (path may equal a root; default true),
   *       allowHidden (internal use: staging dirs), roots (override).
   */
  function resolveInRoots(input, opts = {}) {
    const { label = 'path', mustExist = false, forCreate = false, allowRoot = true, allowHidden = false } = opts;
    const roots = (opts.roots || getRoots()).map((r) => real(r) || r);
    if (!roots.length) throw forbidden('no authorized roots are configured; add one first');
    const abs = syntactic(input, label, home);
    const { resolved, existing } = canonical(abs);
    if (mustExist && !existing) throw bad(`${label} does not exist: ${abs}`);
    const root = roots.find((r) => inside(resolved, r));
    if (!root) throw forbidden(`${label} is outside the authorized roots (${roots.join(', ')}): ${resolved}`, { code: 'outside_roots' });
    if (!allowRoot && same(resolved, root)) throw bad(`${label} must be inside an authorized root, not the root itself`);
    for (const d of own()) if (inside(resolved, d)) throw forbidden(`${label} is inside the orchestrator's own directory ${d}`);
    if (!allowHidden) {
      const rel = path.relative(root, resolved).split(path.sep).filter(Boolean);
      if (rel.some((seg) => seg.startsWith('.'))) throw forbidden(`${label} must not contain hidden path segments (${resolved})`);
    }
    if (forCreate) {
      let st = null;
      try { st = fs.lstatSync(resolved); } catch { /* does not exist: good */ }
      if (st) throw bad(`${label} already exists: ${resolved}${st.isSymbolicLink() ? ' (symbolic link)' : ''}`, { code: 'exists' });
      // the parent chain must be real directories inside the root (no symlinked parent that canonical() already resolved elsewhere)
      const parent = path.dirname(resolved);
      const rp = real(parent);
      if (rp && !inside(rp, root)) throw forbidden(`${label} parent resolves outside the authorized root`);
    }
    return resolved;
  }

  /** Re-check AFTER an operation: what actually exists on disk is still inside an authorized root (TOCTOU / symlink swaps). */
  function recheck(p, label = 'path') {
    const rp = real(p);
    if (!rp) throw bad(`${label} vanished after creation`);
    const roots = getRoots().map((r) => real(r) || r);
    if (!roots.some((r) => inside(rp, r))) throw forbidden(`${label} resolved outside the authorized roots after creation (${rp})`);
    return rp;
  }

  return { validateRoot, resolveInRoots, recheck, homeReal, own };
}

/**
 * THE only recursive delete in the orchestrator. Deletes `target` only when ALL hold:
 *  - absolute path, not a symlink, an existing directory, not a filesystem root / home / one of `policy.protect` (e.g. service repos),
 *  - and it is either listed by `policy.isOwned(path)` (journal: we created it) or strictly inside one of `policy.ownedPrefixes`
 *    (worktrees root, trash) or has the basename prefix `.orch-clone-` AND lives in `policy.cloneParents` (inside an authorized root).
 * Returns true when removed, false when it did not exist. Throws on any violation (nothing is removed then).
 */
function removeOwnedDir(target, policy = {}) {
  const { isOwned = () => false, ownedPrefixes = [], protect = () => false, home = require('node:os').homedir(), cloneParents = null } = policy;
  if (typeof target !== 'string' || !path.isAbsolute(target) || CTRL.test(target)) throw new Error('removeOwnedDir: absolute path required');
  const t = path.resolve(target);
  let st;
  try { st = fs.lstatSync(t); } catch { return false; }
  if (st.isSymbolicLink()) throw new Error(`removeOwnedDir: refusing to remove a symbolic link: ${t}`);
  if (!st.isDirectory()) throw new Error(`removeOwnedDir: not a directory: ${t}`);
  const rt = real(t);
  if (!rt) throw new Error(`removeOwnedDir: cannot resolve ${t}`);
  if (rt === path.parse(rt).root || same(rt, real(home) || home)) throw new Error('removeOwnedDir: refusing to remove a root or the home directory');
  if (protect(rt)) throw new Error(`removeOwnedDir: refusing, ${rt} is a protected (registered) location`);
  let allowed = false;
  if (isOwned(rt) || isOwned(t)) allowed = true;
  for (const pre of ownedPrefixes) { const rp = real(pre) || pre; if (!same(rt, rp) && inside(rt, rp)) allowed = true; }
  if (!allowed && path.basename(rt).startsWith('.orch-clone-') && cloneParents && cloneParents.some((cp) => { const r = real(cp) || cp; return same(path.dirname(rt), r); })) allowed = true;
  if (!allowed) throw new Error(`removeOwnedDir: ${rt} is not owned by the orchestrator (not journaled, not under worktrees/trash)`);
  fs.rmSync(rt, { recursive: true, force: true });
  return true;
}

module.exports = { createGuard, removeOwnedDir, inside, same, fold, real, canonical, SYSTEM_DIRS };

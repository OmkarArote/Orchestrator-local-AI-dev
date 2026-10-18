'use strict';
// Authorized roots (DB-backed) + the shared fsguard instance used by every service operation.
const cfg = require('../config');
const store = require('./db');
const fsg = require('./fsguard');
const { conflict, notFound } = require('./errors');

const guard = fsg.createGuard({ home: cfg.HOME, ownDirs: () => cfg.ownDirs(), getRoots: () => store.listRoots().map((r) => r.path) });

const list = () => store.listRoots().map((r) => ({ ...r, exists: !!fsg.real(r.path) }));
function add(input, label = '') {
  const v = guard.validateRoot(input, 'root');
  if (store.listRoots().some((r) => fsg.same(r.path, v.path))) throw conflict(`'${v.path}' is already an authorized root`);
  const id = store.addRoot(v.path, String(label || '').slice(0, 100));
  return { id, path: v.path, warnings: v.warnings };
}
function remove(id) {
  const r = store.listRoots().find((x) => x.id === Number(id));
  if (!r) throw notFound('root not found');
  const using = store.allServices({ includeArchived: false }).filter((s) => s.local_path && fsg.inside(s.local_path, r.path));
  if (using.length) throw conflict(`root is used by ${using.length} registered service(s) (${using.slice(0, 3).map((s) => s.name).join(', ')}); unregister or archive them first`);
  store.removeRoot(r.id);
  return { removed: r.path };
}
/** What the guard would say about a path (read-only, no side effects). */
function check(input) {
  try { const p = guard.resolveInRoots(input, { label: 'path' }); return { ok: true, path: p }; }
  catch (e) { return { ok: false, error: e.message, code: (e.extra && e.extra.code) || null }; }
}
module.exports = { guard, list, add, remove, check };

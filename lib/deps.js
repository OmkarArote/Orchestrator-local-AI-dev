'use strict';
// Service dependency map of a project (service -> service, or service -> external system such as "postgres"). Used for the context bundle,
// the SERVICES.md draft and (later) multi-service planning. Purely informational: it never changes what a task may touch.
const store = require('./db');
const { ProjectError } = require('./projects');

const bad = (m) => new ProjectError(400, m);
const conflict = (m) => new ProjectError(409, m);
const EXT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,63}$/;

function view(project) {
  const byId = new Map(store.listServices(project.id, { includeArchived: true }).map((s) => [s.id, s]));
  return store.listDeps(project.id).map((d) => ({
    id: d.id, service_id: d.service_id, service: (byId.get(d.service_id) || {}).name || null,
    depends_on_service_id: d.depends_on_service_id, depends_on: d.depends_on_service_id ? (byId.get(d.depends_on_service_id) || {}).name || null : d.external,
    external: d.external, note: d.note,
  }));
}

function add(project, body) {
  const svc = (v, label) => { const s = store.getService(Number(v)); if (!s || s.project_id !== project.id) throw bad(`${label} ${v} is not a service of project '${project.name}'`); return s; };
  const from = svc(body.service_id, 'service_id');
  const note = String(body.note ?? '').trim().slice(0, 300);
  const hasTo = body.depends_on_service_id !== undefined && body.depends_on_service_id !== null && body.depends_on_service_id !== '';
  const hasExt = body.external !== undefined && body.external !== null && String(body.external).trim() !== '';
  if (hasTo === hasExt) throw bad('give exactly one of depends_on_service_id or external');
  let to = null, external = null;
  if (hasTo) { to = svc(body.depends_on_service_id, 'depends_on_service_id'); if (to.id === from.id) throw bad('a service cannot depend on itself'); }
  else { external = String(body.external).trim(); if (!EXT_RE.test(external)) throw bad("external must be a short name like 'postgres' or 'stripe-api'"); }
  if (store.listDeps(project.id).some((d) => d.service_id === from.id && (to ? d.depends_on_service_id === to.id : d.external === external))) throw conflict('this dependency already exists');
  store.addDep({ project_id: project.id, service_id: from.id, depends_on_service_id: to ? to.id : null, external, note });
  return view(project);
}

function remove(project, body) {
  if (!store.removeDep(project.id, Number(body.id))) throw new ProjectError(404, 'dependency not found');
  return view(project);
}

/** Neighbours of one service for the context bundle: what it depends on, and who depends on it. */
function neighbours(project, service) {
  const all = view(project).filter((d) => d.service);
  return { uses: all.filter((d) => d.service_id === service.id).map((d) => d.depends_on + (d.note ? ` (${d.note})` : '')),
    usedBy: all.filter((d) => d.depends_on_service_id === service.id).map((d) => d.service + (d.note ? ` (${d.note})` : '')) };
}

module.exports = { view, add, remove, neighbours };

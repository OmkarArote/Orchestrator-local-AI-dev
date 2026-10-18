'use strict';
// @mentions in chat messages: parsing, resolution against the projects registry, autocomplete. Pure registry lookups (DB only): no file access here.
//   @project   @service   @project/service   @service:path/in/service   @project/service:path
// Resolution order for a bare @x: project (name or slug, case-insensitive) first; else a service named x (preferring the conversation's project);
// several candidates -> status 'ambiguous' with the candidate list (never guess); nothing -> 'unknown'. Both are NON-blocking: the chat goes on without them.
const store = require('./db');

const NAME = '[A-Za-z0-9][\\w.-]{0,63}';
const MENTION_RE = new RegExp(`(^|[\\s(\\[{,;:"'])@(${NAME})(?:/(${NAME}))?(?::([^\\s,;)\\]}"'<>]+))?`, 'g');
const mask = (s, re) => s.replace(re, (m) => ' '.repeat(m.length));

/** Remove what must never produce a mention: fenced code, inline code, escaped \@ (same length, so indexes stay valid). */
function maskedText(text) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?(```|$)/g, (m) => ' '.repeat(m.length));      // fenced (an unclosed fence masks to the end)
  t = t.replace(/~~~[\s\S]*?(~~~|$)/g, (m) => ' '.repeat(m.length));
  t = mask(t, /`[^`\n]*`/g);                                               // inline code
  t = t.replace(/\\@/g, '  ');                                             // escaped @
  return t;
}
const trimTail = (s) => (s ? s.replace(/[.\-_]+$/, '') : s);

/** -> [{raw, a, b, file, index}] in order of appearance, de-duplicated. Emails (a@b.c: '@' glued to a word) are not mentions. */
function parseMentions(text) {
  const t = maskedText(text); const out = []; const seen = new Set();
  for (const m of t.matchAll(MENTION_RE)) {
    const index = m.index + m[1].length;
    let a = m[2], b = m[3] || null, file = m[4] || null;
    if (file) file = file.replace(/[.,:;!?]+$/, '') || null;
    if (b) b = trimTail(b); else a = trimTail(a);
    if (!a) continue;
    const raw = `@${a}${b ? `/${b}` : ''}${file ? `:${file}` : ''}`;
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    out.push({ raw, a, b, file, index });
  }
  return out;
}
/** The text without the mention tokens (for keyword extraction). */
const stripMentions = (text) => String(text ?? '').replace(new RegExp(MENTION_RE.source, 'g'), (m, pre) => pre).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- resolution
const lc = (s) => String(s ?? '').toLowerCase();
const activeProjects = () => store.listProjects({ includeArchived: false });
const projectByName = (n, ps = activeProjects()) => ps.find((p) => lc(p.name) === lc(n)) || ps.find((p) => lc(p.slug) === lc(n)) || null;
const servicesOf = (p) => store.listServices(p.id, { includeArchived: false });
const serviceNamed = (p, n) => servicesOf(p).find((s) => lc(s.name) === lc(n)) || null;
/** The token to type for a project: its name when it is mention-safe, else its slug. */
const projectToken = (p) => (new RegExp(`^${NAME}$`).test(p.name) ? p.name : p.slug || p.name);

function refOf(kind, project, service, file) {
  return { kind, project_id: project.id, project: project.name, service_id: service ? service.id : null, service: service ? service.name : null, file: file || null };
}

/** Resolve one parsed mention. -> {raw, status:'ok'|'unknown'|'ambiguous', ref?, candidates?, message} */
function resolveMention(m, { projectId = null } = {}) {
  const base = { raw: m.raw };
  const ps = activeProjects();
  if (m.b) { // @project/service
    const p = projectByName(m.a, ps);
    if (!p) return { ...base, status: 'unknown', message: `no project named '${m.a}'`, candidates: [] };
    const s = serviceNamed(p, m.b);
    if (!s) return { ...base, status: 'unknown', message: `project '${p.name}' has no service '${m.b}'`, candidates: servicesOf(p).map((x) => `${projectToken(p)}/${x.name}`) };
    return { ...base, status: 'ok', ref: refOf('service', p, s, m.file) };
  }
  const p = projectByName(m.a, ps);
  if (p && !m.file) return { ...base, status: 'ok', ref: refOf('project', p, null, null) };
  // a service name (a pinned file always means a service)
  let hits = [];
  for (const q of ps) { const s = serviceNamed(q, m.a); if (s) hits.push({ p: q, s }); }
  if (projectId && hits.length > 1) { const scoped = hits.filter((h) => h.p.id === projectId); if (scoped.length === 1) hits = scoped; }
  if (hits.length === 1) return { ...base, status: 'ok', ref: refOf('service', hits[0].p, hits[0].s, m.file) };
  if (hits.length > 1) return { ...base, status: 'ambiguous', message: `'${m.a}' is a service in ${hits.length} projects; write @project/${m.a}`, candidates: hits.map((h) => `${projectToken(h.p)}/${h.s.name}`) };
  if (p && m.file) return { ...base, status: 'unknown', message: `'${m.a}' is a project; a file needs a service (@${projectToken(p)}/service:${m.file})`, candidates: servicesOf(p).map((x) => `${projectToken(p)}/${x.name}`) };
  return { ...base, status: 'unknown', message: `no project or service named '${m.a}'`, candidates: [] };
}
const resolveAll = (text, opts) => parseMentions(text).map((m) => resolveMention(m, opts));

/** Re-resolve a stored (sticky) mention by ids; null when the project/service is gone, archived or no longer matches. */
function rehydrate(ref) {
  if (!ref || !Number.isInteger(ref.project_id)) return null;
  const p = store.getProject(ref.project_id);
  if (!p || p.archived) return null;
  if (!ref.service_id) return refOf('project', p, null, null);
  const s = store.getService(ref.service_id);
  if (!s || s.archived || s.project_id !== p.id) return null;
  return refOf('service', p, s, ref.file);
}
const keyOf = (r) => `${r.kind}:${r.project_id}:${r.service_id || ''}:${r.file || ''}`;
const labelOf = (r) => (r.kind === 'project' ? `@${r.project}` : `@${r.project}/${r.service}${r.file ? `:${r.file}` : ''}`);

// ---------------------------------------------------------------- autocomplete
/**
 * q = what the user typed after '@' (e.g. 'bil', 'acme/', 'acme/bil', 'billing:src/'). Files are listed by the caller (needs the repo reader).
 * -> { items:[{kind:'project'|'service', label, insert, project, service, detail}], file: {ref, prefix} | null }
 */
function suggest(q, { projectId = null, limit = 12 } = {}) {
  const s = String(q ?? '').slice(0, 200);
  const colon = s.indexOf(':');
  if (colon >= 0) { // file completion for a resolved service
    const head = s.slice(0, colon), prefix = s.slice(colon + 1);
    const [a, b] = head.includes('/') ? head.split('/') : [head, null];
    const r = resolveMention({ raw: `@${head}`, a, b, file: prefix || 'x' }, { projectId });
    return { items: [], file: r.status === 'ok' && r.ref.kind === 'service' ? { ref: r.ref, prefix } : null, unresolved: r.status !== 'ok' ? r : null };
  }
  const ps = activeProjects(); const needle = lc(s); const items = [];
  const push = (it) => { if (items.length < 200) items.push(it); };
  if (s.includes('/')) {
    const [pn, sn] = s.split('/');
    const p = projectByName(pn, ps);
    if (p) for (const sv of servicesOf(p)) if (!sn || lc(sv.name).startsWith(lc(sn)) || lc(sv.name).includes(lc(sn))) push({ kind: 'service', label: `${projectToken(p)}/${sv.name}`, insert: `@${projectToken(p)}/${sv.name}`, project: p.name, service: sv.name, detail: sv.description || sv.type || '', rank: lc(sv.name).startsWith(lc(sn || '')) ? 0 : 1 });
  } else {
    for (const p of ps) {
      const tok = projectToken(p); const pos = lc(tok).indexOf(needle);
      if (!needle || pos >= 0 || lc(p.name).includes(needle)) push({ kind: 'project', label: tok, insert: `@${tok}`, project: p.name, service: null, detail: `project${p.description ? ` - ${p.description}` : ''}`, rank: !needle || pos === 0 ? 0 : 2 });
      for (const sv of servicesOf(p)) {
        const spos = lc(sv.name).indexOf(needle);
        if (!needle || spos >= 0) push({ kind: 'service', label: `${tok}/${sv.name}`, insert: `@${tok}/${sv.name}`, project: p.name, service: sv.name, detail: `service${sv.description ? ` - ${sv.description}` : ''}`, rank: (!needle || spos === 0 ? 0 : 2) + 0.5 + (projectId && p.id === projectId ? -0.7 : 0) });
      }
    }
  }
  items.sort((x, y) => x.rank - y.rank || x.label.localeCompare(y.label));
  return { items: items.slice(0, limit).map(({ rank, ...rest }) => rest), file: null };
}

module.exports = { parseMentions, stripMentions, resolveMention, resolveAll, rehydrate, suggest, keyOf, labelOf, projectToken, maskedText, MENTION_RE };

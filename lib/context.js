'use strict';
// Project context files (shared by ALL engines): RULES.md, SERVICES.md, MEMORY.md, ARCHITECTURE.md, services/<name>.md.
//
// Context is PROJECT-level (a project is a logical container, it owns no repo). Source of truth for runs = the managed copy in
// <data>/context/<project.slug>/  (edited from the dashboard).
// The  .ai/  folder of ONE chosen service repo is an optional, OPT-IN mirror (project.config.ai_dir = {service_id, import, export}); both default OFF:
//  - import: seeds / refreshes the managed copy from .ai/ on that service's default branch (read only);
//  - export: commits the managed copy onto a NEW branch (ai/context-update-<ts>-<rand>, via a throw-away worktree) and registers it as a
//    review task, so it only reaches the default branch through the normal human approve-merge.
// Nothing here ever writes to a service's main checkout or default branch.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const { git } = require('./proc');
const store = require('./db');
const repo = require('./repo');

const GIT_ID = ['-c', 'user.name=AI Dev Orchestrator', '-c', 'user.email=ai-orchestrator@localhost'];
// BRIEF.md (optional): a short (~3K chars) hand-written brief. When present the bundle uses it INSTEAD of RULES.md + ARCHITECTURE.md, so a
// long rules/architecture pair does not eat the small local models' budget; services/<name>.brief.md likewise replaces services/<name>.md.
const TOP_FILES = ['RULES.md', 'SERVICES.md', 'MEMORY.md', 'ARCHITECTURE.md', 'BRIEF.md'];
const SVC_FILE_RE = /^services\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;
// short rewrites read by the bundle instead of the long originals (the originals stay the source of truth for people)
const BRIEF_FILES = ['RULES.brief.md', 'ARCHITECTURE.brief.md', 'MEMORY.brief.md'];
const validFile = (f) => TOP_FILES.includes(f) || BRIEF_FILES.includes(f) || SVC_FILE_RE.test(f);
// Section shares of the bundle. They sum to at most 1 (they used to reach 1.3, so MEMORY and late parts got only the scraps).
const SHARES = { BRIEF: 0.25, RULES: 0.25, ARCHITECTURE: 0.15, SERVICE_MAP: 0.15, SERVICE_BRIEF: 0.15, SERVICE_NOTES: 0.1, EXTRA: 0.2 };
/**
 * A non-empty <NAME>.brief.md wins over <NAME>.md while it is at least as new as the original; once the original is edited
 * again (an accepted memory proposal appends to MEMORY.md) the original is used until the brief is refreshed. Returns { body, source }.
 */
function readPreferBrief(project, name) {
  const b = read(project, `${name}.brief.md`);
  const mtime = (f) => { try { return fs.statSync(abs(project, f)).mtimeMs; } catch { return 0; } };
  if (b && b.trim() && mtime(`${name}.brief.md`) >= mtime(`${name}.md`)) return { body: b, source: `${name}.brief.md` };
  return { body: read(project, `${name}.md`), source: `${name}.md` };
}

// keyed by the immutable slug (== name for migrated projects, so existing data stays where it is)
const dirFor = (project) => path.join(cfg.CONTEXT_DIR, project.slug || project.name);
const abs = (project, f) => path.join(dirFor(project), f);

function read(project, f) {
  if (!validFile(f)) throw new Error(`invalid context file '${f}'`);
  try { return fs.readFileSync(abs(project, f), 'utf8'); } catch { return null; }
}
function write(project, f, content) {
  if (!validFile(f)) throw new Error(`invalid context file '${f}'`);
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  if (Buffer.byteLength(text) > cfg.CONTEXT_FILE_MAX_BYTES) throw new Error(`file too large (max ${cfg.CONTEXT_FILE_MAX_BYTES} bytes)`);
  const file = abs(project, f);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file); // atomic
}
function managedFiles(project) {
  const out = [];
  for (const f of TOP_FILES) if (fs.existsSync(abs(project, f))) out.push(f);
  try { for (const n of fs.readdirSync(path.join(dirFor(project), 'services')).sort()) if (SVC_FILE_RE.test(`services/${n}`)) out.push(`services/${n}`); } catch { /* none */ }
  return out;
}

// ---- repo (.ai/) side: opt-in, bound to ONE service of the project
/** Settings of the .ai/ mirror: { service_id, import, export } (all falsy = off) plus the resolved target (or null). */
function aiDir(project) {
  const c = (project.config && project.config.ai_dir) || {};
  const out = { service_id: c.service_id ? Number(c.service_id) : null, import: !!c.import, export: !!c.export, target: null, problem: null };
  if (!out.service_id) return out;
  const service = store.getService(out.service_id);
  if (!service || service.project_id !== project.id) { out.problem = `ai_dir service #${out.service_id} is not a service of this project`; return out; }
  try { out.target = { service, repoRoot: repo.assertUsable(service), defaultBranch: service.default_branch }; } catch (e) { out.problem = e.message; }
  return out;
}
const importTarget = (project) => { const a = aiDir(project); return a.import && a.target ? a.target : null; };

async function repoFiles(project) {
  const t = importTarget(project);
  if (!t) return [];
  const r = await git(t.repoRoot, ['ls-tree', '-r', '--name-only', t.defaultBranch, '--', '.ai']);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter(Boolean).map((p) => p.replace(/^\.ai\//, '')).filter(validFile);
}
async function repoRead(project, f) {
  const t = importTarget(project);
  if (!t || !validFile(f)) return null;
  const r = await git(t.repoRoot, ['show', `${t.defaultBranch}:.ai/${f}`]);
  return r.code === 0 ? r.out : null;
}
/** Seed the managed copy from .ai/ the first time (only if import is enabled and no managed files exist). */
async function ensureSeeded(project) {
  if (managedFiles(project).length) return false;
  let n = 0;
  for (const f of await repoFiles(project)) { const c = await repoRead(project, f); if (c !== null) { write(project, f, c); n++; } }
  return n > 0;
}
async function importFromRepo(project) {
  const done = [];
  for (const f of await repoFiles(project)) { const c = await repoRead(project, f); if (c !== null) { write(project, f, c); done.push(f); } }
  return done;
}

/** Skeleton service map generated from the services table (only used as a draft the human edits and saves). */
function generateServicesMd(project, services) {
  const depList = (() => { try { return require('./deps').view(project); } catch { return []; } })();
  const lines = [`# Service map - ${project.name}`, '', '> One section per service. The local router reads this file to decide which service a task belongs to, so keep each',
    '> "Responsibility" line concrete (what it owns, which words a task about it would use). Edit freely.', ''];
  for (const s of services.filter((x) => !x.archived)) {
    lines.push(`## ${s.name}`, `- Path: \`${s.path}\``, ...(s.local_path ? [`- Repo: \`${s.local_path}\``] : []), ...(s.type && s.type !== 'other' ? [`- Type: ${s.type}${s.stack ? ` (${s.stack})` : ''}`] : []), `- Responsibility: ${s.description || '(describe what this service owns)'}`,
      '- APIs: (endpoints / exported functions other code relies on)',
      `- Dependencies: ${depList.filter((d) => d.service_id === s.id).map((d) => d.depends_on + (d.note ? ` (${d.note})` : '')).join(', ') || '(other services, datastores, external APIs)'}`);
    if (s.check_cmd) lines.push(`- Check: \`${s.check_cmd}\``);
    if (s.notes) lines.push(`- Owner notes: ${s.notes}`);
    lines.push('');
  }
  return lines.join('\n');
}
const servicesMdEffective = (project, services) => read(project, 'SERVICES.md') ?? generateServicesMd(project, services);

/** Split markdown into {heading, body} blocks on '## ' headings (preamble has heading ''). */
function sections(md) {
  const out = []; let cur = { heading: '', body: [] };
  for (const line of String(md).split('\n')) {
    if (/^## /.test(line)) { out.push(cur); cur = { heading: line.replace(/^##\s+/, '').trim(), body: [line] }; } else cur.body.push(line);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.body.join('\n').trim() })).filter((s) => s.text);
}
const norm = (h) => String(h).toLowerCase().replace(/[`*_]/g, '').trim();
function sectionFor(md, serviceName) {
  const want = norm(serviceName);
  return sections(md).find((s) => s.heading && (norm(s.heading) === want || norm(s.heading).split(/\s+/)[0] === want)) || null;
}

const clip = (s, n) => {
  if (s.length <= n) return { text: s, truncated: false };
  const cut = s.slice(0, Math.max(0, n - 60));
  return { text: cut.slice(0, Math.max(cut.lastIndexOf('\n'), cut.length * 0.8 | 0)) + '\n[... truncated by orchestrator (context cap) ...]', truncated: true };
};
const tokens = (s) => String(s).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || [];

/** Pick MEMORY entries (blocks) relevant to the task within a char budget: keyword overlap + recency; chronological output. */
function memoryRelevant(md, query, budget) {
  const secs = sections(md);
  const total = secs.map((s) => s.text).join('\n\n');
  if (total.length <= budget) return { text: total, entries: secs.length, picked: secs.length, truncated: false };
  const q = new Set(tokens(query));
  const scored = secs.map((s, i) => {
    const toks = tokens(s.text); let hit = 0;
    for (const t of toks) if (q.has(t)) hit++;
    return { s, i, score: hit + (i / Math.max(1, secs.length)) * 2 + (i === 0 && !s.heading ? 100 : 0) }; // keep the preamble, favour recent
  }).sort((a, b) => b.score - a.score);
  const picked = []; let used = 0;
  for (const c of scored) {
    if (used + c.s.text.length + 2 > budget) continue;
    picked.push(c); used += c.s.text.length + 2;
  }
  if (!picked.length && scored.length) { const c = scored[0]; return { text: clip(c.s.text, budget).text, entries: secs.length, picked: 1, truncated: true }; }
  picked.sort((a, b) => a.i - b.i);
  return { text: picked.map((c) => c.s.text).join('\n\n'), entries: secs.length, picked: picked.length, truncated: true };
}

/**
 * Build the context bundle given to every engine. Returns { text, manifest }.
 * Parts (in order): RULES, SERVICE MAP (index + the selected service's section), SERVICE NOTES, MEMORY (relevant entries).
 * A non-empty BRIEF.md replaces RULES + ARCHITECTURE (part 'BRIEF'); services/<name>.brief.md replaces that service's notes.
 */
function buildBundle({ project, service = null, services = [], taskText = '', maxChars = cfg.CONTEXT_MAX_CHARS, skipParts = [], extraParts = [] }) {
  const manifest = { max_chars: maxChars, parts: [], service: service ? service.name : null, working_root: service ? service.path : '.' };
  let left = maxChars - 400; // header allowance
  const parts = [];
  const add = (title, source, body, budget) => {
    if (!body || !body.trim()) return;
    const c = clip(body.trim(), Math.max(200, Math.min(budget, left)));
    left -= c.text.length + title.length + 8;
    parts.push(`## ${title}\n${c.text}`);
    manifest.parts.push({ name: title, source, chars: c.text.length, truncated: c.truncated });
  };
  const brief = read(project, 'BRIEF.md');
  if (brief && brief.trim()) {
    manifest.brief = true;
    if (!skipParts.includes('RULES')) add('BRIEF', '.ai/BRIEF.md (replaces RULES + ARCHITECTURE)', brief, maxChars * SHARES.BRIEF);
  } else {
    const rules = readPreferBrief(project, 'RULES'), arch = readPreferBrief(project, 'ARCHITECTURE');
    if (!skipParts.includes('RULES')) add('RULES', `.ai/${rules.source}`, rules.body, maxChars * SHARES.RULES);        // skipParts: chat de-duplicates project-level parts across several mentions
    if (!skipParts.includes('ARCHITECTURE')) add('ARCHITECTURE', arch.source, arch.body, maxChars * SHARES.ARCHITECTURE);
  }

  const mapMd = servicesMdEffective(project, services);
  const active = services.filter((s) => !s.archived);
  let mapBody = '';
  if (service) {
    const sec = sectionFor(mapMd, service.name);
    mapBody = `Services in this project: ${active.map((s) => `${s.name} (${s.path})`).join('; ')}\n\nSelected service: ${service.name}\n` +
      (sec ? sec.text : `- Path: ${service.path}\n- ${service.description || ''}`);
  } else if (active.length) {
    mapBody = mapMd;
  }
  if (service) {
    try {
      const nb = require('./deps').neighbours(project, service);
      if (nb.uses.length || nb.usedBy.length) mapBody += `\n\nDependencies of ${service.name}: uses ${nb.uses.join(', ') || '-'}; used by ${nb.usedBy.join(', ') || '-'}`;
    } catch { /* deps are optional */ }
  }
  add('SERVICE MAP', service ? '.ai/SERVICES.md (selected service section)' : '.ai/SERVICES.md', mapBody, maxChars * SHARES.SERVICE_MAP);
  if (service) {
    const bf = `services/${service.name}.brief.md`;
    const sb = SVC_FILE_RE.test(bf) ? read(project, bf) : null;
    if (sb && sb.trim()) add(`SERVICE BRIEF: ${service.name}`, `.ai/${bf}`, sb, maxChars * SHARES.SERVICE_BRIEF);
    else add(`SERVICE NOTES: ${service.name}`, `.ai/services/${service.name}.md`, SVC_FILE_RE.test(`services/${service.name}.md`) ? read(project, `services/${service.name}.md`) : null, maxChars * SHARES.SERVICE_NOTES);
  }

  const memDoc = skipParts.includes('MEMORY') ? { body: null, source: 'MEMORY.md' } : readPreferBrief(project, 'MEMORY');
  const mem = memDoc.body;
  if (mem && mem.trim()) {
    const m = memoryRelevant(mem, `${taskText} ${service ? service.name + ' ' + service.description : ''}`, Math.max(300, left - 120));
    if (m.text.trim()) {
      parts.push(`## MEMORY (shared project notes${m.truncated ? `; ${m.picked}/${m.entries} entries selected by relevance` : ''})\n${m.text}`);
      manifest.parts.push({ name: 'MEMORY', source: `.ai/${memDoc.source}`, chars: m.text.length, truncated: m.truncated, entries: m.entries, picked: m.picked });
    }
  }
  // extraParts: [{ title, source, body, share }] injected by callers (e.g. the cross-repo feature contract); placed last, each capped to its share of the budget
  for (const x of extraParts) add(String(x.title), String(x.source || ''), String(x.body || ''), maxChars * (x.share || SHARES.EXTRA));
  const header = `# PROJECT CONTEXT (shared by every engine; read-only reference; follow RULES)\nProject: ${project.name}${service ? ` | Service: ${service.name} | Working root: ${service.path}` : ''}\n`;
  const text = parts.length ? `${header}\n${parts.join('\n\n')}\n` : '';
  manifest.total_chars = text.length;
  return { text, manifest };
}

// ---- export (never touches main)
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-') + '-' + require('node:crypto').randomBytes(2).toString('hex');

/** Commit the managed copy to .ai/ on a NEW branch from the default branch. Returns {changed, branch?, head_sha?, files?}. */
async function exportToRepo(project) {
  const a = aiDir(project);
  if (!a.export) throw new Error('.ai/ export is disabled for this project (opt-in: set config.ai_dir {service_id, export:true})');
  if (!a.target) throw new Error(a.problem || 'no service chosen for the .ai/ export (config.ai_dir.service_id)');
  const files = managedFiles(project);
  if (!files.length) return { changed: false, message: 'no managed context files to export' };
  const { service, repoRoot, defaultBranch: base } = a.target;
  const ts = stamp();
  const branch = `ai/context-update-${ts}`;
  const wt = path.join(cfg.WORKTREES, project.slug || project.name, service.name, `ctx-export-${ts}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = await git(repoRoot, ['worktree', 'add', '-b', branch, wt, base]);
  if (add.code !== 0) throw new Error(`worktree add failed: ${(add.err || add.error).trim().slice(0, 300)}`);
  const cleanup = async (deleteBranch) => {
    await git(repoRoot, ['worktree', 'remove', '--force', wt]);
    if (deleteBranch) await git(repoRoot, ['branch', '-D', branch]);
  };
  try {
    for (const f of files) {
      const dest = path.join(wt, '.ai', f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs(project, f), dest);
    }
    await git(wt, ['add', '--', '.ai']);
    const staged = await git(wt, ['diff', '--cached', '--name-status']);
    if (!staged.out.trim()) { await cleanup(true); return { changed: false, message: `.ai/ on ${base} already matches the managed copy; nothing to export` }; }
    const c = await git(wt, [...GIT_ID, 'commit', '-q', '-m', `ai: update shared context (.ai/)\n\nExported from the local AI dev orchestrator managed copy. Not reviewed.`]);
    if (c.code !== 0) throw new Error(`commit failed: ${(c.err || c.error).trim().slice(0, 300)}`);
    const head = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
    await cleanup(false);
    return { changed: true, branch, head_sha: head, service_id: service.id, files: staged.out.trim().split('\n'), message: `committed ${files.length} file(s) on ${branch} (service ${service.name})` };
  } catch (e) {
    await cleanup(true);
    throw e;
  }
}

/** Append approved memory notes (markdown bullets) to the managed MEMORY.md. */
function appendMemory(project, { text, taskId, serviceName }) {
  const cur = read(project, 'MEMORY.md') ?? `# Project memory - ${project.name}\n\nDurable notes and decisions shared by all engines. Entries are added only after human approval.\n`;
  const date = new Date().toISOString().slice(0, 10);
  const head = `## ${date}${taskId ? ` - task #${taskId}` : ''}${serviceName ? ` (${serviceName})` : ''}`;
  const body = String(text).trim().split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/^[-*] /.test(l) ? l : `- ${l}`)).join('\n');
  write(project, 'MEMORY.md', `${cur.replace(/\s+$/, '')}\n\n${head}\n${body}\n`);
}

module.exports = {
  validFile, dirFor, aiDir, read, write, managedFiles, repoFiles, repoRead, ensureSeeded, importFromRepo, generateServicesMd, servicesMdEffective,
  sections, sectionFor, memoryRelevant, buildBundle, exportToRepo, appendMemory, TOP_FILES, GIT_ID, stamp, SHARES, BRIEF_FILES, readPreferBrief,
};

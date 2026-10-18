'use strict';
// Per-service Cursor rules (M4). Renders .cursor/rules/*.mdc (+ an AGENTS.md pointer) from the managed project context (RULES, ARCHITECTURE,
// MEMORY, service map/notes) and, ONLY after an explicit approval of an exact preview, commits them on a NEW review branch of the
// service's repo (throw-away worktree, same mechanism and identity as the .ai/ export). Properties:
//  - nothing is written anywhere without approve + the digest of the preview (a changed render or a moved base branch invalidates it),
//  - never the default branch / the main checkout: a new branch `ai/cursor-rules-<service>-<ts>` + a review task, merged only by a human,
//  - opt-in per service (project.config.cursor_rules.service_ids); preview/status are read-only and always available,
//  - idempotent: output is deterministic; only files carrying the generated-by marker are ever (re)written, a hand-written file at the same
//    path is reported and left alone; files are never deleted,
//  - authorized roots only (repo.assertUsable = realpath vs roots); symlinked ancestors (in the tree or on disk) are refused.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../config');
const store = require('./db');
const repo = require('./repo');
const context = require('./context');
const readerLib = require('./repo-reader');
const { git } = require('./proc');
const { bad, conflict } = require('./errors');

const MARKER = 'generated-by: local-ai-dev-orchestrator cursor-rules v1';
const MARKER_RE = /^<!--\s*generated-by:\s*local-ai-dev-orchestrator\b[^\n]*-->\s*$/m;
const hasMarker = (text) => MARKER_RE.test(String(text).slice(0, 2000));
const LIMITS = { file_bytes: 8192, always_tokens: 600, rules: 2400, architecture: 6000, memory: 5000, service: 5000 };
const DEST_RE = /^(?:AGENTS\.md|\.cursor\/rules\/[a-z0-9][a-z0-9._-]{0,100}\.mdc|(?:[A-Za-z0-9._@+-]+\/)+AGENTS\.md)$/;
const gitId = (k) => context.GIT_ID.map((x) => x.split('=').slice(1).join('=')).filter(Boolean)[k]; // 'AI Dev Orchestrator', 'ai-orchestrator@localhost' (the identity of every orchestrator-made commit)
const IDENT_ENV = { GIT_AUTHOR_NAME: gitId(0), GIT_AUTHOR_EMAIL: gitId(1), GIT_COMMITTER_NAME: gitId(0), GIT_COMMITTER_EMAIL: gitId(1) };
const tok = (n) => Math.ceil(n / 4); // ~4 chars per token (rule files are English/markdown)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

// ------------------------------------------------------------------ opt-in (stored in projects.config, no schema change)
const optedInIds = (project) => ((project.config && project.config.cursor_rules && project.config.cursor_rules.service_ids) || []).map(Number);
const optedIn = (project, service) => optedInIds(project).includes(service.id);
function setOptIn(project, service, enabled) {
  if (!service || service.project_id !== project.id) throw bad('service does not belong to this project');
  const ids = new Set(optedInIds(project));
  if (enabled) ids.add(service.id); else ids.delete(service.id);
  const config = { ...(project.config || {}), cursor_rules: { service_ids: [...ids].sort((a, b) => a - b) } };
  store.updateProject(project.id, { config });
  return optedIn(store.getProject(project.id), service);
}

// ------------------------------------------------------------------ frontmatter
const SAFE_GLOBS = /^[A-Za-z0-9_./*{},@+-]+$/;
function frontmatter({ description, globs = '', alwaysApply = false }) {
  const g = globs ? (SAFE_GLOBS.test(globs) ? globs : JSON.stringify(globs)) : '';
  return `---\ndescription: ${JSON.stringify(String(description).replace(/\s+/g, ' ').trim().slice(0, 200))}\nglobs:${g ? ` ${g}` : ''}\nalwaysApply: ${alwaysApply ? 'true' : 'false'}\n---\n`;
}
/** Minimal parser for the three keys Cursor reads. Returns {ok, data, body, error}. */
function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { ok: false, error: 'no frontmatter (file must start with ---)' };
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) return { ok: false, error: `bad frontmatter line: ${line.slice(0, 60)}` };
    let v = kv[2].trim();
    if (v === 'true' || v === 'false') v = v === 'true';
    else if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { return { ok: false, error: `bad quoted value for ${kv[1]}` }; } }
    data[kv[1]] = v;
  }
  return { ok: true, data, body: m[2] };
}
/** Lint one .mdc file: frontmatter keys/types, size, tokens. */
function lint(text, { generated = false } = {}) {
  const errors = [], warnings = [];
  const fm = parseFrontmatter(text);
  if (!fm.ok) return { ok: false, errors: [fm.error], warnings, tokens: tok(String(text).length), always: false };
  const d = fm.data;
  if (typeof d.description !== 'string' || !d.description.trim()) errors.push('description is required');
  if (typeof d.alwaysApply !== 'boolean') errors.push('alwaysApply must be true or false');
  if (d.globs !== undefined && typeof d.globs !== 'string') errors.push('globs must be a string');
  for (const k of Object.keys(d)) if (!['description', 'globs', 'alwaysApply'].includes(k)) warnings.push(`unknown frontmatter key '${k}'`);
  const bytes = Buffer.byteLength(String(text));
  if (bytes > LIMITS.file_bytes) errors.push(`file is ${bytes} bytes (max ${LIMITS.file_bytes})`);
  if (d.alwaysApply === true && d.globs) warnings.push('alwaysApply with globs: globs are ignored');
  if (d.alwaysApply !== true && !d.globs && !(typeof d.description === 'string' && d.description.trim())) warnings.push('neither alwaysApply, globs nor description: the rule can never load');
  if (generated && !hasMarker(text)) errors.push('generated file lacks the generated-by marker');
  return { ok: !errors.length, errors, warnings, tokens: tok(String(fm.body).length), always: d.alwaysApply === true };
}

// ------------------------------------------------------------------ rendering
function clipAt(text, n) {
  const t = String(text).trim();
  if (t.length <= n) return { text: t, truncated: false };
  const cut = t.slice(0, n);
  const keep = cut.slice(0, Math.max(cut.lastIndexOf('\n'), (n * 0.8) | 0)).trimEnd();
  return { text: `${keep}\n\n> (truncated to ${n} characters by the orchestrator; the full text stays in its managed project context)`, truncated: true };
}
/** Memory is chronological (newest last): keep the newest sections that fit. */
function memoryTail(md, n) {
  const secs = context.sections(md);
  if (secs.map((s) => s.text).join('\n\n').length <= n) return { text: secs.map((s) => s.text).join('\n\n'), truncated: false, kept: secs.length, total: secs.length };
  const keep = []; let used = 0;
  for (let i = secs.length - 1; i >= 0; i--) { if (used + secs[i].text.length + 2 > n && keep.length) break; keep.unshift(secs[i]); used += secs[i].text.length + 2; }
  const dropped = secs.length - keep.length;
  const body = clipAt(keep.map((s) => s.text).join('\n\n'), n);
  return { text: `> (${dropped} older entr${dropped === 1 ? 'y' : 'ies'} omitted by the orchestrator; showing the newest)\n\n${body.text}`, truncated: true, kept: keep.length, total: secs.length };
}
/** Strip things that must not land in a repo: the service map's local checkout path, secret-looking values, home directories. */
function scrub(text, acc) {
  let t = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*[-*]\s*Repo:\s/.test(l)).join('\n');
  const r = readerLib.redact(t); t = r.text; acc.redactions += r.count;
  t = t.replace(/\/(?:Users|home)\/[^/\s`'")]+/g, () => { acc.masked_paths++; return '~'; });
  return t.trim();
}
const marker = (project, source) => `<!-- ${MARKER} | project: ${String(project.name).replace(/-->/g, '')} | source: ${source} | edit in the orchestrator and regenerate; hand edits are overwritten on the next approved sync -->`;

function ruleFile(project, name, { description, globs = '', always = false, source, body }) {
  const content = `${frontmatter({ description, globs, alwaysApply: always })}\n${marker(project, source)}\n\n${body.trim()}\n`;
  return { dest: `.cursor/rules/${name}.mdc`, kind: 'rule', description, globs, always, source, content };
}

/** Pure render of one service's rule files. Returns {files, notes, warnings, stats}. Needs the managed context (read-only). */
function render(project, service, services) {
  const slug = fileSlug(project.slug || project.name), sub = readerLib.subdirOf(service);
  if (sub === null) throw bad(`service path '${service.path}' is invalid`);
  const acc = { redactions: 0, masked_paths: 0 };
  const notes = [], warnings = [], files = [];
  const rd = (f) => { try { return context.validFile(f) ? context.read(project, f) : null; } catch { return null; } };
  const globs = sub ? `${sub}/**` : '';

  const rules = rd('RULES.md');
  if (rules && rules.trim()) {
    const c = clipAt(scrub(rules, acc), LIMITS.rules);
    if (c.truncated) warnings.push(`RULES.md was cut to ${LIMITS.rules} characters to keep the always-applied rule small`);
    files.push(ruleFile(project, `${slug}-rules`, { description: `Project rules for ${project.name} (generated from RULES.md)`, always: true, source: 'RULES.md', body: `# ${project.name}: project rules\n\n${c.text}` }));
  } else notes.push('RULES.md is empty: no always-applied project rule is generated');

  const arch = rd('ARCHITECTURE.md');
  if (arch && arch.trim()) {
    const c = clipAt(scrub(arch, acc), LIMITS.architecture);
    if (c.truncated) warnings.push(`ARCHITECTURE.md was cut to ${LIMITS.architecture} characters`);
    files.push(ruleFile(project, `${slug}-architecture`, { description: `Architecture of ${project.name}: components, boundaries and data flow. Use when changing structure or touching several services.`, source: 'ARCHITECTURE.md', body: `# ${project.name}: architecture\n\n${c.text}` }));
  } else notes.push('ARCHITECTURE.md is empty: no architecture rule is generated');

  const mem = rd('MEMORY.md');
  if (mem && mem.trim()) {
    const m = memoryTail(scrub(mem, acc), LIMITS.memory);
    if (m.truncated) warnings.push(`MEMORY.md: ${m.kept}/${m.total} newest entries included`);
    files.push(ruleFile(project, `${slug}-memory`, { description: `Durable decisions and notes of ${project.name} (project memory). Use when a change may conflict with an earlier decision.`, source: 'MEMORY.md', body: `# ${project.name}: memory\n\n${m.text}` }));
  } else notes.push('MEMORY.md is empty: no memory rule is generated');

  // the service rule: its section of the service map, owner notes, dependencies, check command
  const map = context.servicesMdEffective(project, services);
  const sec = context.sectionFor(map, service.name);
  const parts = [];
  parts.push(`- Location: ${sub ? `\`${sub}/\` in this repository` : 'the repository root'}`);
  if (service.check_cmd || project.check_cmd) parts.push(`- Check command: \`${service.check_cmd || project.check_cmd}\``);
  try { const nb = require('./deps').neighbours(project, service); if (nb.uses.length || nb.usedBy.length) parts.push(`- Uses: ${nb.uses.join(', ') || '-'}; used by: ${nb.usedBy.join(', ') || '-'}`); } catch { /* deps are optional */ }
  if (sec) parts.push('', sec.text.replace(/^##\s+.*\n?/, '').trim());
  else if (service.description) parts.push(`- ${service.description}`);
  const sn = /^services\//.test(`services/${service.name}.md`) ? rd(`services/${service.name}.md`) : null;
  if (sn && sn.trim()) parts.push('', '## Service notes', '', sn.trim());
  if (service.notes && service.notes.trim()) parts.push('', '## Owner notes', '', service.notes.trim());
  const sbody = clipAt(scrub(parts.join('\n'), acc), LIMITS.service);
  if (sbody.truncated) warnings.push(`service section cut to ${LIMITS.service} characters`);
  files.push(ruleFile(project, `${slug}-service-${fileSlug(service.name)}`, { description: `${service.name} service of ${project.name}: purpose, location, dependencies and checks`, globs, source: 'service map', body: `# ${service.name} (${project.name})\n\n${sbody.text}` }));

  // AGENTS.md pointer (root or the service folder); written only if the target is absent or ours
  const list = files.map((f) => `- \`${f.dest}\`: ${f.description}`).join('\n');
  const agents = `${marker(project, 'orchestrator context')}\n\n# Working agreement: ${service.name} (${project.name})\n\n` +
    `- Rules, architecture notes and decisions for this project are in \`.cursor/rules/\`; read the relevant ones before larger changes:\n${list}\n` +
    `${service.check_cmd || project.check_cmd ? `- Run \`${service.check_cmd || project.check_cmd}\` once after your edits and fix only failures you caused.\n` : ''}` +
    '- Keep the diff small, match the existing style, and do not add dependencies without asking.\n';
  files.push({ dest: sub ? `${sub}/AGENTS.md` : 'AGENTS.md', kind: 'agents', description: 'Pointer to the generated rules (read by Cursor and other agents)', globs: '', always: false, source: 'orchestrator context', content: agents });

  for (const f of files) {
    if (!DEST_RE.test(f.dest)) throw bad(`internal: unsafe destination '${f.dest}'`);
    f.bytes = Buffer.byteLength(f.content);
    if (f.kind === 'rule') { const l = lint(f.content, { generated: true }); if (!l.ok) throw bad(`generated rule ${f.dest} failed lint: ${l.errors.join('; ')}`); f.tokens = l.tokens; }
    else f.tokens = tok(f.content.length);
  }
  const always = files.filter((f) => f.always).reduce((n, f) => n + f.tokens, 0);
  if (always > LIMITS.always_tokens) warnings.push(`always-applied rules are about ${always} tokens (budget ${LIMITS.always_tokens}); shorten RULES.md`);
  if (acc.redactions) warnings.push(`${acc.redactions} secret-looking value(s) were redacted from the generated text`);
  if (acc.masked_paths) notes.push(`${acc.masked_paths} home-directory path(s) were replaced by ~`);
  return { files, notes, warnings, stats: { always_tokens: always, redactions: acc.redactions, masked_paths: acc.masked_paths } };
}

// ------------------------------------------------------------------ line diff (small files only)
function lineDiff(oldText, newText, ctx = 3) {
  const A = oldText === null ? [] : String(oldText).split('\n'), B = String(newText).split('\n');
  if (A.length * B.length > 640000) return [{ t: '-', s: `(${A.length} lines)` }, { t: '+', s: `(${B.length} lines)` }];
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push({ t: ' ', s: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: '-', s: A[i++] }); else ops.push({ t: '+', s: B[j++] }); }
  while (i < n) ops.push({ t: '-', s: A[i++] }); while (j < m) ops.push({ t: '+', s: B[j++] });
  const show = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== ' ') for (let d = -ctx; d <= ctx; d++) if (ops[k + d]) show[k + d] = true; });
  const out = []; let gap = false;
  ops.forEach((o, k) => { if (show[k]) { if (gap && out.length) out.push({ t: '@', s: '...' }); gap = false; out.push(o); } else gap = true; });
  return out;
}

// ------------------------------------------------------------------ repo state (read-only git, pinned to the default-branch commit)
async function resolveBase(service) {
  let root;
  try { root = repo.assertUsable(service); } catch (e) { throw conflict(e.message.replace(/ - authorize the root.*$/, '')); }
  const branch = service.default_branch || 'main';
  const r = await git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  if (r.code !== 0) throw conflict(`branch '${branch}' not found in ${root}`);
  return { root, branch, sha: r.out.trim() };
}
async function entryOf(root, rev, p) {
  const r = await git(root, ['ls-tree', rev, '--', p]);
  const line = r.code === 0 ? r.out.split('\n').find(Boolean) : null;
  const m = line && line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/);
  return m ? { mode: m[1], type: m[2], oid: m[3] } : null;
}
const showAt = async (root, rev, p) => { const r = await git(root, ['show', `${rev}:${p}`]); return r.code === 0 ? r.out : null; };
/** An ancestor of dest that is a symlink/file/submodule in the tree cannot be written through. */
async function badAncestor(root, rev, dest) {
  const parts = dest.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const a = parts.slice(0, i).join('/'), e = await entryOf(root, rev, a);
    if (e && (e.type !== 'tree' || e.mode === '120000')) return a;
  }
  return null;
}
async function pendingBranches(root, baseSha, service) {
  const r = await git(root, ['branch', '--no-merged', baseSha, '--list', 'ai/cursor-rules-*']);
  if (r.code !== 0) return [];
  const re = new RegExp(`^ai/cursor-rules-${fileSlug(service.name)}-\\d{8}-\\d{6}-[0-9a-f]{4}$`);
  return r.out.split('\n').map((l) => l.replace(/^[*+\s]+/, '').trim()).filter((b) => re.test(b)).slice(-10);
}

/** Full read-only preview: rendered files + their state against the default branch + diffs + digest. */
async function preview(project, service) {
  if (service.project_id !== project.id) throw bad('service does not belong to this project');
  await context.ensureSeeded(project);
  const base = await resolveBase(service);
  const services = store.listServices(project.id);
  const r = render(project, service, services);
  const files = [];
  for (const f of r.files) {
    const out = { dest: f.dest, kind: f.kind, description: f.description, globs: f.globs, always: f.always, tokens: f.tokens, bytes: f.bytes, content: f.content, state: 'new', note: '', diff: null };
    const bad = await badAncestor(base.root, base.sha, f.dest);
    const e = bad ? null : await entryOf(base.root, base.sha, f.dest);
    if (bad) { out.state = 'blocked'; out.note = `'${bad}' is a symlink or not a directory in ${base.branch}; refusing to write through it`; }
    else if (e) {
      if (e.type !== 'blob' || e.mode === '120000' || e.mode === '160000') { out.state = 'hand_written'; out.note = 'exists as a symlink/non-file; left untouched'; }
      else {
        const cur = await showAt(base.root, base.sha, f.dest);
        if (cur === null || !hasMarker(cur)) { out.state = 'hand_written'; out.note = 'exists without the generated-by marker (hand-written); left untouched'; }
        else if (cur === f.content) { out.state = 'same'; }
        else { out.state = 'changed'; out.diff = lineDiff(cur, f.content); }
      }
    }
    if (out.state === 'new') out.diff = lineDiff(null, f.content);
    files.push(out);
  }
  // marked files of this project that the render no longer produces (never deleted, only reported)
  const orphans = [];
  const ls = await git(base.root, ['ls-tree', '--name-only', base.sha, '--', '.cursor/rules/']);
  const slug = fileSlug(project.slug || project.name);
  for (const p of ls.code === 0 ? ls.out.split('\n').filter(Boolean) : []) {
    if (!p.startsWith(`.cursor/rules/${slug}-`) || !DEST_RE.test(p) || r.files.some((f) => f.dest === p)) continue;
    const cur = await showAt(base.root, base.sha, p);
    if (cur && hasMarker(cur)) orphans.push(p);
  }
  const writable = files.filter((f) => f.state === 'new' || f.state === 'changed');
  const blocked = files.filter((f) => f.state === 'blocked');
  const anyOurs = files.some((f) => f.state === 'same' || f.state === 'changed');
  const status = blocked.length ? 'blocked' : !writable.length ? 'in_sync' : anyOurs ? 'stale' : 'not_generated';
  const pending = await pendingBranches(base.root, base.sha, service);
  const digest = sha(JSON.stringify({ sha: base.sha, service: service.id, files: files.map((f) => [f.dest, f.state, sha(f.content)]) })).slice(0, 32);
  return {
    service: { id: service.id, name: service.name, path: service.path }, enabled: optedIn(project, service), status,
    base: { branch: base.branch, sha: base.sha.slice(0, 12), full: base.sha }, files, orphans, pending_branches: pending, digest,
    notes: [...r.notes, ...(orphans.length ? [`${orphans.length} generated file(s) are no longer produced and stay in the repo (never deleted): ${orphans.join(', ')}`] : [])],
    warnings: r.warnings, stats: r.stats,
    commit_identity: context.GIT_ID[1].replace('user.name=', '') + ' <' + context.GIT_ID[3].replace('user.email=', '') + '>',
  };
}

/** Status of every active service of a project (cheap enough: a few git reads each). */
async function overview(project) {
  const out = [];
  for (const s of store.listServices(project.id)) {
    const row = { service_id: s.id, name: s.name, path: s.path, enabled: optedIn(project, s), status: 'unavailable', problem: null, pending_branches: [], base: null, files: 0 };
    try { const pv = await preview(project, s); Object.assign(row, { status: pv.status, pending_branches: pv.pending_branches, base: pv.base.branch + '@' + pv.base.sha, files: pv.files.filter((f) => f.state === 'new' || f.state === 'changed').length, warnings: pv.warnings.length }); }
    catch (e) { row.problem = e.message; }
    out.push(row);
  }
  return out;
}

// ------------------------------------------------------------------ write (approved only)
function safeWrite(root, rel, content) {
  if (!DEST_RE.test(rel)) throw bad(`refusing unsafe destination '${rel}'`);
  const parts = rel.split('/'); let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const last = i === parts.length - 1;
    let st = null; try { st = fs.lstatSync(cur); } catch { /* absent */ }
    if (st) {
      if (st.isSymbolicLink()) throw conflict(`refusing to write through a symlink: ${parts.slice(0, i + 1).join('/')}`);
      if (last ? !st.isFile() : !st.isDirectory()) throw conflict(`unexpected file type at ${parts.slice(0, i + 1).join('/')}`);
    } else if (!last) fs.mkdirSync(cur);
  }
  const rr = fs.realpathSync.native(root), rp = fs.realpathSync.native(path.dirname(cur));
  if (rp !== rr && !rp.startsWith(rr + path.sep)) throw conflict(`destination resolves outside the worktree: ${rel}`);
  const tmp = `${cur}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, cur);
}

/**
 * Commit the previewed files on a NEW branch. Requires {approve:true, digest} (the digest of the preview the human looked at),
 * the service to be opted in, and the render + base commit to be unchanged since. Returns {changed, branch?, head_sha?, files?, service_id}.
 */
async function generateOnBranch(project, service, { approve, digest } = {}) {
  if (service.project_id !== project.id) throw bad('service does not belong to this project');
  if (approve !== true) throw bad('approval required: preview the files, then approve explicitly (approve: true, digest from the preview)');
  if (typeof digest !== 'string' || !digest) throw bad('digest of the approved preview is required');
  if (!optedIn(project, service)) throw conflict(`Cursor rules are not enabled for service '${service.name}' (opt-in per service)`);
  const pv = await preview(project, service);
  if (pv.digest !== digest) throw conflict('the preview is out of date (rules, services or the default branch changed); preview again and approve the new files');
  if (pv.files.some((f) => f.state === 'blocked')) throw conflict(pv.files.find((f) => f.state === 'blocked').note);
  const todo = pv.files.filter((f) => f.state === 'new' || f.state === 'changed');
  if (!todo.length) return { changed: false, service_id: service.id, message: `Cursor rules of '${service.name}' on ${pv.base.branch} are already in sync; nothing to do`, skipped: pv.files.filter((f) => f.state === 'hand_written').map((f) => f.dest) };
  const root = repo.assertUsable(service);
  for (const b of pv.pending_branches) { // a review branch with exactly this content is already waiting
    let same = true;
    for (const f of todo) if ((await showAt(root, b, f.dest)) !== f.content) { same = false; break; }
    if (same) return { changed: false, service_id: service.id, existing_branch: b, message: `branch ${b} with exactly these files is already waiting for review` };
  }
  const ts = context.stamp(), branch = `ai/cursor-rules-${fileSlug(service.name)}-${ts}`;
  const wt = path.join(cfg.WORKTREES, project.slug || project.name, service.name, `rules-${ts}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = await git(root, ['worktree', 'add', '-b', branch, wt, pv.base.full]);
  if (add.code !== 0) throw new Error(`worktree add failed: ${(add.err || add.error).trim().slice(0, 300)}`);
  const cleanup = async (deleteBranch) => { await git(root, ['worktree', 'remove', '--force', wt]); if (deleteBranch) await git(root, ['branch', '-D', branch]); };
  try {
    for (const f of todo) safeWrite(wt, f.dest, f.content);
    await git(wt, ['add', '--', ...todo.map((f) => f.dest)]);
    const staged = await git(wt, ['diff', '--cached', '--name-status']);
    if (!staged.out.trim()) { await cleanup(true); return { changed: false, service_id: service.id, message: 'nothing to commit' }; }
    const msg = `cursor rules: ${todo.some((f) => f.state === 'changed') ? 'update' : 'add'} rules for ${service.name}\n\nGenerated by the local AI dev orchestrator from the project RULES/ARCHITECTURE/MEMORY and the service map.\nOnly files carrying the generated-by marker are ever rewritten. Not reviewed.`;
    const c = await git(wt, [...context.GIT_ID, 'commit', '-q', '-m', msg], { env: IDENT_ENV }); // env wins over -c: an ambient GIT_AUTHOR_* of the server process can never change the author
    if (c.code !== 0) throw new Error(`commit failed: ${(c.err || c.error).trim().slice(0, 300)}`);
    const head = (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
    await cleanup(false);
    return { changed: true, branch, head_sha: head, service_id: service.id, base: pv.base.branch, files: staged.out.trim().split('\n'), message: `committed ${todo.length} file(s) on ${branch} (service ${service.name}, from ${pv.base.branch}@${pv.base.sha})` };
  } catch (e) { await cleanup(true); throw e; }
}

module.exports = { render, preview, overview, generateOnBranch, setOptIn, optedIn, lint, parseFrontmatter, frontmatter, hasMarker, lineDiff, LIMITS, MARKER, DEST_RE, _safeWrite: safeWrite };

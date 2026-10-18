'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const store = require('./lib/db');
const runner = require('./lib/runner');
const { taskDiff, mergeTask, mergePreflight, removeWorktree } = require('./lib/git-ops');
const projects = require('./lib/projects');
const cursor = require('./lib/cursor');
const { git } = require('./lib/proc');
const repo = require('./lib/repo');
const context = require('./lib/context');
const cursorRules = require('./lib/cursor-rules');
const deps = require('./lib/deps');
const serviceOps = require('./lib/service-ops');
const importer = require('./lib/importer');
const jobs = require('./lib/jobs');
const roots = require('./lib/roots');
const svc = require('./lib/services');
const router = require('./lib/router');
const memory = require('./lib/memory');
const settingsLib = require('./lib/settings');
const opener = require('./lib/open');
const models = require('./lib/models');
const registry = require('./lib/registry');
const chat = require('./lib/chat');
const features = require('./lib/features');

const ALLOWED_HOSTS = new Set([`127.0.0.1:${cfg.PORT}`, `localhost:${cfg.PORT}`]);

// ---------- helpers ----------
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const fail = (res, code, message, extra) => sendJson(res, code, { error: message, ...(extra || {}) });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]=,]{0,120}$/;
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

function validModel(m, label) {
  const model = String(m).trim();
  if (!MODEL_RE.test(model)) return { error: `invalid ${label} '${model}'` };
  const known = cursor.cachedModelIds();
  if (known && !known.includes(model.split('[')[0])) return { error: `unknown cursor ${label} '${model}' (see GET /api/cursor/models)` };
  return { model };
}

function validateTask(b) {
  const title = String(b.title ?? '').trim();
  const prompt = String(b.prompt ?? '').trim();
  if (!title || title.length > 200) return { error: 'title required (max 200 chars)' };
  if (!prompt || prompt.length > 20000) return { error: 'prompt required (max 20000 chars)' };
  let files = b.files ?? [];
  if (typeof files === 'string') files = files.split(/[\n,]+/);
  if (!Array.isArray(files)) return { error: 'files must be an array or comma/newline separated string' };
  files = [...new Set(files.map((f) => String(f).trim()).filter(Boolean))];
  if (files.length > 20) return { error: 'too many files (max 20)' };
  for (const f of files) {
    const n = path.posix.normalize(f);
    if (path.isAbsolute(f) || n.startsWith('..') || n.startsWith('-') || f.includes('\0')) return { error: `invalid file path: ${f} (must be repo-relative)` };
  }
  const check_cmd = b.check_cmd ? String(b.check_cmd).trim() : null;
  if (check_cmd && check_cmd.length > 1000) return { error: 'check_cmd too long' };

  // project
  let project;
  if (b.project_id === undefined || b.project_id === null || b.project_id === '') {
    const active = store.listProjects();
    if (active.length !== 1) return { error: 'project_id required (there are ' + active.length + ' active projects)' };
    project = active[0];
  } else {
    project = store.getProject(Number(b.project_id));
    if (!project) return { error: `project ${b.project_id} not found` };
  }
  if (project.archived) return { error: `project '${project.name}' is archived`, status: 409 };

  // service (REQUIRED: a project owns no repo, a task runs inside exactly one service): <id> | auto (router decides within the project)
  // convenience: omitting it is accepted only when the project has exactly one active service
  let service_id = null, routeService = false;
  const sv = b.service_id === undefined || b.service_id === null ? '' : String(b.service_id).trim();
  const activeSvcs = store.listServices(project.id);
  if (sv === 'auto') {
    if (!activeSvcs.length) return { error: `project '${project.name}' has no services; add a service first` };
    routeService = true;
  } else if (sv && sv !== 'none') {
    const s = store.getService(Number(sv));
    if (!s || s.project_id !== project.id) return { error: `service ${sv} not found in project '${project.name}'` };
    if (s.archived) return { error: `service '${s.name}' is archived`, status: 409 };
    service_id = s.id;
  } else if (sv === 'none') {
    return { error: "a task needs a service (the repo it runs in); 'none' is no longer supported - choose a service or 'auto'" };
  } else if (activeSvcs.length === 1) service_id = activeSvcs[0].id;
  else return { error: activeSvcs.length ? `service_id required (project '${project.name}' has ${activeSvcs.length} services; pass service_id or 'auto')` : `project '${project.name}' has no services; add a service first` };
  // engine / model / flags ('auto-route' = the router suggests the engine; the effective engine starts as the project's default)
  const routeEngine = b.engine === 'auto-route';
  const engine = b.engine === undefined || b.engine === '' || routeEngine ? project.engine : b.engine;
  if (!store.ENGINES.includes(engine)) return { error: `engine must be one of ${store.ENGINES.join(', ')}, or auto-route` };
  let model = null;
  if (engine !== 'local') {
    const m = validModel(b.model === undefined || b.model === '' ? cfg.CURSOR_MODEL : b.model, 'model');
    if (m.error) return m;
    model = m.model;
  }
  const allow_escalation = truthy(b.allow_escalation);
  if (allow_escalation && engine !== 'auto') return { error: 'allow_escalation only applies to engine=auto' };
  const ai_review = truthy(b.ai_review);
  let review_model = null;
  if (ai_review) {
    const m = validModel(b.review_model === undefined || b.review_model === '' ? cfg.CURSOR_REVIEW_MODEL : b.review_model, 'review_model');
    if (m.error) return m;
    review_model = m.model;
  }
  const plan_first = truthy(b.plan_first);
  if (plan_first && engine !== 'cursor' && !routeEngine) return { error: 'plan_first only applies to engine=cursor' };
  const route_requested = routeService || routeEngine;
  let attachments = [];
  if (b.attachments != null) {
    if (!Array.isArray(b.attachments) || b.attachments.length > 20) return { error: 'attachments must be an array of at most 20 items' };
    const cloud = engine !== 'local';
    for (const raw of b.attachments) {
      const id = Number(raw && typeof raw === 'object' ? raw.id : raw);
      const toCloud = !!(raw && typeof raw === 'object' && raw.to_cloud);
      if (!Number.isInteger(id) || id < 1) return { error: 'bad attachment id' };
      if (!store.attGet(id)) return { error: `attachment ${id} not found`, status: 404 };
      if (toCloud && !cloud) return { error: 'to_cloud applies only when the engine is not local' };
      if (!attachments.some((a) => a.id === id)) attachments.push({ id, toCloud: cloud && toCloud });
    }
  }
  return { project_id: project.id, title, prompt, files: files.map((f) => path.posix.normalize(f)), check_cmd, engine, model, allow_escalation, ai_review, review_model,
    service_id, plan_first: plan_first && engine === 'cursor', route_requested, route_request: { service: routeService, engine: routeEngine }, routing_source: route_requested ? null : 'manual', attachments };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(cfg.PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(cfg.PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// ---------- SSE ----------
function stream(req, res, task) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  let last = Number(req.headers['last-event-id']) || Number(new URL(req.url, 'http://x').searchParams.get('after')) || 0;
  let lastStatus = null, closed = false;
  res.write('retry: 2000\n\n');
  const push = () => {
    if (closed) return;
    try {
      for (;;) {
        const rows = store.eventsAfter(task.id, last, 500);
        for (const r of rows) { res.write(`id: ${r.id}\nevent: log\ndata: ${JSON.stringify(r)}\n\n`); last = r.id; }
        if (rows.length < 500) break;
      }
      const t = store.getTask(task.id);
      if (t && t.status !== lastStatus) { lastStatus = t.status; res.write(`event: status\ndata: ${JSON.stringify({ status: t.status, result_summary: t.result_summary })}\n\n`); }
    } catch { /* connection gone */ }
  };
  push();
  const iv = setInterval(push, 500);
  const hb = setInterval(() => { if (!closed) res.write(': hb\n\n'); }, 15000);
  req.on('close', () => { closed = true; clearInterval(iv); clearInterval(hb); });
}

// ---------- API ----------
const usageView = () => store.cursorUsageToday(); // counters only (no cap): used/tasks/plans/reviews/sessions (today) + today/total buckets

async function projectsApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/projects(?:\/(inspect|add|create|\d+)(?:\/(archive|unarchive|update|delete))?)?$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  const [, seg, action] = m;
  if (!seg) {
    if (req.method === 'GET') return sendJson(res, 200, store.listProjects({ includeArchived: url.searchParams.get('archived') === '1' }).map(projects.projectView));
    if (req.method === 'POST') { // logical project (no path); a body WITH `path` is the legacy "add existing repo" alias
      const body = await readJson(req);
      if (body.path !== undefined) return sendJson(res, 201, await projects.addExisting(body));
      return sendJson(res, 201, { project: projects.createLogical(body) });
    }
    return fail(res, 405, 'method not allowed');
  }
  if (seg === 'inspect' || seg === 'add' || seg === 'create') {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    const body = await readJson(req);
    if (seg === 'inspect') return sendJson(res, 200, await projects.inspectPath(body.path));
    if (seg === 'add') return sendJson(res, 201, await projects.addExisting(body));
    return sendJson(res, 201, await projects.createNew(body));
  }
  const id = Number(seg);
  const project = store.getProject(id);
  if (!project) return fail(res, 404, 'project not found');
  if (!action) {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, projects.projectView(project));
  }
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const body = await readJson(req);
  if (action === 'archive') {
    const active = store.activeTasksInProject(id);
    if (active.length) return fail(res, 409, `project has active tasks (${active.map((t) => `#${t.id} ${t.status}`).join(', ')}); finish or reject them first`);
    store.updateProject(id, { archived: true });
    return sendJson(res, 200, projects.projectView(store.getProject(id)));
  }
  if (action === 'delete') {
    const r = projects.deleteProject(project, body.confirm);
    return sendJson(res, 200, r);
  }
  if (action === 'unarchive') { store.updateProject(id, { archived: false }); return sendJson(res, 200, projects.projectView(store.getProject(id))); }
  // update: name, description, root_dir, check_cmd, install_cmd, engine, default_branch (legacy alias), settings, config
  const f = projects.logicalUpdate(project, body);
  if (body.check_cmd !== undefined) { const c = projects.checkCmdOf(body.check_cmd, 'check_cmd'); if (!c) return fail(res, 400, 'check_cmd cannot be empty'); f.check_cmd = c; }
  if (body.install_cmd !== undefined) f.install_cmd = projects.checkCmdOf(body.install_cmd, 'install_cmd');
  if (body.engine !== undefined) f.engine = projects.checkEngine(body.engine);
  let branchSvc = null;
  if (body.default_branch !== undefined) { // legacy alias: applies to the project's whole-repo service (use /api/services/:id/update for others)
    const home = repo.homeService(project);
    if (!home) return fail(res, 400, 'project has no service yet');
    const br = String(body.default_branch).trim();
    if (!br || br.startsWith('-') || (await git(repo.assertUsable(home), ['rev-parse', '--verify', '-q', `refs/heads/${br}^{commit}`])).code !== 0) return fail(res, 400, `branch '${br}' not found in ${home.local_path}`);
    branchSvc = { id: home.id, br };
  }
  if (body.config !== undefined) { const v = projects.validateConfig(body.config, project); if (v.error) return fail(res, 400, v.error); f.config = v.config; }
  if (body.settings !== undefined) { const v = settingsLib.validate(body.settings, project.settings || {}); if (v.error) return fail(res, 400, v.error); f.settings = v.settings; }
  if (!Object.keys(f).length && !branchSvc) return fail(res, 400, 'nothing to update (name, description, root_dir, check_cmd, install_cmd, engine, default_branch, settings, config)');
  if (branchSvc) store.updateService(branchSvc.id, { default_branch: branchSvc.br });
  if (Object.keys(f).length) store.updateProject(id, f);
  return sendJson(res, 200, projects.projectView(store.getProject(id)));
}


/** Register a branch the orchestrator committed on its own (context export, Cursor rules) as a review task; it is merged only by a human approve-merge. */
function registerReviewTask(project, r, { title, kind, what, summary, note }) {
  const id = store.createTask({ project_id: project.id, title, prompt: `${what}\nBranch: ${r.branch}\nFiles:\n${r.files.join('\n')}\n\nReview the diff, then approve & merge like any task (it is never merged automatically).`, files: [], engine: 'local', routing_source: 'manual', service_id: r.service_id });
  store.updateFields(id, { branch: r.branch, head_sha: r.head_sha, engine_used: kind, result_summary: summary });
  store.transition(id, 'pending', 'review');
  store.addEvent(id, 'git', note);
  return id;
}

// ---------- stage 4 APIs: services, context files, routing dry-run, memory proposals ----------
async function projectSubApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/projects\/(\d+)\/(services|context|route|groups|deps|cursor-rules)(?:\/([a-z-]+))?$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  const project = store.getProject(Number(m[1]));
  if (!project) return fail(res, 404, 'project not found');
  const [, , area, sub] = m;
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return fail(res, 405, 'method not allowed');
  const body = isGet ? {} : await readJson(req);

  if (area === 'services') {
    if (isGet && !sub) return sendJson(res, 200, svc.list(project, { includeArchived: url.searchParams.get('archived') === '1' }));
    if (isGet && sub === 'detect') { const home = svc.homeOf(project); return sendJson(res, 200, { suggestions: await svc.detect(project, home), note: `from the committed layout of ${home.default_branch} in ${home.local_path}` }); }
    if (!isGet && !sub) { if (project.archived) return fail(res, 409, 'project is archived'); return sendJson(res, 201, svc.create(project, body)); }
    if (!isGet && sub === 'inspect') return sendJson(res, 200, await serviceOps.inspect(project, body));
    if (!isGet && sub === 'add-existing') return sendJson(res, 201, await serviceOps.addExisting(project, body));
    if (!isGet && sub === 'create') return sendJson(res, 201, await serviceOps.createNew(project, body));
    if (!isGet && sub === 'import') return sendJson(res, 202, importer.start(project, body));
    return fail(res, 404, 'unknown endpoint');
  }
  if (area === 'cursor-rules') { // M4: opt-in per service, read-only preview, explicit approve -> review branch
    const sid = Number(isGet ? url.searchParams.get('service_id') : body.service_id);
    const service = sid ? store.getService(sid) : null;
    if (!sub && isGet) return sendJson(res, 200, { project: project.name, services: await cursorRules.overview(project), limits: cursorRules.LIMITS, marker: cursorRules.MARKER });
    if (sub === 'preview' && isGet) {
      if (!service || service.project_id !== project.id) return fail(res, 404, 'service not found in this project');
      return sendJson(res, 200, await cursorRules.preview(project, service));
    }
    if (isGet || !sub) return fail(res, 404, 'unknown endpoint');
    if (project.archived) return fail(res, 409, 'project is archived');
    if (!service || service.project_id !== project.id) return fail(res, 404, 'service not found in this project');
    if (sub === 'optin') return sendJson(res, 200, { ok: true, service_id: service.id, enabled: cursorRules.setOptIn(project, service, body.enabled === true) });
    if (sub === 'generate') {
      const r = await cursorRules.generateOnBranch(project, service, { approve: body.approve, digest: body.digest });
      if (!r.changed) return sendJson(res, 200, { ok: true, ...r });
      const id = registerReviewTask(project, r, { title: `Cursor rules: ${service.name} (${r.branch})`, kind: 'cursor-rules', what: `Generated Cursor rules (.cursor/rules/*.mdc, AGENTS.md pointer) for service '${service.name}' from the orchestrator's project context.\nOnly files carrying the generated-by marker are touched; hand-written files are left alone.`, summary: `cursor rules: ${r.message}`, note: `${r.message} (${r.head_sha.slice(0, 7)}); not merged - review it and approve-merge` });
      return sendJson(res, 201, { ok: true, ...r, task: store.getTask(id) });
    }
    return fail(res, 404, 'unknown endpoint');
  }
  if (area === 'deps') {
    if (sub) return fail(res, 404, 'unknown endpoint');
    if (isGet) return sendJson(res, 200, deps.view(project));
    if (project.archived) return fail(res, 409, 'project is archived');
    const act = String(body.action ?? 'add');
    if (act === 'add') return sendJson(res, 201, deps.add(project, body));
    if (act === 'remove') return sendJson(res, 200, deps.remove(project, body));
    return fail(res, 400, "action must be 'add' or 'remove'");
  }
  if (area === 'groups') {
    if (isGet || sub) return fail(res, 404, 'use GET /api/groups?project_id=N or POST /api/projects/:id/groups');
    if (project.archived) return fail(res, 409, 'project is archived');
    const depGiven = !(body.dependency === undefined || body.dependency === '');
    if (depGiven && !['stack', 'merged', 'independent'].includes(body.dependency)) return fail(res, 400, "dependency must be 'stack', 'merged' or 'independent'");
    const title = String(body.title ?? '').trim();
    if (!title || title.length > 200) return fail(res, 400, 'title required (max 200 chars)');
    if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 8) return fail(res, 400, 'steps must be an array of 1..8 steps');
    const specs = [];
    for (let i = 0; i < body.steps.length; i++) {
      const b = { ...body.steps[i], project_id: project.id };
      if (b.engine === 'auto-route' || b.service_id === 'auto') return fail(res, 400, `step ${i + 1}: routing is not available inside sequences; choose the service/engine explicitly`);
      if (b.title === undefined || b.title === '') b.title = `${title} - step ${i + 1}`;
      const v = validateTask(b);
      if (v.error) return fail(res, v.status || 400, `step ${i + 1}: ${v.error}`);
      specs.push(v);
    }
    // multi-service rules: `stack` (build on the previous step's branch) only works inside ONE repo; steps in different repos are 'independent' (default) or 'merged'
    const repoKeys = new Set(specs.map((v) => { const sv = v.service_id ? store.getService(v.service_id) : null; return sv ? (repo.repoKeyOf(sv) || `svc:${sv.id}`) : 'none'; }));
    const crossRepo = repoKeys.size > 1;
    const dep = depGiven ? body.dependency : (crossRepo ? 'independent' : 'stack');
    if (dep === 'stack' && crossRepo) return fail(res, 400, "dependency 'stack' is only possible when all steps are in the same repository (a branch cannot be stacked across repos); use 'independent' (no ordering) or 'merged' (step N+1 waits until step N is merged)");
    const gid = store.createGroup({ project_id: project.id, title, dependency: dep });
    const ids = specs.map((v, i) => {
      const id = store.createTask({ ...v, group_id: gid, step_no: i + 1, route_requested: false, routing_source: 'manual' });
      store.addEvent(id, 'system', `task created as step ${i + 1}/${specs.length} of sequence #${gid} '${title}' (${dep === 'stack' ? 'stack: runs on top of the previous step\'s branch after it passed its checks' : dep === 'independent' ? 'independent: no ordering' + (crossRepo ? ', steps live in different repositories; each is reviewed and merged on its own' : '') : 'merged: waits until the previous step is merged'}); status pending, awaiting start approval`);
      return id;
    });
    return sendJson(res, 201, groupView(store.getGroup(gid)));
  }
  if (area === 'route') { // dry run of the router (no task, nothing stored)
    if (isGet) return fail(res, 405, 'POST only');
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return fail(res, 400, 'prompt required');
    const r = await router.computeRoute({ project, services: store.listServices(project.id), title: String(body.title ?? prompt.slice(0, 80)), prompt });
    return sendJson(res, 200, r);
  }
  // context
  if (isGet && !sub) {
    await context.ensureSeeded(project);
    const services = store.listServices(project.id);
    const names = [...context.TOP_FILES, ...services.map((s) => `services/${s.name}.md`).filter(context.validFile)];
    for (const f of context.managedFiles(project)) if (!names.includes(f)) names.push(f);
    const ai = context.aiDir(project);
    const repoSet = new Set(await context.repoFiles(project));
    const files = [];
    for (const name of names) {
      const content = context.read(project, name);
      let repo_state = 'missing_in_repo';
      if (repoSet.has(name)) { const rc = await context.repoRead(project, name); repo_state = content === null ? 'only_in_repo' : rc === content ? 'same' : 'differs'; }
      else if (content === null) repo_state = 'n/a';
      files.push({ name, exists: content !== null, content: content ?? '', repo_state });
    }
    const st = settingsLib.effective(project);
    return sendJson(res, 200, { project: project.name, dir: context.dirFor(project), files, services_draft: context.generateServicesMd(project, services), max_chars: st.context_max_chars, ai_dir: { service_id: ai.service_id, import: ai.import, export: ai.export, problem: ai.problem, branch: ai.target ? ai.target.defaultBranch : null } });
  }
  if (isGet) return fail(res, 404, 'unknown endpoint');
  if (project.archived && sub !== 'preview') return fail(res, 409, 'project is archived');
  switch (sub) {
    case 'save': {
      const file = String(body.file ?? '');
      if (!context.validFile(file)) return fail(res, 400, 'file must be RULES.md, SERVICES.md, MEMORY.md, ARCHITECTURE.md or services/<name>.md');
      try { context.write(project, file, body.content); } catch (e) { return fail(res, 400, e.message); }
      return sendJson(res, 200, { ok: true, file, note: 'saved to the managed copy; the repo .ai/ is unchanged until you export it and merge the review task' });
    }
    case 'import': {
      const ai = context.aiDir(project);
      if (!ai.import || !ai.target) return fail(res, 409, ai.problem || '.ai/ import is disabled for this project (opt-in: set config.ai_dir {service_id, import:true})');
      const done = await context.importFromRepo(project);
      return sendJson(res, 200, { ok: true, imported: done, note: done.length ? `overwrote managed copy of ${done.length} file(s) from ${ai.target.defaultBranch}:.ai/ of service ${ai.target.service.name}` : `no .ai/ files on ${ai.target.defaultBranch}` });
    }
    case 'export': {
      let r;
      { const ai = context.aiDir(project); if (!ai.export || !ai.target) return fail(res, 409, ai.problem || '.ai/ export is disabled for this project (opt-in: set config.ai_dir {service_id, export:true})'); }
      try { r = await context.exportToRepo(project); } catch (e) { return fail(res, 500, `export failed: ${e.message}`); }
      if (!r.changed) return sendJson(res, 200, { ok: true, changed: false, message: r.message });
      const id = registerReviewTask(project, r, { title: `Context update: .ai/ export (${r.branch})`, kind: 'export', what: 'Export of the orchestrator-managed project context to .ai/ in the repo.', summary: `context export: ${r.message}`, note: `${r.message} (${r.head_sha.slice(0, 7)}); not merged - review it and approve-merge` });
      return sendJson(res, 201, { ok: true, changed: true, task: store.getTask(id), branch: r.branch });
    }
    case 'preview': {
      await context.ensureSeeded(project);
      const service = body.service_id ? store.getService(Number(body.service_id)) : null;
      const st = settingsLib.effective(project);
      return sendJson(res, 200, context.buildBundle({ project, service, services: store.listServices(project.id), taskText: String(body.prompt ?? ''), maxChars: st.context_max_chars }));
    }
    default: return fail(res, 404, 'unknown endpoint');
  }
}

async function serviceApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/services\/(\d+)\/(update|archive|unarchive|remove|status|detect)$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  const service = store.getService(Number(m[1]));
  if (!service) return fail(res, 404, 'service not found');
  const project = store.getProject(service.project_id);
  if (m[2] === 'status' || m[2] === 'detect') {
    if (req.method !== 'GET') return fail(res, 405, 'GET only');
    if (m[2] === 'status') return sendJson(res, 200, await serviceOps.status(service));
    return sendJson(res, 200, { suggestions: await svc.detect(project, service), note: `from the committed layout of ${service.default_branch} in ${service.local_path}` });
  }
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const body = await readJson(req);
  if (m[2] === 'update') {
    if (body.default_branch !== undefined) {
      const br = String(body.default_branch).trim();
      if (!br || br.startsWith('-') || (await git(repo.assertUsable(service), ['rev-parse', '--verify', '-q', `refs/heads/${br}^{commit}`])).code !== 0) return fail(res, 400, `branch '${br}' not found in ${service.local_path}`);
      body.default_branch = br;
    }
    return sendJson(res, 200, svc.serviceView(project, serviceOps.update(project, service, body)));
  }
  if (m[2] === 'remove') {
    if (body.confirm !== service.name) return fail(res, 400, `confirmation required: send {"confirm": "${service.name}"} (unregisters the service; files stay untouched)`);
    return sendJson(res, 200, serviceOps.unregister(service));
  }
  if (m[2] === 'archive') {
    const used = store.listTasks(project.id).filter((t) => t.service_id === service.id && ['pending', 'approved', 'running', 'checking', 'awaiting_escalation', 'awaiting_plan'].includes(t.status));
    if (used.length) return fail(res, 409, `service is used by open tasks (${used.map((t) => '#' + t.id).join(', ')}); finish them first`);
  }
  store.updateService(service.id, { archived: m[2] === 'archive' });
  return sendJson(res, 200, svc.serviceView(project, store.getService(service.id)));
}

chat.setContextProvider(require('./lib/chat-context').provider); // @project / @service mentions (read-only context)
const chatApi = require('./lib/chat-api')({ sendJson, fail, readJson });
const attachments = require('./lib/attachments');
const attachmentsApi = require('./lib/attachments-api').createAttachmentsApi({ sendJson, fail, readJson });
const featuresApi = require('./lib/features-api')({ sendJson, fail, readJson, validateTask, mergePlan: (g) => mergePlan(g) });

async function memoryApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/memory-proposals(?:\/(\d+)\/(update|approve|reject))?$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  if (!m[1]) {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, store.listProposals({ projectId: Number(url.searchParams.get('project_id')) || null, status: url.searchParams.get('status') || null }));
  }
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const p = store.getProposal(Number(m[1]));
  if (!p) return fail(res, 404, 'proposal not found');
  if (p.status !== 'pending') return fail(res, 409, `proposal is already ${p.status}`);
  const body = await readJson(req);
  if (m[2] === 'update') {
    const t = String(body.text ?? '').trim();
    if (!t || t.length > 4000) return fail(res, 400, 'text required (max 4000 chars)');
    store.setProposalText(p.id, t); return sendJson(res, 200, store.getProposal(p.id));
  }
  if (m[2] === 'reject') { store.decideProposal(p.id, 'rejected', String(body.reason ?? '').slice(0, 500)); if (p.task_id) store.addEvent(p.task_id, 'memory', `memory proposal #${p.id} REJECTED by human`); return sendJson(res, 200, store.getProposal(p.id)); }
  let final;
  try { final = memory.approve(p, { text: body.text }); } catch (e) { return fail(res, 400, e.message); }
  if (p.task_id) store.addEvent(p.task_id, 'memory', `memory proposal #${p.id} APPROVED by human and appended to the project MEMORY.md`);
  return sendJson(res, 200, { ...store.getProposal(p.id), appended: final });
}

/** Cursor CLI runs that ONE start approval of this task can cause (engine=auto starts local; escalation needs its own click and is not counted). */
const cursorRunsOnStart = (t) => (t.engine === 'cursor' ? 1 + (t.plan_first ? 1 : 0) : 0) + (t.ai_review ? 1 : 0);
const groupView = (g) => {
  if (!g) return g;
  const tasks = store.groupTasks(g.id);
  const keys = new Set(tasks.map((t) => { const sv = t.service_id ? store.getService(t.service_id) : null; return sv ? (repo.repoKeyOf(sv) || `svc:${sv.id}`) : 'none'; }));
  return { ...g, project_name: (store.getProject(g.project_id) || {}).name, repo_count: keys.size, cross_repo: keys.size > 1, steps: tasks.map((t) => ({
    id: t.id, step_no: t.step_no, title: t.title, status: t.status, service_id: t.service_id, service_name: t.service_name, engine: t.engine, branch: t.branch,
    base_ref: t.base_ref, supervised: t.supervised, result_summary: t.result_summary, plan_first: t.plan_first, ai_review: t.ai_review, cursor_runs_on_start: cursorRunsOnStart(t) })),
    cursor_runs_pending: tasks.filter((t) => t.status === 'pending').reduce((n, t) => n + cursorRunsOnStart(t), 0) };
};

/** Merge plan of a sequence: read-only pre-flight per step. NO atomic cross-repo merge exists: every task is merged with its own approval; a failure never reverts the others. */
async function mergePlan(group) {
  const steps = [];
  for (const t of store.groupTasks(group.id)) {
    const base = { task_id: t.id, step_no: t.step_no, title: t.title, status: t.status, service_id: t.service_id, service_name: t.service_name, branch: t.branch || null };
    if (t.status !== 'review') { steps.push({ ...base, mergeable: false, state: t.status === 'done' ? 'merged' : t.status, problem: t.status === 'done' ? null : `status is '${t.status}' (needs 'review')` }); continue; }
    const pf = await mergePreflight(t);
    steps.push({ ...base, repo: pf.repo, base_branch: pf.base || null, tip: pf.tip || null, mergeable: pf.ok, state: pf.ok ? 'ready' : 'blocked', problem: pf.ok ? null : pf.message });
  }
  const repos = {};
  for (const s of steps) if (s.repo) (repos[s.repo] = repos[s.repo] || []).push(s.task_id);
  return { group_id: group.id, title: group.title, dependency: group.dependency, cross_repo: Object.keys(repos).length > 1, repos: Object.entries(repos).map(([path, task_ids]) => ({ path, task_ids })), steps,
    all_ready: steps.length > 0 && steps.every((s) => s.mergeable || s.state === 'merged') && steps.some((s) => s.mergeable),
    note: 'There is no atomic cross-repository merge. Merge each task with its own approval (POST /api/tasks/:id/approve-merge); if one fails the others stay merged/reviewable and nothing is reverted automatically.' };
}

async function groupApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/groups(?:\/(\d+)(?:\/(approve-start|reject|merge-plan))?)?$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  if (!m[1]) {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, store.listGroups(Number(url.searchParams.get('project_id')) || null).map(groupView));
  }
  const group = store.getGroup(Number(m[1]));
  if (!group) return fail(res, 404, 'sequence not found');
  if (!m[2]) { if (req.method !== 'GET') return fail(res, 405, 'method not allowed'); return sendJson(res, 200, groupView(group)); }
  if (m[2] === 'merge-plan') { if (req.method !== 'GET') return fail(res, 405, 'GET only'); return sendJson(res, 200, await mergePlan(group)); }
  if (req.method !== 'POST') return fail(res, 405, 'POST only');
  const body = await readJson(req);
  const reason = String(body.reason ?? '').trim().slice(0, 2000);
  const project = store.getProject(group.project_id);
  const pending = store.groupTasks(group.id).filter((t) => t.status === 'pending');
  if (!pending.length) return fail(res, 409, 'no pending steps in this sequence');
  if (m[2] === 'reject') {
    if (!reason) return fail(res, 400, 'reason required');
    for (const t of pending) {
      store.transition(t.id, 'pending', 'rejected'); store.updateFields(t.id, { result_summary: `rejected before start (sequence #${group.id}): ${reason}` });
      store.addApproval(t.id, 'start', 'rejected', reason); store.addEvent(t.id, 'system', `start rejected with the whole sequence: ${reason}`);
    }
    return sendJson(res, 200, groupView(store.getGroup(group.id)));
  }
  if (project.archived) return fail(res, 409, `project '${project.name}' is archived`);
  // one approval for the whole sequence: validate every step first (caps/login), then approve all pending steps; the runner executes them in order
  const cursorSteps = pending.filter((t) => t.engine === 'cursor');
  if (cursorSteps.length) {
    const st = await cursor.getStatus();
    if (!st.installed || !st.logged_in) return fail(res, 409, `cursor CLI unavailable: ${st.error || 'not logged in'}`);
  }
  for (const t of pending) {
    if (!store.transition(t.id, 'pending', 'approved')) continue;
    store.addApproval(t.id, 'start', 'approved', `sequence #${group.id} start approved${reason ? ': ' + reason : ''}`);
    store.addEvent(t.id, 'system', `start approved by human with sequence #${group.id}; runs in step order (${group.dependency === 'stack' ? 'after the previous step passed its checks' : group.dependency === 'independent' ? 'no ordering between steps' : 'after the previous step is merged'})`);
  }
  return sendJson(res, 200, groupView(store.getGroup(group.id)));
}

async function api(req, res, url) {
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, schema: store.schemaVersion(), projects: store.listProjects().length, model: models.aiderModelArg(), cursor_usage: usageView() });
  if (url.pathname === '/api/config') {
    return sendJson(res, 200, {
      engines: store.ENGINES, local_model: models.aiderModelArg(), cursor_default_model: cfg.CURSOR_MODEL, cursor_review_model: cfg.CURSOR_REVIEW_MODEL,
      cursor_timeout_s: Math.round(cfg.CURSOR_TIMEOUT_MS / 1000),
      escalation_requires_approval: cfg.ESCALATION_REQUIRE_APPROVAL, projects_parent: cfg.PROJECTS_PARENT, home: cfg.HOME,
      max_parallel_cursor: cfg.MAX_PARALLEL_CURSOR, context_max_chars: cfg.CONTEXT_MAX_CHARS, router: { model: models.effective('routing').model, api: cfg.ROUTER_API, min_confidence: cfg.ROUTER_MIN_CONFIDENCE },
      routing_defaults: settingsLib.DEFAULTS(), empty_check: cfg.EMPTY_CHECK,
    });
  }
  if (url.pathname === '/api/fs/roots' || url.pathname === '/api/fs/check' || /^\/api\/fs\/roots\/\d+\/remove$/.test(url.pathname)) {
    if (url.pathname === '/api/fs/roots') {
      if (req.method === 'GET') return sendJson(res, 200, roots.list());
      if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
      const body = await readJson(req); // explicit human action: adding a root widens what the orchestrator may touch
      return sendJson(res, 201, roots.add(body.path, body.label));
    }
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    const body = await readJson(req);
    if (url.pathname === '/api/fs/check') return sendJson(res, 200, roots.check(body.path));
    return sendJson(res, 200, roots.remove(Number(url.pathname.split('/')[4])));
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') return sendJson(res, 200, jobs.list().map(jobs.view));
  const jm = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{16})(?:\/(cancel))?$/);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return fail(res, 404, 'job not found (jobs are kept for one hour and forgotten on restart)');
    if (!jm[2]) { if (req.method !== 'GET') return fail(res, 405, 'GET only'); return sendJson(res, 200, jobs.view(job)); }
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    return sendJson(res, 200, { cancelled: importer.cancelJob(job), job: jobs.view(job) });
  }
  if (url.pathname === '/api/ollama/status') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, await models.status());
  }
  if (url.pathname === '/api/ollama/models') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    const r = await models.installed({ fresh: url.searchParams.get('refresh') === '1' });
    return sendJson(res, r.ok ? 200 : 502, r.ok ? r : { error: r.message, code: r.code, models: [] });
  }
  if (url.pathname === '/api/ollama/catalog') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, await models.catalog());
  }
  if (/^\/api\/ollama\/models\/(verify|pull|delete)$/.test(url.pathname)) {
    if (req.method !== 'POST') return fail(res, 405, 'POST only');
    const body = await readJson(req);
    const act = url.pathname.split('/').pop();
    if (act === 'verify') { // read-only registry manifest GET (size of the download); never downloads anything
      const r = await registry.verify(String(body.name ?? ''), { fresh: body.fresh === true });
      return sendJson(res, r.ok ? 200 : r.code === 'invalid_name' ? 400 : 502, r.ok ? { ...r, fit: models.fitClass(r.weights_bytes), pull_enabled: cfg.ALLOW_MODEL_PULL } : { error: r.message, code: r.code });
    }
    if (act === 'pull') return sendJson(res, 202, await models.startPull(String(body.name ?? ''), { confirm_size_bytes: body.confirm_size_bytes }));
    return sendJson(res, 200, await models.deleteModel(String(body.name ?? ''), body.confirm));
  }
  if (url.pathname === '/api/models/default') {
    if (req.method === 'GET') return sendJson(res, 200, models.defaultModel());
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
    const body = await readJson(req);
    return sendJson(res, 200, await models.setDefault(body.model === undefined ? null : body.model));
  }
  if (/^\/api\/models\/roles(?:\/(validate|clear))?$/.test(url.pathname)) {
    const act = url.pathname.split('/')[4];
    if (req.method === 'GET' && !act) return sendJson(res, 200, { roles: models.listRoles(), note: 'coding, routing, memory, chat and the media roles have a local consumer; planning and review are stored for later' });
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed');
    const body = await readJson(req);
    const flags = { allowLargeCtx: body.allow_large_ctx === true };
    if (act === 'validate') return sendJson(res, 200, await models.validateRole(String(body.role ?? ''), body.model, body.options ?? {}, flags));
    if (act === 'clear') return sendJson(res, 200, models.clearRole(String(body.role ?? '')));
    return sendJson(res, 200, await models.setRole(String(body.role ?? ''), body.model, body.options ?? {}, flags));
  }
  if (url.pathname === '/api/cursor/status') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, { ...(await cursor.getStatus({ force: url.searchParams.get('refresh') === '1' })), usage: usageView(), runs_on: 'Cursor servers (uses Pro usage)' });
  }
  if (url.pathname === '/api/cursor/usage') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return sendJson(res, 200, store.cursorStats());
  }
  if (url.pathname === '/api/cursor/models') {
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    const r = await cursor.getModels({ force: url.searchParams.get('refresh') === '1' });
    return sendJson(res, r.ok ? 200 : 502, { ...r, default: cfg.CURSOR_MODEL });
  }
  if (url.pathname.startsWith('/api/projects/') && /^\/api\/projects\/\d+\/(services|context|route|groups|deps|cursor-rules)/.test(url.pathname)) return projectSubApi(req, res, url);
  if (url.pathname.startsWith('/api/groups')) return groupApi(req, res, url);
  if (url.pathname === '/api/features' || url.pathname.startsWith('/api/features/')) return featuresApi(req, res, url);
  if (url.pathname.startsWith('/api/services/')) return serviceApi(req, res, url);
  if (url.pathname.startsWith('/api/memory-proposals')) return memoryApi(req, res, url);
  if (url.pathname === '/api/attachments' || url.pathname.startsWith('/api/attachments/') || url.pathname === '/api/media/tools') return attachmentsApi(req, res, url);
  if (url.pathname.startsWith('/api/conversations') || url.pathname === '/api/llm/info' || url.pathname.startsWith('/api/mentions/')) return chatApi(req, res, url);
  if (url.pathname.startsWith('/api/projects')) return projectsApi(req, res, url);
  const m = url.pathname.match(/^\/api\/tasks(?:\/(\d+)(?:\/([a-z-]+))?)?$/);
  if (!m) return fail(res, 404, 'unknown endpoint');
  const [, idStr, action] = m;

  if (!idStr) {
    if (req.method === 'GET') return sendJson(res, 200, store.listTasks(Number(url.searchParams.get('project_id')) || null));
    if (req.method === 'POST') {
      const v = validateTask(await readJson(req));
      if (v.error) return fail(res, v.status || 400, v.error);
      const id = store.createTask(v);
      for (const a of v.attachments || []) {
        attachments.link(a.id, { taskId: id, toCloud: a.toCloud });
        await attachments.derive(a.id);
      }
      store.addEvent(id, 'system', `task created (status: pending, awaiting start approval; engine ${v.engine}${v.model ? ' model ' + v.model : ''}${v.allow_escalation ? ', escalation allowed' : ''}${v.ai_review ? ', ai_review' : ''}${v.service_id ? ', service #' + v.service_id : ''}${v.plan_first ? ', plan_first' : ''}${(v.attachments || []).length ? ', attachments ' + v.attachments.length : ''})`);
      if (v.route_requested) {
        store.updateFields(id, { routing_json: JSON.stringify({ request: v.route_request }) });
        store.addEvent(id, 'route', `routing requested (${[v.route_request.service && 'service=auto', v.route_request.engine && 'engine=auto-route'].filter(Boolean).join(', ')}); asking the local model ${models.effective('routing').model} (suggestion only; you confirm at approve-start)`);
        setImmediate(() => router.routeTask(id));
      }
      return sendJson(res, 201, store.getTask(id));
    }
    return fail(res, 405, 'method not allowed');
  }

  const id = Number(idStr);
  const task = store.getTask(id);
  if (!task) return fail(res, 404, 'task not found');
  const project = store.getProject(task.project_id);
  if (!project) return fail(res, 500, `project ${task.project_id} of this task is missing`);

  if (req.method === 'GET') {
    if (!action) {
      const links = store.attLinksForTask(id).map((l) => ({ id: l.attachment_id, name: l.orig_name, kind: l.kind, to_cloud: !!l.to_cloud }));
      const sent = task.engine !== 'local' && links.some((l) => l.to_cloud);
      return sendJson(res, 200, { ...task, approvals: store.approvals(id), memory_proposals: store.proposalsForTask(id), attachments: links, sent_to_cursor: sent });
    }
    if (action === 'events') return sendJson(res, 200, store.eventsAfter(id, Number(url.searchParams.get('after')) || 0, 5000));
    if (action === 'stream') return stream(req, res, task);
    if (action === 'diff') return sendJson(res, 200, await taskDiff(task));
    return fail(res, 404, 'unknown action');
  }
  if (req.method !== 'POST' || !action) return fail(res, 405, 'method not allowed');
  const body = await readJson(req);
  const reason = String(body.reason ?? '').trim().slice(0, 2000);

  switch (action) {
    case 'approve-start': {
      if (project.archived) return fail(res, 409, `project '${project.name}' is archived`);
      if (task.status !== 'pending') return fail(res, 409, `cannot approve start: status is '${task.status}'`);
      if (task.routing_state === 'routing') return fail(res, 409, 'routing is still running (local model); wait for the suggestion or try again in a moment');
      // effective settings = task as created, optionally replaced by the routing suggestion (use_routing) and/or explicit overrides
      const f = {};
      const sug = task.routing && task.routing.suggestion ? task.routing : null;
      if (truthy(body.use_routing) && sug) Object.assign(f, router.applySuggestion(task, sug, sug.request || { service: true, engine: true }));
      if (body.service_id !== undefined) {
        const sv = body.service_id === null || body.service_id === '' || body.service_id === 'none' ? null : store.getService(Number(body.service_id));
        if (sv && (sv.project_id !== project.id || sv.archived)) return fail(res, 400, `service ${body.service_id} is not an active service of project '${project.name}'`);
        if (!sv) return fail(res, 400, "a task needs a service; 'none' is not supported");
        f.service_id = sv.id;
      }
      if (body.engine !== undefined && body.engine !== '') { if (!store.ENGINES.includes(body.engine)) return fail(res, 400, `engine must be one of ${store.ENGINES.join(', ')}`); f.engine = body.engine; }
      const eng = f.engine ?? task.engine;
      if (eng !== 'local') {
        const wanted = body.model !== undefined && body.model !== '' ? body.model : (f.model ?? task.model ?? cfg.CURSOR_MODEL);
        const m = validModel(wanted, 'model'); if (m.error) return fail(res, 400, m.error);
        f.model = m.model;
      } else f.model = null;
      if (body.allow_escalation !== undefined) f.allow_escalation = truthy(body.allow_escalation);
      if (body.plan_first !== undefined) f.plan_first = truthy(body.plan_first);
      if (eng !== 'auto') f.allow_escalation = false;
      if (eng !== 'cursor') f.plan_first = false;
      const finalSvc = f.service_id !== undefined ? f.service_id : task.service_id;
      if (!finalSvc) return fail(res, 409, 'choose a service before starting (a task runs inside exactly one service/repo); the router suggested none or several - pick one, or split the work into a sequence');
      if (task.plan_state && f.engine && f.engine !== 'cursor') return fail(res, 409, 'task already has a plan; engine must stay cursor');
      if (eng === 'cursor') {
        const st = await cursor.getStatus();
        if (!st.installed || !st.logged_in) return fail(res, 409, `cursor CLI unavailable: ${st.error || 'not logged in'}`);
      }
      // routing_source: keep the router's label only if the final service/engine equal its suggestion; otherwise the human decided
      const notes = [];
      if (sug) {
        const same = (sug.suggestion.service_id || null) === (finalSvc || null) && sug.suggestion.policy.engine === eng;
        if (!same) { f.routing_source = 'manual'; notes.push(`human overrode the routing suggestion (suggested service=${sug.suggestion.service || '-'} engine=${sug.suggestion.policy.engine}; chosen service=${finalSvc ? store.getService(finalSvc).name : '-'} engine=${eng})`); }
        else notes.push(`routing suggestion (${sug.suggestion.source}) confirmed by human`);
      }
      const nv = (v) => (v === true ? 1 : v === false ? 0 : v ?? null);
      const changed = Object.keys(f).filter((k) => k !== 'routing_source' && nv(f[k]) !== nv(task[k]));
      if (!store.transition(id, 'pending', 'approved', f)) return fail(res, 409, `cannot approve start: status is '${task.status}'`);
      store.addApproval(id, 'start', 'approved', reason);
      for (const n of notes) store.addEvent(id, 'route', n);
      if (changed.length) store.addEvent(id, 'system', `start settings at approval: ${changed.map((k) => `${k}=${f[k]}`).join(', ')}`);
      store.addEvent(id, 'system', 'start approved by human; queued for runner');
      return sendJson(res, 200, store.getTask(id));
    }
    case 'reroute': {
      if (task.status !== 'pending') return fail(res, 409, 'only pending tasks can be re-routed');
      if (task.routing_state === 'routing') return fail(res, 409, 'routing already running');
      const req = (task.routing && task.routing.request) || { service: true, engine: true };
      store.updateFields(id, { routing_json: JSON.stringify({ request: req }), routing_state: 'routing', route_requested: true });
      store.addEvent(id, 'route', 're-routing requested');
      setImmediate(() => router.routeTask(id));
      return sendJson(res, 200, store.getTask(id));
    }
    case 'approve-plan': {
      if (task.status !== 'awaiting_plan') return fail(res, 409, `cannot approve plan: status is '${task.status}'`);
      if (task.supervised) return fail(res, 409, 'task is supervised; release it first');
      const u = store.cursorStats();
      const f = { plan_state: 'approved' };
      if (body.plan !== undefined) { const t = String(body.plan).trim(); if (!t || t.length > 50000) return fail(res, 400, 'plan must be 1..50000 chars'); f.plan_text = t; }
      if (!store.transition(id, 'awaiting_plan', 'approved', f)) return fail(res, 409, 'status changed');
      store.addApproval(id, 'plan', 'approved', reason);
      store.addEvent(id, 'cursor', `PLAN APPROVED by human${body.plan !== undefined ? ' (plan edited)' : ''}${reason ? ': ' + reason : ''}; implementation run queued (Cursor runs so far: ${u.today.runs} today, ${u.total.runs} total; no cap)`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'reject-plan': {
      if (!reason) return fail(res, 400, 'reason required');
      if (task.status !== 'awaiting_plan') return fail(res, 409, `cannot reject plan: status is '${task.status}'`);
      if (!store.transition(id, 'awaiting_plan', 'rejected', { plan_state: 'rejected', result_summary: `${task.result_summary || ''}; plan rejected: ${reason}` })) return fail(res, 409, 'status changed');
      store.addApproval(id, 'plan', 'rejected', reason);
      store.addEvent(id, 'cursor', `PLAN REJECTED by human: ${reason} (nothing was implemented; branch ${task.branch} has no changes)`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'reject-start': {
      if (!reason) return fail(res, 400, 'reason required');
      if (!store.transition(id, 'pending', 'rejected')) return fail(res, 409, `cannot reject: status is '${task.status}'`);
      store.updateFields(id, { result_summary: `rejected before start: ${reason}` });
      store.addApproval(id, 'start', 'rejected', reason);
      store.addEvent(id, 'system', `start rejected: ${reason}`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'rerun': {
      // Re-run = a NEW pending task cloned from this one (fresh id and branch; the failed run, its logs and its branch stay as history). It still needs the normal start approval.
      if (!['failed', 'rejected'].includes(task.status)) return fail(res, 409, `only failed or rejected tasks can be re-run (status is '${task.status}')`);
      if (project.archived) return fail(res, 409, `project '${project.name}' is archived`);
      const sv = task.service_id ? store.getService(task.service_id) : null;
      if (!sv || sv.archived) return fail(res, 409, 'the service of this task is missing or archived; create a new task instead');
      const copy = {
        project_id: task.project_id, title: task.title, prompt: task.prompt, files: Array.isArray(task.files) ? task.files : [], check_cmd: task.check_cmd, engine: task.engine, model: task.model,
        allow_escalation: !!task.allow_escalation, ai_review: !!task.ai_review, review_model: task.review_model, service_id: task.service_id, plan_first: !!task.plan_first, routing_source: 'manual',
      };
      const nid = store.createTask(copy);
      store.addEvent(nid, 'system', `task created as a re-run of #${id} (status: pending, awaiting start approval; engine ${copy.engine}${copy.model ? ' model ' + copy.model : ''})`);
      store.addEvent(id, 'system', `re-run requested by human: new task #${nid}`);
      return sendJson(res, 201, store.getTask(nid));
    }
    case 'approve-merge': {
      if (task.status !== 'review') return fail(res, 409, `cannot merge: status is '${task.status}' (needs 'review')`);
      if (task.supervised) return fail(res, 409, 'task is supervised (hands-on session open): click Release first so the check runs and the current worktree state is committed');
      // cross-repo features: a consumer cannot be merged before its provider (contract-first). Only a typed override_reason (>= 8 chars) lifts it; it is recorded.
      const order = features.mergeGuard(task);
      const overrideReason = String(body.override_reason ?? '').trim().slice(0, 2000);
      if (order && overrideReason.length < features.MIN_OVERRIDE_REASON) {
        store.addEvent(id, 'system', `merge blocked by feature merge order: ${order.message}`);
        return fail(res, 409, `${order.message}. Merge the provider first, or send a typed override_reason (at least ${features.MIN_OVERRIDE_REASON} characters) to override; the reason is recorded.`,
          { merge_order_blocked: true, override_required: true, feature_id: order.feature_id, provider_task_id: order.provider_task_id, provider_status: order.provider_status });
      }
      const r = await mergeTask(task);
      if (!r.ok) {
        store.addEvent(id, 'error', `merge refused/failed: ${r.message}`);
        return fail(res, 409, r.message);
      }
      if (!store.transition(id, 'review', 'done', { result_summary: `${task.result_summary || ''}; ${r.message}` })) return fail(res, 409, 'status changed during merge');
      if (order) { features.recordOverride(task, order, overrideReason); store.addApproval(id, 'merge', 'approved', `MERGE-ORDER OVERRIDE: ${overrideReason}${reason ? ' | ' + reason : ''}`); }
      else store.addApproval(id, 'merge', 'approved', reason);
      features.refresh(task.feature_id);
      store.addEvent(id, 'git', r.message);
      store.addEvent(id, 'git', await removeWorktree(task));
      return sendJson(res, 200, { ...store.getTask(id), merge: r.message });
    }
    case 'reject-merge': {
      if (!reason) return fail(res, 400, 'reason required');
      if (!store.transition(id, 'review', 'rejected')) return fail(res, 409, `cannot reject: status is '${task.status}'`);
      store.updateFields(id, { result_summary: `${task.result_summary || ''}; merge rejected: ${reason}` });
      store.addApproval(id, 'merge', 'rejected', reason);
      store.addEvent(id, 'system', `merge rejected: ${reason} (branch ${task.branch} kept, worktree kept)`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'approve-escalation': {
      if (task.status !== 'awaiting_escalation') return fail(res, 409, `cannot approve escalation: status is '${task.status}'`);
      if (task.supervised) return fail(res, 409, 'task is supervised; release it first');
      const u = store.cursorStats();
      if (!store.transition(id, 'awaiting_escalation', 'approved', { escalation: 'approved' })) return fail(res, 409, 'status changed');
      store.addApproval(id, 'escalate', 'approved', reason);
      store.addEvent(id, 'escalation', `escalation to Cursor APPROVED by human${reason ? ': ' + reason : ''}; queued for the runner (Cursor runs so far: ${u.today.runs} today, ${u.total.runs} total; no cap)`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'reject-escalation': {
      if (!reason) return fail(res, 400, 'reason required');
      if (task.status !== 'awaiting_escalation') return fail(res, 409, `cannot reject escalation: status is '${task.status}'`);
      if (!store.transition(id, 'awaiting_escalation', 'rejected', { escalation: 'rejected', result_summary: `${task.result_summary || ''}; escalation to Cursor rejected: ${reason}` })) return fail(res, 409, 'status changed');
      store.addApproval(id, 'escalate', 'rejected', reason);
      store.addEvent(id, 'escalation', `escalation to Cursor REJECTED by human: ${reason} (cursor was never invoked; local attempt kept on branch ${task.branch})`);
      return sendJson(res, 200, store.getTask(id));
    }
    case 'open-cursor': {
      if (!['review', 'failed', 'awaiting_escalation', 'awaiting_plan'].includes(task.status)) return fail(res, 409, `cannot open a hands-on session while status is '${task.status}' (needs review/failed/awaiting_escalation/awaiting_plan with an existing worktree)`);
      const mode = String(body.mode || '');
      if (!['ide', 'terminal'].includes(mode)) return fail(res, 400, "mode must be 'ide' or 'terminal'");
      let r;
      try { r = await opener.openTask(task, project, mode); } catch (e) { return fail(res, 409, e.message); }
      if (!r.ok) return fail(res, 502, `could not open: ${r.detail}`, r);
      if (!task.supervised) store.updateFields(id, { supervised: true });
      if (mode === 'terminal') store.recordCursorUse(id, 'session', 'auto');
      store.addEvent(id, 'system', `SUPERVISED: opened ${r.path} in ${mode === 'ide' ? 'the Cursor IDE' : 'an interactive Cursor agent session (Terminal, --model auto)'}${r.rules_file ? '; context rules at ' + r.rules_file : ''}. The runner is paused for this task; merge/escalation/plan approvals are blocked until you click Release (runs the check and commits on the branch).`);
      return sendJson(res, 200, { ...r, task: store.getTask(id) });
    }
    case 'release': {
      if (!task.supervised) return fail(res, 409, 'task is not supervised');
      try { const r = await runner.releaseSupervised(id); return sendJson(res, 200, { ...r, task: store.getTask(id) }); }
      catch (e) { return fail(res, 409, e.message); }
    }
    case 'cancel': {
      if (!runner.cancel(id)) return fail(res, 409, 'task is not currently running');
      return sendJson(res, 200, { ok: true });
    }
    default: return fail(res, 404, 'unknown action');
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding / CSRF defence: only accept our own Host, and same-origin (or no Origin) for writes
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return fail(res, 403, 'bad Host header');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return fail(res, 403, 'bad Origin');
      // the one raw-bytes route (attachment upload) has its own content-type + custom-header checks in lib/attachments-api.js
      const isUpload = url.pathname === '/api/attachments';
      if (!isUpload && !String(req.headers['content-type'] || '').startsWith('application/json')) return fail(res, 415, 'Content-Type must be application/json');
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return fail(res, 405, 'method not allowed');
    return serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof projects.ProjectError) return fail(res, e.status, e.message, e.extra);
    console.error('[http] error', e);
    if (!res.headersSent) fail(res, e.message === 'invalid JSON' || e.message === 'body too large' ? 400 : 500, e.message);
    else res.end();
  }
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`[${new Date().toISOString()}] orchestrator listening on http://${cfg.HOST}:${cfg.PORT} projects=${store.listProjects().length} schema=v${store.schemaVersion()} db=${cfg.DB_PATH}`);
  if (cfg.CURSOR_CAP_ENV_IGNORED.length) console.log(`[startup] NOTICE: ${cfg.CURSOR_CAP_ENV_IGNORED.join(', ')} ${cfg.CURSOR_CAP_ENV_IGNORED.length > 1 ? 'are' : 'is'} set but IGNORED: the Cursor daily caps were removed. Usage is only counted (GET /api/cursor/usage); every Cursor run still needs your approval click.`);
  try { const swept = serviceOps.sweepJournal(); if (swept.length) console.log(`[startup] journal sweep removed ${swept.length} leftover director${swept.length === 1 ? 'y' : 'ies'}: ${swept.map((x) => x.path).join(', ')}`); } catch (e) { console.error('[startup] journal sweep failed:', e.message); }
  try { const stale = chat.recoverStale(); if (stale) console.log(`[startup] marked ${stale} interrupted chat answer(s) as error`); } catch (e) { console.error('[startup] chat recovery failed:', e.message); }
  const sweepAttachments = () => { try { const r = attachments.gc(); if (r.removed.length || r.orphans) console.log(`[attachments] sweep removed ${r.removed.length} unreferenced attachment(s) (${r.bytes} bytes), ${r.orphans} orphan file(s)${r.retention ? `, ${r.retention} by retention` : ''}`); } catch (e) { console.error('[attachments] sweep failed:', e.message); } };
  sweepAttachments(); setInterval(sweepAttachments, 3600 * 1000).unref();
  runner.start();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(`${sig}: shutting down`); runner.stopCurrent(); server.close(); setTimeout(() => process.exit(0), 200); });

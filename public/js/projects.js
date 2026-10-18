// Projects: list (cards + authorized folders) and project detail (Services / Dependencies / Context / Memory / Sequences / Settings).
import { el, clear, api, badge, chip, statusBadge, empty, skeletonCards, skeletonLines, field, select, confirmDialog, promptDialog, toast, toastError, busy, shortPath, ago } from './ui.js';
import { S, loadProjects, loadServices, loadTasks, setProjectFilter, project as projectOf, activeServices } from './state.js';
import { addServiceModal, newProjectModal, editServiceModal, rootsCard } from './service-modals.js';
import { newTaskModal } from './tasks.js';
import { contextTab, memoryTab, sequencesTab, cursorUsageCard } from './project-tabs.js';
import { cursorRulesCard, cursorRulesModal } from './cursor-rules.js';

const TABS = [['services', 'Services'], ['deps', 'Dependencies'], ['context', 'Context'], ['memory', 'Memory'], ['sequences', 'Sequences'], ['settings', 'Settings']];

export async function render(main, route) {
  if (route.id) return renderDetail(main, route);
  return renderList(main, route);
}

// ---------------------------------------------------------------- list
async function renderList(main, route) {
  let showArchived = false; const root = el('div'); main.append(root);
  const draw = () => {
    const all = S.projects, list = all.filter((p) => showArchived || !p.archived);
    const open = (p) => { location.hash = `#/projects/${p.id}/services`; };
    clear(root,
      el('div', { className: 'page-head' }, el('div', { className: 'grow' }, el('h1', {}, 'Projects'), el('p', {}, 'A project is a product made of one or more services; each service is a git repository (or a folder inside one). Tasks run against one service.')),
        el('label', { className: 'row small', style: { margin: 0 } }, el('input', { type: 'checkbox', checked: showArchived, onchange: (e) => { showArchived = e.target.checked; draw(); } }), 'show archived'),
        el('button', { className: 'btn primary', textContent: '+ New project', onclick: () => newProjectModal() })),
      list.length ? el('div', { className: 'grid auto' }, ...list.map((p) => projectCard(p, open)))
        : empty({ icon: 'folder', title: 'No projects yet', text: 'Create a project, then import a repository from a git URL, create a new one, or register a folder that is already on this Mac.', action: el('button', { className: 'btn primary', textContent: '+ New project', onclick: () => newProjectModal() }) }),
      el('div', { className: 'mt', id: 'usage-slot' }), el('div', { className: 'mt', id: 'roots-slot' }));
    rootsCard().then((c) => { const slot = root.querySelector('#roots-slot'); if (slot) slot.append(c); });
    cursorUsageCard().then((c) => { const slot = root.querySelector('#usage-slot'); if (slot) slot.append(c); });
  };
  clear(root, el('div', { className: 'page-head' }, el('h1', {}, 'Projects')), skeletonCards(3));
  try { await loadProjects(); await loadTasks(); } catch (e) { toastError(e); }
  draw();
  if (route && route.query && route.query.get('open') === 'new-project') newProjectModal();
}
function projectCard(p, open) {
  const tasks = S.tasks.filter((t) => t.project_id === p.id), active = tasks.filter((t) => ['pending', 'approved', 'running', 'checking', 'awaiting_escalation', 'awaiting_plan'].includes(t.status)).length, review = tasks.filter((t) => t.status === 'review').length;
  const c = el('div', { className: 'card hover', tabIndex: 0, role: 'link', 'aria-label': `open project ${p.name}`, onclick: () => open(p), onkeydown: (e) => { if (e.key === 'Enter') open(p); } },
    el('div', { className: 'head' }, el('h3', {}, p.name), p.archived ? badge('archived', 's-rejected') : null),
    el('div', { className: 'small dim', style: { minHeight: '34px' } }, p.description || 'No description.'),
    el('div', { className: 'row mt', id: `pc-svc-${p.id}` }, el('span', { className: 'skel', style: { width: '120px', height: '18px' } })),
    el('div', { className: 'row mt' }, active ? badge(`${active} active`, 's-running') : null, review ? badge(`${review} to review`, 's-review') : null, !active && !review ? el('span', { className: 'small dim' }, `${tasks.length} task(s)`) : null));
  loadServices(p.id, false).then((svcs) => { const box = c.querySelector(`#pc-svc-${p.id}`); if (!box) return; const act = svcs.filter((s) => !s.archived); clear(box, chip(`${act.length} service${act.length === 1 ? '' : 's'}`), ...act.slice(0, 4).map((s) => chip(s.name, 'mono')), act.length > 4 ? chip(`+${act.length - 4}`) : null); });
  return c;
}

// ---------------------------------------------------------------- detail
async function renderDetail(main, route) {
  const id = Number(route.id); let tab = TABS.some(([k]) => k === route.tab) ? route.tab : 'services';
  if (!S.projects.length) await loadProjects();
  let p = projectOf(id);
  if (!p) { try { p = await api(`/projects/${id}`); } catch { /* below */ } }
  if (!p) { main.append(empty({ icon: '?', title: 'Project not found', action: el('a', { className: 'btn', href: '#/projects', textContent: 'Back to projects' }) })); return; }
  setProjectFilter(p.id);
  const head = el('div'), body = el('div', { id: 'proj-body' });
  main.append(head, body);
  let cleanup = null;
  const ctx = { get p() { return p; }, refreshProject: async () => { await loadProjects(); p = projectOf(id) || p; drawHead(); }, goTab: (t) => { location.hash = `#/projects/${id}/${t}`; }, redraw: () => drawTab() };
  function drawHead() {
    clear(head,
      el('div', { className: 'crumbs small' }, el('a', { href: '#/projects', textContent: '\u2190 Projects' })),
      el('div', { className: 'page-head' }, el('div', { className: 'grow' }, el('h1', {}, p.name, p.archived ? ' ' : '', p.archived ? badge('archived', 's-rejected') : null), el('p', {}, p.description || 'No description yet \u2013 add one in Settings so routing and the context bundle know what this product is.')),
        el('button', { className: 'btn', textContent: '+ New task', disabled: p.archived, onclick: () => newTaskModal(p.id) }),
        el('button', { className: 'btn primary', textContent: '+ Add service', disabled: p.archived, onclick: () => addServiceModal(p, { onDone: () => ctx.redraw() }) })),
      el('div', { className: 'tabs', role: 'tablist' }, ...TABS.map(([k, l]) => el('button', { role: 'tab', 'aria-selected': k === tab, className: k === tab ? 'on' : '', textContent: l === 'Memory' ? `Memory${S.memProps.filter((m) => m.project_id === p.id && m.status === 'pending').length ? ' \u25CF' : ''}` : l, onclick: () => ctx.goTab(k) }))));
  }
  async function drawTab() {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    const view = { services: servicesTab, deps: depsTab, context: contextTab, memory: memoryTab, sequences: sequencesTab, settings: settingsTab }[tab];
    clear(body, skeletonLines(5));
    try { const box = el('div'); const c = await view(box, ctx); clear(body, box); cleanup = c || null; } catch (e) { clear(body, el('div', { className: 'callout bad' }, e.message)); }
  }
  drawHead(); await drawTab();
  const open = route.query && route.query.get('open'); // deep links: ?open=add-service[:import|create|existing] | new-task
  if (open && open.startsWith('add-service') && !p.archived) addServiceModal(p, { tab: open.split(':')[1] || 'import', onDone: () => ctx.redraw() });
  if (open === 'new-task' && !p.archived) newTaskModal(p.id);
  return () => { if (cleanup) cleanup(); };
}

// ---------------------------------------------------------------- services tab
async function servicesTab(box, ctx) {
  const p = ctx.p; let showArch = false;
  const svcs = await loadServices(p.id);
  const redo = async () => { await loadServices(p.id); await loadProjects(); draw(); };
  function draw() {
    const all = S.svc[p.id] || [], list = all.filter((s) => showArch || !s.archived), nArch = all.filter((s) => s.archived).length;
    clear(box,
      el('div', { className: 'row mb' }, el('div', { className: 'grow small dim', style: { flex: 1 } }, 'Each service is its own repository (or a folder inside one). A task works on exactly one service, in its own worktree and branch.'),
        nArch ? el('label', { className: 'row small', style: { margin: 0 } }, el('input', { type: 'checkbox', checked: showArch, onchange: (e) => { showArch = e.target.checked; draw(); } }), `show ${nArch} archived`) : null,
        el('button', { className: 'btn sec sm', textContent: 'Detect subfolders', onclick: (e) => detect(e.currentTarget) })),
      el('div', { id: 'detect-out' }),
      list.length ? el('div', { className: 'grid auto' }, ...list.map(serviceCard))
        : empty({ icon: 'database', title: 'No services yet', text: 'Add the first repository of this project.', action: el('div', { className: 'row', style: { justifyContent: 'center' } },
          el('button', { className: 'btn primary', textContent: 'Import from git URL', onclick: () => addServiceModal(p, { tab: 'import', onDone: redo }) }), el('button', { className: 'btn', textContent: 'Create new repo', onclick: () => addServiceModal(p, { tab: 'create', onDone: redo }) }), el('button', { className: 'btn', textContent: 'Add existing folder', onclick: () => addServiceModal(p, { tab: 'existing', onDone: redo }) })) }));
  }
  function serviceCard(s) {
    const st = el('div', { className: 'small mt', id: `st-${s.id}` });
    const used = S.tasks.filter((t) => t.service_id === s.id).length;
    return el('div', { className: 'card' + (s.archived ? ' flat' : ''), style: s.archived ? { opacity: 0.7 } : null },
      el('div', { className: 'head' }, el('h3', {}, s.name), el('div', { className: 'row' }, s.archived ? badge('archived', 's-rejected') : statusBadge(s.status === 'active' ? 'active' : s.status))),
      el('div', { className: 'row mb' }, chip(s.type || 'other'), s.stack ? chip(s.stack) : null, chip(`origin: ${s.origin}`), !s.exists && !s.archived ? badge('missing on disk', 's-failed') : null, s.status === 'unauthorized' ? badge('outside authorized folders', 's-failed') : null),
      s.description ? el('div', { className: 'small mb' }, s.description) : null,
      el('dl', { className: 'kv' }, el('dt', {}, 'Location'), el('dd', {}, el('code', {}, shortPath(s.local_path || '')), s.path && s.path !== '.' ? el('code', {}, ` / ${s.path}`) : null),
        el('dt', {}, 'Branch'), el('dd', {}, s.default_branch || '-'), s.remote_url ? el('dt', {}, 'Remote') : null, s.remote_url ? el('dd', {}, el('code', {}, s.remote_url)) : null,
        el('dt', {}, 'Check'), el('dd', {}, s.check_cmd ? el('code', {}, s.check_cmd) : el('span', { className: 'dim' }, 'project default')), el('dt', {}, 'Tasks'), el('dd', {}, String(used))),
      st,
      el('div', { className: 'row mt' },
        el('button', { className: 'btn sm', textContent: 'Edit', onclick: () => editServiceModal(p, s, { onDone: redo }) }),
        el('button', { className: 'btn sm sec', textContent: 'Repo status', onclick: (e) => busy(e.currentTarget, async () => { const r = await api(`/services/${s.id}/status`); clear(st, r.usable ? [chip(`branch ${r.branch || '?'}`), ' ', chip(r.clean ? 'clean' : 'uncommitted changes', r.clean ? 's-ok' : 's-failed'), ' ', chip(`HEAD ${r.head || '-'}`, 'mono'), r.on_default_branch ? null : [' ', badge(`not on ${r.default_branch}`, 's-failed')]] : badge(r.problem || 'unusable', 's-failed')); }) }),
        el('button', { className: 'btn sm sec', textContent: 'New task', disabled: s.archived, onclick: () => newTaskModal(p.id, s.id) }),
        el('button', { className: 'btn sm sec', textContent: 'Cursor rules', title: 'Generate .cursor/rules for this service (preview first, review branch only)', disabled: s.archived || !s.exists, onclick: () => cursorRulesModal(p, s) }),
        el('span', { style: { flex: 1 } }),
        el('button', { className: 'btn sm ghost', textContent: s.archived ? 'Unarchive' : 'Archive', onclick: (e) => busy(e.currentTarget, async () => { await api(`/services/${s.id}/${s.archived ? 'unarchive' : 'archive'}`, {}); toast(s.archived ? 'service restored' : 'service archived', 'ok'); await redo(); }) }),
        el('button', { className: 'btn sm ghost', textContent: 'Unregister', title: 'Removes the registration only; files are never deleted', onclick: async () => {
          if (!(await confirmDialog({ title: `Unregister ${s.name}?`, message: `This only removes ${s.name} from the orchestrator. The repository folder (${shortPath(s.local_path)}) and its files are NOT deleted.\n\nServices that have task history cannot be unregistered \u2013 archive them instead.`, confirmText: 'Unregister', danger: true }))) return;
          try { const r = await api(`/services/${s.id}/remove`, {}); toast(`unregistered; files left untouched at ${shortPath(r.local_path)}`, 'ok', 7000); await redo(); } catch (e) { toastError(e); } } })));
  }
  async function detect(btn) {
    const out = box.querySelector('#detect-out'); clear(out, skeletonLines(2));
    try {
      const r = await api(`/projects/${p.id}/services/detect`);
      clear(out, el('div', { className: 'card flat mb' }, el('div', { className: 'small dim mb' }, r.note || 'Detected from the committed layout.'), r.suggestions.length ? el('div', { className: 'stack' }, ...r.suggestions.map((x) =>
        el('div', { className: 'row' }, el('button', { className: 'btn sm', disabled: x.registered, textContent: x.registered ? 'registered' : 'Register', onclick: async (e) => { try { await api(`/projects/${p.id}/services`, { name: x.name, path: x.path, description: x.description, check_cmd: x.suggested_check_cmd || '' }); toast(`added ${x.name}`, 'ok'); await redo(); } catch (er) { toastError(er); } } }),
          el('b', {}, x.name), el('code', {}, x.path), chip(x.kind), x.suggested_check_cmd ? el('span', { className: 'small dim' }, `check: ${x.suggested_check_cmd}`) : null))) : el('div', { className: 'dim' }, 'Nothing detected.'),
        el('div', { className: 'row mt' }, el('button', { className: 'btn sm ghost', textContent: 'Dismiss', onclick: () => clear(out) }))));
    } catch (e) { clear(out, el('div', { className: 'callout warn' }, e.message)); }
  }
  void svcs; draw();
}

// ---------------------------------------------------------------- dependencies tab
async function depsTab(box, ctx) {
  const p = ctx.p; await loadServices(p.id);
  async function draw() {
    const deps = await api(`/projects/${p.id}/deps`); const act = activeServices(p.id);
    const from = select(act.map((s) => [s.id, s.name])), to = select([['', '\u2014 service \u2014'], ...act.map((s) => [s.id, s.name])]), ext = el('input', { placeholder: 'or an external system, e.g. postgres, stripe-api' }), note = el('input', { placeholder: 'note (optional)' });
    clear(box, el('div', { className: 'small dim mb' }, 'Informational map used in the context bundle and the generated SERVICES.md. It never restricts what a task may touch.'),
      deps.length ? el('div', { className: 'card flat mb' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Service'), el('th', {}, 'depends on'), el('th', {}, 'Note'), el('th', {}))), el('tbody', {}, ...deps.map((d) => el('tr', {}, el('td', {}, el('b', {}, d.service)), el('td', {}, d.depends_on_service_id ? d.depends_on : chip(d.external, 'mono')), el('td', { className: 'dim' }, d.note || ''), el('td', { style: { textAlign: 'right' } }, el('button', { className: 'btn sm ghost', textContent: 'Remove', onclick: async () => { try { await api(`/projects/${p.id}/deps`, { action: 'remove', id: d.id }); draw(); } catch (e) { toastError(e); } } }))))))) : empty({ icon: 'arrows-exchange', title: 'No dependencies recorded', text: 'Record which services call each other, or which external systems they rely on.' }),
      act.length ? el('div', { className: 'card' }, el('h3', {}, 'Add dependency'), el('div', { className: 'form-grid mt' }, field('Service', from), field('Depends on service', to), field('\u2026or external system', ext), field('Note', note)),
        el('button', { className: 'btn primary', textContent: 'Add', onclick: (e) => busy(e.currentTarget, async () => { await api(`/projects/${p.id}/deps`, { action: 'add', service_id: from.value, depends_on_service_id: to.value || undefined, external: ext.value || undefined, note: note.value }); toast('dependency added', 'ok'); draw(); }) })) : null);
  }
  await draw();
}

// ---------------------------------------------------------------- settings tab
async function settingsTab(box, ctx) {
  const p = ctx.p, e = p.settings_effective || {}, ov = p.settings || {}; const svcs = await loadServices(p.id); const act = svcs.filter((s) => !s.archived);
  const name = el('input', { value: p.name, maxLength: 64 }), desc = el('textarea', { value: p.description || '', style: { minHeight: '80px' } }), rootDir = el('input', { value: p.root_dir || '', placeholder: 'optional default folder for new repos' });
  const check = el('input', { value: p.check_cmd || '' }), install = el('input', { value: p.install_cmd || '' }), eng = select([['local', 'local'], ['cursor', 'cursor'], ['auto', 'auto']], p.engine);
  const apply = select([['suggest', 'suggest (you confirm at approve-start)'], ['auto', 'auto (apply the router suggestion)']], e.route_apply);
  const cx = select([['cursor', 'cursor'], ['auto', 'auto'], ['local', 'local']], e.complex_engine), sx = select([['auto', 'auto (local first, escalation allowed)'], ['local', 'local'], ['cursor', 'cursor']], e.simple_engine);
  const pf = select([['true', 'yes'], ['false', 'no']], String(!!e.plan_first_complex)), mp = select([['true', 'yes'], ['false', 'no']], String(!!e.memory_proposals)), cap = el('input', { type: 'number', min: 2000, max: 60000, value: e.context_max_chars });
  const aiCfg = (p.config && p.config.ai_dir) || {};
  const aiSvc = select([['', '\u2014 off \u2014'], ...act.map((s) => [s.id, s.name])], aiCfg.service_id ? String(aiCfg.service_id) : ''), aiImp = el('input', { type: 'checkbox', checked: !!aiCfg.import }), aiExp = el('input', { type: 'checkbox', checked: !!aiCfg.export });
  const err = el('div', { className: 'callout bad', style: { display: 'none' } });
  const save = el('button', { className: 'btn primary', textContent: 'Save settings', onclick: (ev) => busy(ev.currentTarget, async () => {
    err.style.display = 'none';
    try {
      const body = { name: name.value, description: desc.value, root_dir: rootDir.value, check_cmd: check.value, install_cmd: install.value, engine: eng.value,
        settings: { route_apply: apply.value, complex_engine: cx.value, simple_engine: sx.value, plan_first_complex: pf.value, memory_proposals: mp.value, context_max_chars: cap.value },
        config: { ai_dir: aiSvc.value ? { service_id: Number(aiSvc.value), import: aiImp.checked, export: aiExp.checked } : null } };
      await api(`/projects/${p.id}/update`, body); toast('settings saved', 'ok'); await ctx.refreshProject();
    } catch (er) { err.textContent = er.message; err.style.display = ''; }
  }) });
  clear(box, el('div', { className: 'stack' },
    el('div', { className: 'card' }, el('h3', {}, 'General'), el('div', { className: 'form-grid mt' }, field('Name', name), field('Default folder for new repos', rootDir, 'must be inside an authorized folder'), el('div', { className: 'full' }, field('Description', desc, 'shared with every engine and used by the router'))), p.check_warning ? el('div', { className: 'callout warn mb' }, p.check_warning) : null),
    el('div', { className: 'card' }, el('h3', {}, 'Defaults for tasks'), el('div', { className: 'form-grid mt' }, field('Check command (project default)', check, 'a service can override it'), field('Install command (optional)', install), field('Default engine for new tasks', eng), field('Context bundle cap (chars)', cap, '2000 \u2013 60000'))),
    el('div', { className: 'card' }, el('h3', {}, 'Routing'), el('div', { className: 'form-grid mt' }, field('Apply router suggestion', apply), field('Memory proposals after tasks', mp), field('Complex / needs-thinking tasks', cx), field('Simple tasks', sx), field('Plan first for complex Cursor tasks', pf)),
      el('div', { className: 'small dim' }, `Explicit overrides for this project: ${Object.keys(ov).length ? JSON.stringify(ov) : 'none (environment defaults apply)'}`)),
    el('div', { className: 'card' }, el('h3', {}, 'Shared .ai/ folder (optional)'), el('div', { className: 'small dim mb' }, 'Off by default. Context files are kept in the orchestrator\'s own managed copy. Opt in to import them from a service\'s repo, or export them back on a review branch.'),
      el('div', { className: 'form-grid' }, field('Service holding .ai/', aiSvc), el('div', {}, el('label', { className: 'row', style: { margin: '6px 0' } }, aiImp, 'allow import from repo'), el('label', { className: 'row', style: { margin: '6px 0' } }, aiExp, 'allow export (new branch + review task)')))),
    cursorRulesCard(p, act),
    err, el('div', { className: 'row' }, save),
    await cursorUsageCard({ projectId: p.id }),
    dangerZone(p, ctx)));
}
function dangerZone(p, ctx) {
  const act = (label, text, fn, danger) => el('div', { className: 'row', style: { justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--line)' } }, el('div', {}, el('b', {}, label), el('div', { className: 'small dim' }, text)), fn);
  return el('div', { className: 'card', style: { borderColor: 'var(--bad)' } }, el('h3', { className: 't-bad' }, 'Archive & delete'),
    act(p.archived ? 'Unarchive project' : 'Archive project', p.archived ? 'Make it active again.' : 'Hides it from pickers. Refused while tasks are active.', el('button', { className: 'btn sec', textContent: p.archived ? 'Unarchive' : 'Archive', onclick: (e) => busy(e.currentTarget, async () => { await api(`/projects/${p.id}/${p.archived ? 'unarchive' : 'archive'}`, {}); toast(p.archived ? 'project restored' : 'project archived', 'ok'); await ctx.refreshProject(); ctx.goTab('settings'); }) })),
    act('Delete project', 'Removes the project record and its history only. Repositories, worktrees and branches are never deleted; the managed context folder is moved to the trash.', el('button', { className: 'btn bad', textContent: 'Delete\u2026', onclick: async () => {
      if (!(await confirmDialog({ title: `Delete project ${p.name}?`, message: 'Only orchestrator records are removed. Your repositories and files stay exactly where they are. Refused while tasks are unfinished.', confirmText: 'Delete project', danger: true, typeToConfirm: p.name }))) return;
      try { const r = await api(`/projects/${p.id}/delete`, { confirm: p.name }); const left = (r.leftovers && (r.leftovers.worktrees || []).length) || 0; toast(`project deleted${left ? `; ${left} worktree(s) were left on disk` : ''}`, 'ok', 8000); await loadProjects(); location.hash = '#/projects'; } catch (e) { toastError(e); } } })));
}

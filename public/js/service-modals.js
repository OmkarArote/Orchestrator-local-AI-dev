// Add Service modal (Import from git URL / Create new repo / Add existing folder), New Project modal, service edit modal, roots card.
import { el, clear, api, ApiError, badge, chip, field, select, modal, confirmDialog, toast, toastError, busy, shortPath, hhmmss } from './ui.js';
import { S, loadProjects, loadServices, loadTasks } from './state.js';

const TYPES = ['api', 'web', 'worker', 'library', 'cli', 'infra', 'docs', 'other'];
const typeSel = () => select(TYPES.map((t) => [t, t]), 'other');
const defaultParent = (project) => project.root_dir || (S.cfg && S.cfg.projects_parent) || '';
const msgBox = () => el('div', { className: 'callout bad', style: { display: 'none' }, role: 'alert' });
const showMsg = (box, text) => { box.textContent = text; box.style.display = text ? '' : 'none'; };

// ---------------------------------------------------------------- Add service
export function addServiceModal(project, { onDone, tab = 'import' } = {}) {
  let cur = tab; const panes = {}; let job = null, poll = null;
  const tabs = el('div', { className: 'tabs', role: 'tablist' });
  const host = el('div');
  const foot = el('div', { className: 'row', style: { width: '100%', justifyContent: 'flex-end' } });
  const m = modal({ title: `Add a service to ${project.name}`, wide: true, body: el('div', {}, el('div', { className: 'small dim mb' }, 'A service is one git repository (or one folder inside a repo). Create it, clone it, or register a folder that is already on this Mac.'), tabs, host), footer: foot,
    dismissable: () => !job, onClose: () => { if (poll) clearInterval(poll); } });
  const finish = async (service) => { toast(`service '${service.name}' added`, 'ok'); await loadServices(project.id); m.close(); if (onDone) await onDone(service); };
  const drawTabs = () => clear(tabs, ...[['import', 'Import from URL'], ['create', 'Create new'], ['existing', 'Add existing folder']].map(([k, l]) => el('button', { className: cur === k ? 'on' : '', role: 'tab', 'aria-selected': cur === k, textContent: l, disabled: !!job, onclick: () => { cur = k; show(); } })));
  function show() { drawTabs(); clear(host, panes[cur] || (panes[cur] = build(cur))); }

  function build(kind) { return { import: buildImport, create: buildCreate, existing: buildExisting }[kind](); }
  const footerBtns = (...btns) => clear(foot, ...btns);

  // ---- import
  function buildImport() {
    const url = el('input', { placeholder: 'https://github.com/owner/repo.git  or  git@github.com:owner/repo.git', autocomplete: 'off', spellcheck: false });
    const name = el('input', { placeholder: 'derived from the URL' }), dir = el('input', { placeholder: 'derived from the URL' });
    const parent = el('input', { value: defaultParent(project) }), branch = el('input', { placeholder: 'remote default branch' }), type = typeSel();
    url.addEventListener('input', () => { const last = url.value.trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/i, ''); if (!name.dataset.touched) name.value = last.replace(/[^A-Za-z0-9._-]/g, '-'); });
    name.addEventListener('input', () => { name.dataset.touched = '1'; });
    const err = msgBox(); const progress = el('div', { style: { display: 'none' }, className: 'stack mt' });
    const bar = el('i', { style: { width: '0%' } }); const phase = el('div', { className: 'small dim' }); const logBox = el('div', { className: 'term-body short' });
    progress.append(el('div', { className: 'row' }, el('b', {}, 'Cloning'), phase), el('div', { className: 'progress' }, bar), el('div', { className: 'term' }, logBox));
    const start = el('button', { className: 'btn primary', textContent: 'Clone & add', onclick: async () => {
      showMsg(err, ''); start.disabled = true;
      try {
        const j = await api(`/projects/${project.id}/services/import`, { url: url.value, name: name.value, dir_name: dir.value || undefined, dest_parent: parent.value, branch: branch.value || undefined, type: type.value });
        job = j.id; progress.style.display = ''; drawTabs(); cancel.style.display = ''; start.style.display = 'none';
        poll = setInterval(async () => {
          try {
            const s = await api(`/jobs/${job}`);
            bar.style.width = `${s.percent}%`; phase.textContent = `${s.phase} \u00B7 ${s.percent}%`;
            clear(logBox, ...s.lines.map((l) => el('div', { className: 'term-line' }, el('span', { className: 'm' }, l)))); logBox.scrollTop = logBox.scrollHeight;
            if (['done', 'failed', 'cancelled'].includes(s.state)) {
              clearInterval(poll); poll = null; const jid = job; job = null; drawTabs();
              if (s.state === 'done') { await finish(s.result.service); } else { cancel.style.display = 'none'; start.style.display = ''; start.disabled = false; showMsg(err, s.state === 'cancelled' ? 'Import cancelled. Nothing was left behind.' : `Import failed: ${s.error}`); void jid; }
            }
          } catch (e) { clearInterval(poll); poll = null; job = null; drawTabs(); showMsg(err, e.message); start.style.display = ''; start.disabled = false; }
        }, 600);
      } catch (e) { showMsg(err, e.message); start.disabled = false; }
    } });
    const cancel = el('button', { className: 'btn bad', textContent: 'Cancel import', style: { display: 'none' }, onclick: (e) => busy(e.currentTarget, async () => { await api(`/jobs/${job}/cancel`, {}); }) });
    const pane = el('div', {}, el('div', { className: 'callout info small mb' }, 'Only https:// and ssh:// remotes. Credentials are never stored: your existing git credential helper / ssh-agent is used. Nothing from the repository is executed.'),
      field('Repository URL', url), el('div', { className: 'form-grid' }, field('Service name', name), field('Folder name', dir), el('div', { className: 'full' }, field('Clone into (inside an authorized folder)', parent)), field('Branch (optional)', branch), field('Type', type)), err, progress);
    pane.onshow = () => footerBtns(el('button', { className: 'btn sec', textContent: 'Close', onclick: () => { if (!job) m.close(); } }), cancel, start);
    return pane;
  }

  // ---- create
  function buildCreate() {
    const name = el('input', { placeholder: 'billing-api', maxLength: 64 }), dir = el('input', { placeholder: 'same as name' }), parent = el('input', { value: defaultParent(project) });
    const tpl = select([['empty', 'empty (README + .gitignore)'], ['node', 'node (package.json + test) \u2013 opt-in']], 'empty'), type = typeSel(), stack = el('input', { placeholder: 'node, python/fastapi, ...' });
    const check = el('input', { placeholder: "blank: 'npm test' for node, light whitespace check otherwise" }), desc = el('textarea', { style: { minHeight: '60px' }, placeholder: 'what this service owns (the router reads it)' });
    const err = msgBox();
    const go = el('button', { className: 'btn primary', textContent: 'Create repository', onclick: (e) => busy(e.currentTarget, async () => {
      showMsg(err, '');
      try { const r = await api(`/projects/${project.id}/services/create`, { name: name.value, dir_name: dir.value || undefined, parent_dir: parent.value, template: tpl.value, type: type.value, stack: stack.value || undefined, check_cmd: check.value || undefined, description: desc.value }); if (r.note) toast(r.note, 'warn', 9000); await finish(r.service); }
      catch (er) { showMsg(err, er.message); }
    }) });
    const pane = el('div', {}, el('div', { className: 'callout info small mb' }, 'Creates a new folder (never overwrites an existing one), runs git init on branch main and makes the initial commit, so task worktrees can be cut right away.'),
      el('div', { className: 'form-grid' }, field('Service name', name), field('Folder name', dir), el('div', { className: 'full' }, field('Create inside (authorized folder)', parent)), field('Template', tpl), field('Type', type), field('Stack', stack), field('Check command', check), el('div', { className: 'full' }, field('Description', desc))), err);
    pane.onshow = () => footerBtns(el('button', { className: 'btn sec', textContent: 'Close', onclick: () => m.close() }), go);
    return pane;
  }

  // ---- existing
  function buildExisting() {
    const path = el('input', { placeholder: `${(S.cfg && S.cfg.projects_parent) || '~/work'}/my-repo`, spellcheck: false });
    const name = el('input'), type = typeSel(), check = el('input', { placeholder: 'suggested from the stack' }), install = el('input', { placeholder: 'optional, e.g. npm install' });
    const info = el('div', { className: 'stack mb' }); const err = msgBox();
    const inspect = el('button', { className: 'btn sec', textContent: 'Inspect', onclick: (e) => busy(e.currentTarget, async () => {
      showMsg(err, ''); clear(info);
      try {
        const i = await api(`/projects/${project.id}/services/inspect`, { path: path.value });
        if (!name.value) name.value = i.suggested_name || ''; if (i.stack && i.stack.suggested_check_cmd && !check.value) check.value = i.stack.suggested_check_cmd;
        const rows = [chip(i.authorized ? 'inside an authorized folder' : 'NOT authorized', i.authorized ? 's-ok' : 's-failed'), i.is_git_repo ? chip(`git repo \u00B7 ${i.default_branch || 'no branch'}${i.has_commits ? '' : ' \u00B7 no commits'}`) : chip('not a git repo'), i.stack && i.stack.kind !== 'unknown' ? chip(`stack ${i.stack.kind}`) : null, i.subdir && i.subdir !== '.' ? chip(`subfolder ${i.subdir}`) : null];
        clear(info, el('div', { className: 'row' }, ...rows), i.registered_as ? el('div', { className: 'callout warn' }, `already registered as service '${i.registered_as.service}' of project '${i.registered_as.project}'`) : null, !i.authorized ? el('div', { className: 'callout bad' }, i.auth_error || 'path not allowed') : null, ...(i.warnings || []).map((w) => el('div', { className: 'callout warn small' }, w)));
      } catch (er) { showMsg(err, er.message); }
    }) });
    const add = el('button', { className: 'btn primary', textContent: 'Add service', onclick: (e) => busy(e.currentTarget, async () => {
      showMsg(err, '');
      const body = { path: path.value, name: name.value, type: type.value, check_cmd: check.value || undefined, install_cmd: install.value || undefined };
      try {
        let r; try { r = await api(`/projects/${project.id}/services/add-existing`, body); }
        catch (er) {
          if (er.data && er.data.needs_git_init) { if (!(await confirmDialog({ title: 'Not a git repository', message: 'This folder is not a git repo with commits.\n\nRun `git init -b main` and make a baseline commit of everything in it (a .gitignore is added if missing)?', confirmText: 'git init + commit' }))) return; r = await api(`/projects/${project.id}/services/add-existing`, { ...body, confirm_git_init: true }); } else throw er;
        }
        (r.warnings || []).forEach((w) => toast(w, 'warn', 8000)); await finish(r.service);
      } catch (er) { showMsg(err, er.message); }
    }) });
    const pane = el('div', {}, el('div', { className: 'callout info small mb' }, 'Registers a folder that already exists inside an authorized folder. Nothing is moved or modified (except an optional git init that you confirm). A folder inside a repo becomes a subfolder service.'),
      field('Folder path', path), el('div', { className: 'row mb' }, inspect), info,
      el('div', { className: 'form-grid' }, field('Service name', name), field('Type', type), field('Check command', check), field('Install command', install)), err);
    pane.onshow = () => footerBtns(el('button', { className: 'btn sec', textContent: 'Close', onclick: () => m.close() }), add);
    return pane;
  }
  const origShow = show; show = function () { origShow(); const p = panes[cur]; if (p && p.onshow) p.onshow(); }; // eslint-disable-line no-func-assign
  show();
  return m;
}

// ---------------------------------------------------------------- New project
export function newProjectModal({ onDone } = {}) {
  const name = el('input', { maxLength: 64, placeholder: 'my-product' }), desc = el('textarea', { style: { minHeight: '70px' }, placeholder: 'what this product is (shared with every engine as context)' });
  const root = el('input', { placeholder: `optional default folder for new repos (e.g. ${(S.cfg && S.cfg.projects_parent) || '~/work'}/my-product)` });
  const err = msgBox();
  const go = el('button', { className: 'btn primary', textContent: 'Create project', onclick: (e) => busy(e.currentTarget, async () => {
    showMsg(err, '');
    try { const r = await api('/projects', { name: name.value, description: desc.value, root_dir: root.value || undefined }); await loadProjects(); m.close(); toast(`project '${r.project.name}' created \u2013 now add its services`, 'ok'); if (onDone) onDone(r.project); else location.hash = `#/projects/${r.project.id}/services`; }
    catch (er) { showMsg(err, er.message); }
  }) });
  const m = modal({ title: 'New project', body: el('div', {}, el('div', { className: 'callout info small mb' }, 'A project is a logical product made of one or more services (git repos). Create it first, then import, create or add its services.'), field('Name', name, 'letters, digits, . _ - (no spaces)'), field('Description', desc), field('Default folder (optional)', root, 'must be inside an authorized folder'), err),
    footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close() }), go] });
}

// ---------------------------------------------------------------- Edit service
export function editServiceModal(project, s, { onDone }) {
  const f = {}; const err = msgBox();
  const inp = (k, v, ph) => (f[k] = el('input', { value: v ?? '', placeholder: ph || '' }));
  const type = select(TYPES.map((t) => [t, t]), s.type || 'other');
  const desc = el('textarea', { value: s.description || '', style: { minHeight: '70px' } });
  const env = el('textarea', { value: Object.entries(s.env_config || {}).map(([k, v]) => `${k}=${v}`).join('\n'), placeholder: 'NAME=value (non-secret only; one per line)', style: { minHeight: '60px' } });
  const go = el('button', { className: 'btn primary', textContent: 'Save', onclick: (e) => busy(e.currentTarget, async () => {
    showMsg(err, '');
    try {
      const env_config = {}; for (const line of env.value.split('\n')) { if (!line.trim()) continue; const i = line.indexOf('='); if (i < 1) throw new Error(`env line needs NAME=value: ${line}`); env_config[line.slice(0, i).trim()] = line.slice(i + 1); }
      await api(`/services/${s.id}/update`, { name: f.name.value, type: type.value, stack: f.stack.value, description: desc.value, check_cmd: f.check_cmd.value, install_cmd: f.install_cmd.value, default_branch: f.default_branch.value, env_config });
      toast('service saved', 'ok'); m.close(); await onDone();
    } catch (er) { showMsg(err, er.message); }
  }) });
  const m = modal({ title: `Edit service ${s.name}`, wide: true, body: el('div', {}, el('div', { className: 'form-grid' }, field('Name', inp('name', s.name)), field('Type', type), field('Stack', inp('stack', s.stack, 'node, python/fastapi')), field('Default branch', inp('default_branch', s.default_branch)),
    field('Check command', inp('check_cmd', s.check_cmd, 'blank = project default')), field('Install command', inp('install_cmd', s.install_cmd)), el('div', { className: 'full' }, field('Description / responsibility (the router reads this)', desc)),
    el('div', { className: 'full' }, field('Environment (non-secret only)', env, 'secrets are rejected and never stored; use your shell or keychain'))), err), footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close() }), go] });
}

// ---------------------------------------------------------------- Authorized roots card
export async function rootsCard() {
  const box = el('div', { className: 'card' });
  async function draw() {
    let roots = []; try { roots = await api('/fs/roots'); } catch (e) { clear(box, el('div', { className: 'callout bad' }, e.message)); return; }
    const inp = el('input', { placeholder: '~/work/another-folder' }); const err = msgBox();
    clear(box, el('div', { className: 'head' }, el('h3', {}, 'Authorized folders'), badge(`${roots.length}`, 'nodot')), el('div', { className: 'small dim mb' }, 'The orchestrator only reads, creates, clones into or registers folders inside these. Anything else is refused.'),
      el('table', {}, el('tbody', {}, ...roots.map((r) => el('tr', {}, el('td', {}, el('code', {}, shortPath(r.path)), r.label ? el('span', { className: 'dim' }, ` ${r.label}`) : null), el('td', { className: 'small dim' }, r.in_use ? `${r.in_use} service(s) inside` : ''), el('td', { style: { textAlign: 'right' } }, el('button', { className: 'btn sm ghost', textContent: 'Remove', onclick: async () => { if (!(await confirmDialog({ title: 'Remove folder', message: `Stop authorizing ${r.path}? Files stay untouched.`, confirmText: 'Remove', danger: true }))) return; try { await api(`/fs/roots/${r.id}/remove`, {}); toast('folder removed', 'ok'); draw(); } catch (e) { toastError(e); } } })))))),
      el('div', { className: 'row mt' }, el('div', { style: { flex: 1, minWidth: '200px' } }, inp), el('button', { className: 'btn sec', textContent: 'Authorize folder', onclick: async () => { showMsg(err, ''); try { const r = await api('/fs/roots', { path: inp.value }); (r.warnings || []).forEach((w) => toast(w, 'warn', 8000)); toast('folder authorized', 'ok'); draw(); } catch (e) { showMsg(err, e.message); } } })), err);
  }
  clear(box, el('div', { className: 'skel', style: { width: '50%' } })); await draw();
  return box;
}

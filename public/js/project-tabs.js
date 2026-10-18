// Project tabs: Context files, Memory proposals, Sequences (multi-service groups) incl. the merge-plan view.
import { el, clear, api, badge, chip, statusBadge, empty, field, select, confirmDialog, promptDialog, toast, toastError, busy, shortPath, modal } from './ui.js';
import { S, loadServices, loadMem, loadTasks, activeServices } from './state.js';
import { proposalCard } from './tasks.js';

// ---------------------------------------------------------------- context
let ctxFile = 'RULES.md';
export async function contextTab(box, ctx) {
  const p = ctx.p; await loadServices(p.id);
  const c = await api(`/projects/${p.id}/context`);
  if (!c.files.find((f) => f.name === ctxFile)) ctxFile = 'RULES.md';
  const f = c.files.find((x) => x.name === ctxFile);
  const sel = select(c.files.map((x) => [x.name, `${x.name}${x.exists ? '' : ' (not created)'}${x.repo_state ? `  \u00B7 repo: ${x.repo_state}` : ''}`]), ctxFile, { onchange: () => { ctxFile = sel.value; ctx.redraw(); } });
  const ta = el('textarea', { className: 'big', value: f.content, spellcheck: false, 'aria-label': `${f.name} content` });
  const msg = el('span', { className: 'small' });
  const act = (label, cls, fn) => el('button', { className: `btn ${cls}`, textContent: label, onclick: (e) => busy(e.currentTarget, fn) });
  const row = el('div', { className: 'row mt' },
    act('Save (managed copy)', 'primary', async () => { await api(`/projects/${p.id}/context/save`, { file: f.name, content: ta.value }); toast(`${f.name} saved`, 'ok'); }),
    f.name === 'SERVICES.md' ? act('Load generated draft', 'sec', async () => { if (!ta.value.trim() || await confirmDialog({ title: 'Replace editor text?', message: 'Load the draft generated from the services table? Nothing is saved until you click Save.', confirmText: 'Load draft' })) ta.value = c.services_draft; }) : null,
    el('span', { style: { flex: 1 } }),
    act('Import from repo', 'sec', async () => { if (!(await confirmDialog({ title: 'Import .ai/ from repo', message: 'Overwrite the managed copy with the .ai/ files from the default branch of the configured service?', confirmText: 'Overwrite managed copy', danger: true }))) return; const r = await api(`/projects/${p.id}/context/import`, {}); toast(r.note || 'imported', 'ok', 7000); ctx.redraw(); }),
    act('Export to repo (review branch)', 'sec', async () => { if (!(await confirmDialog({ title: 'Export .ai/', message: `Commit the managed context files to .ai/ on a NEW branch from ${c.default_branch || 'the default branch'} and create a review task? Nothing is merged without your approval.`, confirmText: 'Create branch + review task' }))) return; const r = await api(`/projects/${p.id}/context/export`, {}); toast(r.changed ? `branch ${r.branch}, review task #${r.task.id}` : r.message, r.changed ? 'ok' : 'info', 8000); await loadTasks(); }), msg);
  // preview
  const ps = select([['', 'no service'], ...activeServices(p.id).map((s) => [s.id, s.name])]), pp = el('input', { placeholder: 'task text (selects relevant MEMORY entries)' }), po = el('pre', { className: 'plain', style: { display: 'none', maxHeight: '320px', overflow: 'auto' } });
  clear(box,
    el('div', { className: 'callout info small mb' }, `Shared context for ALL engines (local and Cursor). Managed copy: ${shortPath(c.dir)}. Saving updates only the managed copy (used by the next task). The repo's .ai/ folder is touched only if you opt in (Settings) and then only through a review branch.`),
    el('div', { className: 'card' }, el('div', { className: 'row mb' }, el('div', { style: { minWidth: '280px' } }, sel)), ta, row),
    el('details', { className: 'card mt' }, el('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Preview the context bundle an engine would receive'),
      el('div', { className: 'row mt' }, ps, el('div', { style: { flex: 1, minWidth: '220px' } }, pp), el('button', { className: 'btn sec', textContent: 'Preview', onclick: (e) => busy(e.currentTarget, async () => { const r = await api(`/projects/${p.id}/context/preview`, { service_id: ps.value || null, prompt: pp.value }); po.style.display = ''; po.textContent = `${r.manifest.total_chars}/${r.manifest.max_chars} chars; parts: ${r.manifest.parts.map((x) => `${x.name} ${x.chars}${x.truncated ? ' (truncated)' : ''}`).join(', ')}\n\n${r.text}`; }) })), po));
}

// ---------------------------------------------------------------- memory
export async function memoryTab(box, ctx) {
  const p = ctx.p;
  async function draw() {
    await loadMem(); const mine = S.memProps.filter((m) => m.project_id === p.id);
    clear(box, el('div', { className: 'small dim mb' }, 'After a task reaches review the local model drafts 1\u20135 notes. They are appended to MEMORY.md only when you approve. Approved entries become context for later tasks.'),
      mine.length ? el('div', { className: 'stack' }, ...mine.map((m) => proposalCard(m, async () => { await draw(); ctx.refreshProject(); }, false))) : empty({ icon: '\u270E', title: 'No memory proposals', text: 'They appear here after tasks reach review.' }));
  }
  await draw();
}

// ---------------------------------------------------------------- sequences
const DEP_HELP = {
  stack: 'stack \u2013 each step is cut from the previous step\'s branch once it passed its checks (same repo only; merge them in order)',
  merged: 'merged \u2013 a step waits until the previous step is merged into the default branch',
  independent: 'independent \u2013 steps do not depend on each other (default for steps in different repositories)',
};
export async function sequencesTab(box, ctx) {
  const p = ctx.p; await loadServices(p.id);
  let groups = []; try { groups = await api(`/groups?project_id=${p.id}`); } catch (e) { box.append(el('div', { className: 'callout bad' }, e.message)); }
  const redo = async () => { await loadTasks(); ctx.redraw(); };
  const list = el('div', { className: 'stack' });
  for (const g of groups) list.append(groupCard(g, redo));
  clear(box, el('div', { className: 'callout info small mb' }, 'A sequence is a list of steps, usually one per service. Each step is its own task, branch, check and review; one start approval covers the whole sequence. Steps in different repositories are independent (no atomic cross-repo merge \u2013 you approve each merge).'),
    groups.length ? list : empty({ icon: '\u21E2', title: 'No sequences yet', text: 'Create one below to coordinate a change across services.' }), createForm(p, redo));
}
/** What one start approval of the whole sequence will cause on Cursor (counted, not capped: this sentence is the only brake before the fan-out). */
function cursorRunsText(g) {
  const n = g.cursor_runs_pending || 0, steps = g.steps.filter((s) => s.status === 'pending');
  const parts = steps.filter((s) => s.cursor_runs_on_start).map((s) => `step ${s.step_no}: ${s.cursor_runs_on_start} (${[s.engine === 'cursor' ? 'implementation' : null, s.plan_first ? 'plan' : null, s.ai_review ? 'AI review' : null].filter(Boolean).join(' + ')})`);
  const auto = steps.some((s) => s.engine === 'auto');
  return `All ${steps.length} pending step(s) will be started in order. ` + (n ? `This will start ${n} Cursor run${n === 1 ? '' : 's'} on Cursor servers and uses your Pro usage \u2013 ${parts.join('; ')}.` : 'This will start 0 Cursor runs (local steps only).')
    + (auto ? ' Steps with engine "auto" run locally first; escalating to Cursor needs a separate click.' : '');
}
/** Cursor usage counters (read-only; there is no cap). projectId=null: one row per project + total; else just that project. */
export async function cursorUsageCard({ projectId = null } = {}) {
  let u; try { u = await api('/cursor/usage'); } catch (e) { return el('div', { className: 'callout bad small' }, `Cursor usage: ${e.message}`); }
  const rows = u.by_project.filter((r) => projectId === null || r.project_id === projectId);
  const sel = projectId === null ? null : rows[0];
  const cell = (b) => `${b.tasks} task${b.tasks === 1 ? '' : 's'} \u00B7 ${b.runs} run${b.runs === 1 ? '' : 's'}`;
  const n = (v, w) => `${v} ${w}${v === 1 ? '' : 's'}`;
  const extra = (b) => `${n(b.plans, 'plan')}, ${n(b.reviews, 'review')}, ${n(b.sessions, 'session')}`;
  const tr = (label, r, bold) => el('tr', {}, el('td', {}, bold ? el('b', {}, label) : label), el('td', {}, cell(r.today)), el('td', {}, cell(r.total)), el('td', { className: 'small dim' }, extra(r.total)));
  const body = projectId === null ? [...rows.map((r) => tr(r.project_id === null ? '(unattributed / older)' : `${r.name || '#' + r.project_id}${r.deleted && r.project_id !== null ? ' (deleted)' : ''}`, r)), tr('All projects', u, true)]
    : [tr(sel ? 'This project' : 'This project (no Cursor runs yet)', sel || { today: emptyUsage(), total: emptyUsage() })];
  return el('div', { className: 'card' }, el('h3', {}, 'Cursor usage'),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, projectId === null ? 'Project' : ''), el('th', {}, 'Today'), el('th', {}, 'Total'), el('th', {}, 'Total: plans / reviews / sessions'))), el('tbody', {}, ...body)),
    el('div', { className: 'small dim mt' }, 'Counted, not capped. "Tasks" = distinct tasks with an implementation or plan run; "runs" = Cursor CLI invocations (implementation + plan + review). Every run still needs your approval click.'));
}
const emptyUsage = () => ({ tasks: 0, runs: 0, plans: 0, reviews: 0, sessions: 0 });
function groupCard(g, redo) {
  const c = el('div', { className: 'card' }, el('div', { className: 'head' }, el('h3', {}, `#${g.id} ${g.title}`), badge(g.dependency, 'nodot'), g.steps.every((s) => s.status === 'done') ? badge('complete', 's-done') : null));
  const tl = el('div', { className: 'stack' });
  for (const s of g.steps) tl.append(el('div', { className: 'row' }, el('span', { className: 'chip mono' }, `${s.step_no}`), statusBadge(s.status), el('a', { href: `#/tasks/${s.id}`, textContent: `#${s.id} ${s.title}` }), chip(s.service_name || 'no service'), chip(s.engine), s.supervised ? badge('SUPERVISED', 's-awaiting_escalation') : null));
  c.append(tl);
  const pending = g.steps.some((s) => s.status === 'pending');
  const row = el('div', { className: 'row mt' });
  if (pending) row.append(el('button', { className: 'btn ok', textContent: 'Approve start of all pending steps', onclick: async (e) => { if (!(await confirmDialog({ title: 'Approve the whole sequence?', message: cursorRunsText(g), confirmText: 'Approve & start' }))) return; await busy(e.currentTarget, async () => { await api(`/groups/${g.id}/approve-start`, {}); toast('sequence approved', 'ok'); await redo(); }); } }),
    el('button', { className: 'btn bad', textContent: 'Reject', onclick: async () => { const r = await promptDialog({ title: 'Reject sequence', label: 'Reason (required)', multiline: true, confirmText: 'Reject' }); if (!r) return; try { await api(`/groups/${g.id}/reject`, { reason: r }); toast('sequence rejected', 'ok'); await redo(); } catch (er) { toastError(er); } } }));
  if (g.steps.some((s) => s.status === 'review' || s.status === 'done')) row.append(el('button', { className: 'btn sec', textContent: 'Merge plan', onclick: (e) => busy(e.currentTarget, () => mergePlanModal(g)) }));
  if (row.children.length) c.append(row);
  return c;
}
async function mergePlanModal(g) {
  const plan = await api(`/groups/${g.id}/merge-plan`);
  modal({ title: `Merge plan \u2013 ${plan.title}`, wide: true, body: el('div', { className: 'stack' },
    el('div', { className: 'row' }, badge(plan.dependency, 'nodot'), plan.cross_repo ? chip(`${plan.repos.length} repositories`, 's-awaiting_escalation') : chip('single repository'), plan.all_ready ? badge('ready to merge', 's-done') : badge('not all ready', 's-pending')),
    el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Step'), el('th', {}, 'Service'), el('th', {}, 'Branch'), el('th', {}, 'State'), el('th', {}, 'Problem'))),
      el('tbody', {}, ...plan.steps.map((s) => el('tr', {}, el('td', {}, el('a', { href: `#/tasks/${s.task_id}`, textContent: `${s.step_no}: #${s.task_id} ${s.title}`, onclick: () => document.querySelector('.overlay') && document.querySelector('.overlay').remove() })), el('td', {}, s.service_name || '-'), el('td', {}, el('code', {}, s.branch || '-')), el('td', {}, badge(s.state, s.state === 'ready' ? 's-done' : s.state === 'merged' ? 's-done' : 's-failed')), el('td', { className: 'small dim' }, s.problem || ''))))),
    el('div', { className: 'callout warn small' }, plan.note)), footer: [] });
}
function createForm(p, redo) {
  const act = activeServices(p.id);
  const title = el('input', { placeholder: 'e.g. Add billing endpoint and its web page' });
  const dep = select([['independent', DEP_HELP.independent], ['stack', DEP_HELP.stack], ['merged', DEP_HELP.merged]], act.length && new Set(act.map((s) => s.local_path)).size > 1 ? 'independent' : 'stack');
  const stepsBox = el('div', { className: 'stack' }), rows = [];
  const addStep = () => {
    const sv = select([['', act.length ? '\u2014 choose a service \u2014' : 'no services yet'], ...act.map((s) => [s.id, s.name])], act.length ? String(act[Math.min(rows.length, act.length - 1)].id) : '');
    const en = select([['local', 'local'], ['auto', 'auto'], ['cursor', 'cursor']], 'local');
    const st = el('input', { placeholder: 'step title (optional)' }), pr = el('textarea', { placeholder: 'step prompt', style: { minHeight: '64px' } }), fl = el('input', { placeholder: 'files, comma separated (relative to the service folder)' });
    rows.push({ sv, en, st, pr, fl });
    stepsBox.append(el('div', { className: 'card flat' }, el('b', {}, `Step ${rows.length}`), el('div', { className: 'form-grid mt' }, field('Service', sv), field('Engine', en), el('div', { className: 'full' }, field('Title', st)), el('div', { className: 'full' }, field('Prompt', pr)), el('div', { className: 'full' }, field('Files', fl)))));
  };
  addStep(); addStep();
  const err = el('div', { className: 'callout bad', style: { display: 'none' } });
  return el('div', { className: 'card mt' }, el('h3', {}, 'New sequence'), el('div', { className: 'mt' }, field('Title', title), field('Dependency between steps', dep, 'stack across different repositories is rejected \u2013 use independent or merged')), stepsBox,
    err, el('div', { className: 'row mt' }, el('button', { className: 'btn sec', textContent: '+ Add step', onclick: () => { if (rows.length < 8) addStep(); } }),
      el('button', { className: 'btn primary', textContent: 'Create sequence (nothing starts yet)', onclick: (e) => busy(e.currentTarget, async () => {
        err.style.display = 'none';
        try { await api(`/projects/${p.id}/groups`, { title: title.value, dependency: dep.value, steps: rows.filter((r) => r.pr.value.trim()).map((r) => ({ service_id: r.sv.value, engine: r.en.value, title: r.st.value, prompt: r.pr.value, files: r.fl.value })) }); toast('sequence created', 'ok'); await redo(); }
        catch (er) { err.textContent = er.message; err.style.display = ''; }
      }) })));
}

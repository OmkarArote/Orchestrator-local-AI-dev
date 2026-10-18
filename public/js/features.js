// Cross-repo Features: list + create, and a per-feature page (step graph, contract, drift, merge order, override-with-reason dialog).
// A feature groups tasks across projects/services: the PROVIDER step runs first, its API contract is shared with the CONSUMER steps.
// Every existing gate stays (start approval, plan-first, escalation, human merge); nothing here starts or merges anything by itself.
import { el, clear, api, badge, chip, statusBadge, empty, skeletonLines, field, select, modal, promptDialog, confirmDialog, toast, toastError, busy, ago } from './ui.js';
import { S, loadProjects, loadServices, activeServices, projName } from './state.js';

const FSTATUS = { draft: 's-pending', contract_pending: 's-awaiting_approval', planned: 's-pending', running: 's-running', contract_drift: 's-awaiting_escalation', review: 's-review', done: 's-done', failed: 's-failed', cancelled: 's-rejected' };
const FLABEL = { contract_pending: 'contract pending', contract_drift: 'contract drift' };
const featureBadge = (s) => badge(FLABEL[s] || s, FSTATUS[s] || '');
const MIN_REASON = 8;

// ---------------------------------------------------------------- override dialog (typed reason; no native dialogs)
/** Used by the feature page and by the task page when a merge is refused by the merge-order guard. Resolves true when the merge happened. */
export function overrideDialog({ taskId, providerTaskId, providerStatus, message }) {
  return new Promise((resolve) => {
    const ta = el('textarea', { placeholder: 'Why is it safe to merge the consumer before the provider is merged? (recorded with the feature)', 'aria-label': 'override reason', style: { minHeight: '90px' } });
    const hint = el('div', { className: 'hint', textContent: `${MIN_REASON} characters minimum.` });
    const go = el('button', { className: 'btn bad primary', textContent: 'Merge anyway (record override)', disabled: true });
    ta.addEventListener('input', () => { go.disabled = ta.value.trim().length < MIN_REASON; });
    const m = modal({
      title: 'Merge before the provider?',
      body: el('div', { className: 'stack' },
        el('div', { className: 'callout warn', textContent: message || `The provider step #${providerTaskId} is '${providerStatus}', not merged yet.` }),
        el('div', { className: 'small dim', textContent: 'Contract-first order is: provider merged, then consumers. Merging a consumer first can leave the default branch calling an API that does not exist yet. Normally: merge the provider step first. If you override, your reason is stored in the database (feature artifacts, approvals and the task log).' }),
        el('div', {}, el('label', {}, 'Reason (required)'), ta, hint)),
      footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close(false) }), go],
      onClose: (v) => resolve(v === true),
    });
    go.addEventListener('click', () => busy(go, async () => {
      await api(`/tasks/${taskId}/approve-merge`, { override_reason: ta.value.trim() });
      toast('merged with a recorded merge-order override', 'ok', 6000);
      m.close(true);
    }));
  });
}

// ---------------------------------------------------------------- create
function stepEditor(role, idx, owner) {
  const proj = select([['', 'choose project'], ...S.projects.filter((p) => !p.archived).map((p) => [String(p.id), p.name])], owner ? String(owner) : '', { 'aria-label': `${role} project` });
  const svc = select([['', 'choose service']], '', { 'aria-label': `${role} service` });
  const title = el('input', { placeholder: role === 'provider' ? 'e.g. Add the invoices API' : 'e.g. Show invoices in the web app', 'aria-label': `${role} title` });
  const prompt = el('textarea', { placeholder: role === 'provider' ? 'What to build in the provider service (the contract above is the spec)' : 'What to build in the consumer service (it receives the contract and the provider\u2019s implementation summary)', 'aria-label': `${role} instructions` });
  const engine = select([['local', 'local (free)'], ['cursor', 'cursor (cloud, asks you)'], ['auto', 'auto (local, escalate on approval)']], 'local', { 'aria-label': `${role} engine` });
  const plan = el('input', { type: 'checkbox', 'aria-label': `${role} plan first` });
  const files = el('input', { placeholder: 'optional: files, comma separated', 'aria-label': `${role} files` });
  const fillServices = async () => {
    clear(svc, el('option', { value: '', textContent: 'choose service' }));
    if (!proj.value) return;
    await loadServices(proj.value);
    for (const s of activeServices(proj.value)) svc.append(el('option', { value: s.id, textContent: `${s.name}${s.path && s.path !== '.' ? ' (' + s.path + ')' : ''}` }));
    const a = activeServices(proj.value); if (a.length === 1) svc.value = String(a[0].id);
  };
  proj.addEventListener('change', fillServices); fillServices();
  const node = el('div', { className: 'card stack feat-step' },
    el('div', { className: 'row' }, badge(role === 'provider' ? 'PROVIDER \u2022 step 1' : `CONSUMER \u2022 step ${idx}`, role === 'provider' ? 's-running' : 's-review'), el('span', { className: 'small dim', textContent: role === 'provider' ? 'runs first; produces the API' : 'starts after the provider reached review' })),
    el('div', { className: 'row' }, field('Project', proj), field('Service', svc), field('Engine', engine)),
    field('Title', title), field('Instructions', prompt), el('div', { className: 'row' }, field('Files', files), el('label', { className: 'row small' }, plan, 'plan first (cursor only)')));
  return { node, get: () => ({ project_id: Number(proj.value) || undefined, service_id: svc.value ? Number(svc.value) : undefined, title: title.value.trim(), prompt: prompt.value.trim(), engine: engine.value, plan_first: plan.checked && engine.value === 'cursor',
    files: files.value.split(',').map((x) => x.trim()).filter(Boolean) }) };
}

function createModal(onCreated) {
  const owner = select(S.projects.filter((p) => !p.archived).map((p) => [String(p.id), p.name]), '', { 'aria-label': 'owner project' });
  const title = el('input', { placeholder: 'e.g. Invoices', 'aria-label': 'feature title' });
  const brief = el('textarea', { placeholder: 'What should exist when this feature is done, across the services?', 'aria-label': 'feature brief' });
  const contract = el('textarea', { className: 'mono', style: { minHeight: '120px' }, 'aria-label': 'api contract', placeholder: 'API contract the provider must implement and the consumers rely on, e.g.\nPOST /invoices -> 201 {id, total}\nGET /invoices/{id} -> 200 {id, total, lines[]}' });
  const stepsHost = el('div', { className: 'stack' });
  const steps = [stepEditor('provider', 1, null), stepEditor('consumer', 2, null)];
  const redraw = () => clear(stepsHost, ...steps.map((s) => s.node));
  redraw();
  const msg = el('div', { className: 'hint t-bad', role: 'alert' });
  const add = el('button', { className: 'btn sm sec', textContent: '+ consumer step', onclick: () => { if (steps.length >= 8) return; steps.push(stepEditor('consumer', steps.length + 1, null)); redraw(); } });
  const go = el('button', { className: 'btn primary', textContent: 'Create feature (nothing starts yet)' });
  const m = modal({ title: 'New cross-repo feature', wide: true,
    body: el('div', { className: 'stack' },
      el('div', { className: 'small dim', textContent: 'Contract-first: you write (or later correct) the API contract, approve it, then approve the start. The provider task runs first; its real API is extracted from its diff and handed to the consumers. You still approve plans, escalations and every merge.' }),
      el('div', { className: 'row' }, field('Owner project', owner, 'only used to list the feature'), field('Title', title)), field('Brief', brief), field('API contract (optional now, required before start)', contract), stepsHost, el('div', {}, add), msg),
    footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close() }), go] });
  go.addEventListener('click', () => busy(go, async () => {
    msg.textContent = '';
    try {
      const f = await api('/features', { project_id: Number(owner.value), title: title.value.trim(), brief: brief.value.trim(), contract: contract.value.trim() || undefined, steps: steps.map((s) => s.get()) });
      toast(`feature #${f.id} created; approve the contract, then start`, 'ok', 6000); m.close(); onCreated(f);
    } catch (e) { msg.textContent = e.message; }
  }));
}

// ---------------------------------------------------------------- list
async function renderList(main) {
  const host = el('div', { className: 'stack' }, skeletonLines(3));
  clear(main, el('div', { className: 'row' }, el('h1', { textContent: 'Features' }), el('span', { style: { flex: 1 } }), el('button', { className: 'btn primary', textContent: 'New feature', onclick: () => createModal((f) => { location.hash = `#/features/${f.id}`; }) })),
    el('div', { className: 'small dim mb', textContent: 'A feature spans several projects/services (e.g. create an API in service A, integrate it in the frontend repo B): provider first, contract shared, merge order guarded.' }), host);
  const draw = async () => {
    try {
      const list = await api('/features');
      clear(host, list.length ? el('div', { className: 'stack' }, ...list.map((f) => el('a', { className: 'card feat-row', href: `#/features/${f.id}` },
        el('div', { className: 'row' }, el('b', { textContent: `#${f.id} ${f.title}` }), featureBadge(f.status), el('span', { style: { flex: 1 } }), chip(`owner ${projName(f.project_id)}`)),
        el('div', { className: 'row small' }, ...f.steps.map((s) => el('span', { className: 'row' }, badge(`${s.role === 'provider' ? 'P' : 'C'}${s.step_no}`, 'nodot'), ` ${s.project}/${s.service} `, statusBadge(s.status)))),
        f.drift ? el('div', { className: 'callout warn small', textContent: 'contract drift: the provider built something else than the contract' }) : null)))
        : empty({ icon: 'arrows-exchange', title: 'No features yet', text: 'Create one to coordinate a provider service and its consumers.' }));
    } catch (e) { clear(host, el('div', { className: 'callout bad', textContent: e.message })); }
  };
  await draw();
  const t = setInterval(draw, 4000);
  return () => clearInterval(t);
}

// ---------------------------------------------------------------- detail
const pre = (text, extra = {}) => el('pre', { className: 'plain feat-pre', tabIndex: 0, ...extra, textContent: text });

async function renderDetail(main, id) {
  const host = el('div', { className: 'stack' }, skeletonLines(5));
  clear(main, host);
  let f = null, openProposal = '';
  const post = async (path, body, okMsg) => { try { f = await api(`/features/${id}/${path}`, body); if (okMsg) toast(okMsg, 'ok'); draw(); } catch (e) { toastError(e); } };

  function stepCard(s) {
    const gate = s.gate && s.gate.state === 'wait' ? 'waiting' : s.gate && s.gate.state === 'blocked' ? s.gate.why : null;
    const failed = ['failed', 'rejected'].includes(s.status);
    return el('div', { className: `card feat-node ${s.role}` },
      el('div', { className: 'row' }, badge(s.role === 'provider' ? 'PROVIDER' : 'CONSUMER', s.role === 'provider' ? 's-running' : 's-review'), statusBadge(s.status), el('span', { style: { flex: 1 } }), el('a', { href: `#/tasks/${s.id}`, textContent: `task #${s.id}` })),
      el('div', {}, el('b', { textContent: `${s.project} / ${s.service}` })), el('div', { className: 'small', textContent: s.title }),
      el('div', { className: 'row small' }, chip(s.engine === 'local' ? 'local' : s.engine), s.plan_first ? chip('plan first') : null, s.branch ? chip(s.branch, 'mono') : null),
      s.status === 'approved' && gate ? el('div', { className: 'small dim', textContent: gate === 'waiting' ? 'waiting for the contract / provider' : gate }) : null,
      s.merge_blocked ? el('div', { className: 'small t-warn', textContent: `cannot merge before provider #${s.merge_blocked.provider_task_id} (${s.merge_blocked.provider_status})` }) : null,
      failed ? el('div', { className: 'row' }, s.summary ? el('div', { className: 'small t-bad', textContent: s.summary.slice(-160) }) : null,
        el('button', { className: 'btn sm', textContent: 'Retry step', title: 'Creates a NEW pending task; you approve the start again', onclick: (e) => busy(e.currentTarget, () => post('retry-step', { task_id: s.id }, 'retry queued (pending: approve the start)')) })) : null);
  }

  function graph() {
    const prov = f.steps.find((s) => s.role === 'provider'), cons = f.steps.filter((s) => s.role === 'consumer');
    return el('div', { className: 'feat-graph', role: 'group', 'aria-label': 'step graph' },
      prov ? stepCard(prov) : el('div', { className: 'card dim', textContent: 'provider step removed' }),
      el('div', { className: 'feat-arrow', title: 'contract', 'aria-hidden': 'true' }, el('div', { textContent: '\u2192' }), el('div', { className: 'small', textContent: f.contract.approved_version ? `contract v${f.contract.approved_version}` : 'no approved contract' })),
      el('div', { className: 'stack' }, ...cons.map(stepCard)));
  }

  function contractCard() {
    const approved = f.contracts.find((c) => c.version === f.contract.approved_version && c.status === 'approved');
    const proposed = f.contracts.find((c) => c.version === f.contract.proposed_version && c.status === 'proposed');
    const open = !['done', 'cancelled'].includes(f.status);
    const ta = el('textarea', { className: 'mono', style: { minHeight: '110px' }, 'aria-label': 'new contract version', placeholder: 'Propose a new contract version (it must be approved before anything new starts)', value: openProposal, oninput: () => { openProposal = ta.value; } });
    return el('div', { className: 'card stack' },
      el('div', { className: 'row' }, el('h3', { textContent: 'API contract' }), approved ? badge(`v${approved.version} approved${approved.source === 'extracted' ? ' (from provider)' : ''}`, 's-ok') : badge('not approved', 's-awaiting_approval'), proposed ? badge(`v${proposed.version} proposed`, 's-review') : null),
      approved ? pre(approved.content, { 'aria-label': 'approved contract' }) : el('div', { className: 'small dim', textContent: 'Nothing approved yet. Nothing can start without an approved contract.' }),
      proposed ? el('div', { className: 'stack' }, el('b', { textContent: `Proposed v${proposed.version} (waiting for your approval)` }), pre(proposed.content, { 'aria-label': 'proposed contract' }),
        el('button', { className: 'btn ok primary', textContent: `Approve contract v${proposed.version}`, onclick: (e) => busy(e.currentTarget, () => post('approve-contract', { version: proposed.version }, `contract v${proposed.version} approved`)) })) : null,
      open ? el('div', { className: 'stack' }, ta, el('div', { className: 'row' }, el('button', { className: 'btn sm sec', textContent: 'Save as new proposed version', onclick: (e) => { if (!ta.value.trim()) return toast('contract text required', 'bad'); busy(e.currentTarget, async () => { const v = ta.value; await post('contract', { content: v }, 'new contract version proposed (approve it to use it)'); openProposal = ''; }); } }))) : null,
      f.contracts.length > 1 ? el('details', {}, el('summary', { textContent: `History (${f.contracts.length} versions)` }), ...f.contracts.map((c) => el('div', { className: 'stack' }, el('div', { className: 'small', textContent: `v${c.version} ${c.status} \u2022 ${c.source} \u2022 ${ago(c.created_at)}` }), pre(c.content)))) : null);
  }

  function driftCard() {
    if (!f.drift) return null;
    return el('div', { className: 'callout warn stack', role: 'alert' },
      el('b', { textContent: 'Contract drift: the provider\u2019s implementation differs from the approved contract' }),
      el('div', { className: 'small', textContent: `Missing in the implementation: ${f.drift.missing.join(', ') || '-'}.  Not in the contract: ${f.drift.extra.join(', ') || '-'}.` }),
      el('div', { className: 'small dim', textContent: 'Consumers wait. Either the provider must be fixed (retry the step), or you accept what was built as the new contract, or you keep the contract and ignore the drift with a reason.' }),
      el('div', { className: 'row' }, el('button', { className: 'btn ok', textContent: 'Accept provider\u2019s API as the contract', onclick: (e) => busy(e.currentTarget, () => post('accept-actual', {}, 'accepted as the new contract')) }),
        el('button', { className: 'btn sec', textContent: 'Ignore drift\u2026', onclick: async () => { const r = await promptDialog({ title: 'Ignore contract drift', label: `Reason (at least ${MIN_REASON} characters, recorded)`, multiline: true, confirmText: 'Ignore drift' }); if (r) await post('ignore-drift', { reason: r }, 'drift ignored (recorded)'); } })));
  }

  function actualCard() {
    const a = [...f.actuals].reverse().find((x) => x.status !== 'superseded');
    if (!a) return el('div', { className: 'card' }, el('h3', { textContent: 'Provider\u2019s actual API' }), el('div', { className: 'small dim', textContent: 'Extracted from the provider\u2019s diff when it reaches review (deterministic, no LLM). Not available yet.' }));
    return el('div', { className: 'card stack' }, el('div', { className: 'row' }, el('h3', { textContent: 'Provider\u2019s actual API' }), chip(`v${a.version} \u2022 from task #${a.task_id}`)), f.last_compare ? el('div', { className: 'small dim', textContent: f.last_compare.comparable ? (f.last_compare.drift ? 'differs from the contract' : 'matches the contract') : 'the contract names no endpoints: not compared automatically' }) : null, pre(a.content, { 'aria-label': 'actual api' }));
  }

  function mergeCard() {
    return el('div', { className: 'card stack' }, el('h3', { textContent: 'Merge order' }),
      el('div', { className: 'small dim', textContent: 'Provider first. A consumer cannot be merged before its provider is merged; the only way around is a typed, recorded reason. Merging itself happens on each task (human click, never automatic).' }),
      ...f.merge_order.map((m) => el('div', { className: 'row' }, badge(m.role === 'provider' ? 'P' : 'C', 'nodot'), el('span', { textContent: `${m.service} \u2022 task #${m.task_id}` }), statusBadge(m.status),
        m.merged ? badge('merged', 's-done') : m.order_ok ? (m.status === 'review' ? badge('ready to merge', 's-ok') : null) : badge(`blocked by provider #${m.blocked_by}`, 's-awaiting_approval'), m.overridden ? badge('merged with override', 's-failed') : null, el('span', { style: { flex: 1 } }),
        m.status === 'review' ? el('a', { className: 'btn sm sec', href: `#/tasks/${m.task_id}`, textContent: 'Open task to review/merge' }) : null,
        m.status === 'review' && !m.order_ok ? el('button', { className: 'btn sm bad', textContent: 'Merge anyway\u2026', onclick: async () => { if (await overrideDialog({ taskId: m.task_id, providerTaskId: m.blocked_by, providerStatus: (f.steps.find((x) => x.id === m.blocked_by) || {}).status })) { await refresh(); } } }) : null)),
      f.overrides.length ? el('div', { className: 'stack' }, el('b', { textContent: 'Recorded overrides' }), ...f.overrides.map((o) => el('div', { className: 'callout warn small', textContent: `task #${o.task_id} merged before provider #${o.provider_task_id} (${o.provider_status}) \u2022 ${ago(o.at)}: ${o.reason}` }))) : null);
  }

  function startCard() {
    const pending = f.steps.filter((s) => s.status === 'pending').length;
    const cloud = f.steps.some((s) => s.status === 'pending' && s.engine !== 'local');
    const why = !f.contract.approved_version ? 'Approve the contract first.' : f.contract.proposed_version ? 'A newer contract version is waiting for approval.' : !pending ? 'No pending steps.' : '';
    return el('div', { className: 'card stack' }, el('h3', { textContent: 'Start' }),
      el('div', { className: 'small dim', textContent: 'One click approves the start of every pending step (like a sequence). The provider runs first; consumers start when the provider reached review with a matching contract. Plans, escalations and merges still need your clicks.' }),
      el('div', { className: 'row' },
        el('button', { className: 'btn ok primary', textContent: `Approve start (${pending} step${pending === 1 ? '' : 's'})`, disabled: !!why, title: why || '', onclick: async (e) => {
          if (cloud && !(await confirmDialog({ title: 'Approve start', message: 'Some steps use Cursor (cloud) and may use your Pro usage. Start the feature?', confirmText: 'Approve start' }))) return;
          await busy(e.currentTarget, () => post('start', {}, 'start approved')); } }),
        !['done', 'cancelled'].includes(f.status) ? el('button', { className: 'btn bad', textContent: 'Cancel feature\u2026', onclick: async () => { const r = await promptDialog({ title: 'Cancel feature', label: 'Reason (required). Steps that have not started are rejected; running ones are left alone.', multiline: true, confirmText: 'Cancel feature' }); if (r) await post('cancel', { reason: r }, 'feature cancelled'); } }) : null,
        why ? el('span', { className: 'small dim', textContent: why }) : null));
  }

  async function refresh() { try { f = await api(`/features/${id}`); draw(); } catch (e) { clear(host, el('div', { className: 'callout bad', role: 'alert', textContent: e.message })); } }
  function draw() {
    const keep = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label') === 'new contract version';
    if (keep) return; // never wipe a half-typed contract proposal during auto-refresh
    clear(host,
      el('div', { className: 'row' }, el('a', { href: '#/features', className: 'btn sm sec', textContent: '\u2190 Features' }), el('h1', { textContent: `#${f.id} ${f.title}` }), featureBadge(f.status), chip(`owner ${projName(f.project_id)}`)),
      f.brief ? el('div', { className: 'small', style: { whiteSpace: 'pre-wrap' }, textContent: f.brief }) : null,
      driftCard(), graph(), startCard(), contractCard(), actualCard(), mergeCard(),
      f.history.length ? el('div', { className: 'small dim', textContent: `Replaced (retried) steps kept as history: ${f.history.map((h) => `#${h.id} ${h.status}`).join(', ')}` }) : null);
  }
  await refresh();
  const t = setInterval(() => { api(`/features/${id}`).then((x) => { f = x; draw(); }).catch(() => {}); }, 3500);
  return () => clearInterval(t);
}

export async function render(main, r) {
  if (!S.projects.length) await loadProjects().catch(() => {});
  return r.id ? renderDetail(main, r.id) : renderList(main);
}

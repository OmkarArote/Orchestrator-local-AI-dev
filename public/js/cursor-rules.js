// Cursor rules (.cursor/rules/*.mdc + AGENTS.md pointer) per service: status, opt-in, read-only preview with diff, and an explicit approve that
// commits ONLY on a new review branch. Used in the project Settings tab (all services) and in a per-service modal.
import { el, clear, api, badge, chip, modal, toast, toastError, busy, skeletonLines } from './ui.js';

const STATUS = { in_sync: ['in sync', 's-ok'], stale: ['stale', 's-awaiting_approval'], not_generated: ['not generated', 's-pending'], blocked: ['blocked', 's-failed'], unavailable: ['unavailable', 's-failed'] };
const STATE = { new: ['new file', 's-ok'], changed: ['will be updated', 's-awaiting_approval'], same: ['unchanged', 's-pending'], hand_written: ['hand-written: left alone', 's-archived'], blocked: ['blocked', 's-failed'] };
export const rulesStatusBadge = (st) => { const [t, c] = STATUS[st] || [st, '']; return badge(t, c); };

/** Unified-diff-like view, text only (no HTML from repo/model content). */
function diffView(lines) {
  const pre = el('pre', { className: 'rules-diff', tabIndex: 0, 'aria-label': 'diff' });
  for (const l of lines || []) pre.append(el('span', { className: l.t === '+' ? 'd-add' : l.t === '-' ? 'd-del' : l.t === '@' ? 'd-gap' : 'd-ctx', textContent: `${l.t === '@' ? '' : l.t} ${l.s}\n` }));
  return pre;
}

/** Render a preview. approve=true adds the explicit approve button (the only thing that writes anything). */
function previewView(p, svc, pv, { approve, onDone }) {
  const writable = pv.files.filter((f) => f.state === 'new' || f.state === 'changed');
  const box = el('div', { className: 'stack' },
    el('div', { className: 'row small' }, rulesStatusBadge(pv.status), chip(`base ${pv.base.branch}@${pv.base.sha}`, 'mono'), chip(`always-on ~${pv.stats.always_tokens} tokens`), chip(`commit as ${pv.commit_identity}`, 'mono'),
      pv.pending_branches.length ? badge(`${pv.pending_branches.length} review branch(es) waiting`, 's-review') : null),
    ...pv.warnings.map((w) => el('div', { className: 'callout warn small', textContent: w })), ...pv.notes.map((n) => el('div', { className: 'small dim', textContent: n })),
    ...pv.files.map((f) => el('details', { className: 'rules-file', open: f.state === 'new' || f.state === 'changed' },
      el('summary', {}, badge(STATE[f.state] ? STATE[f.state][0] : f.state, STATE[f.state] ? STATE[f.state][1] : ''), ' ', el('code', { textContent: f.dest }), el('span', { className: 'small dim', textContent: ` ${f.always ? 'always on' : f.globs ? `globs ${f.globs}` : f.kind === 'agents' ? 'pointer' : 'on request'} \u00b7 ~${f.tokens} tokens` })),
      f.note ? el('div', { className: 'small t-warn', textContent: f.note }) : null,
      f.state === 'changed' || f.state === 'new' ? diffView(f.diff) : el('pre', { className: 'rules-diff', textContent: f.content }))));
  if (approve) {
    const blockedWhy = !pv.enabled ? 'Enable Cursor rules for this service first (opt-in).' : pv.files.some((f) => f.state === 'blocked') ? 'Blocked: see the files above.' : !writable.length ? 'Nothing to write: already in sync.' : '';
    const btn = el('button', { className: 'btn primary', textContent: `Approve and create review branch (${writable.length} file${writable.length === 1 ? '' : 's'})`, disabled: !!blockedWhy,
      onclick: (e) => busy(e.currentTarget, async () => {
        const r = await api(`/projects/${p.id}/cursor-rules/generate`, { service_id: svc.id, approve: true, digest: pv.digest });
        if (r.changed) toast(`committed on ${r.branch}; review task #${r.task.id} created. Nothing is merged until you approve it.`, 'ok', 9000); else toast(r.message, 'info', 7000);
        if (onDone) await onDone(r);
      }) });
    box.append(el('div', { className: 'callout info small', textContent: `Nothing is written until you click approve. The files above go onto a NEW branch of ${svc.name}'s repository as one commit, registered as a review task; the default branch and your checkout are never touched, and merging stays your decision.` }),
      el('div', { className: 'row' }, btn, blockedWhy ? el('span', { className: 'small dim', textContent: blockedWhy }) : null));
  }
  return box;
}

/** One service row: status, opt-in checkbox, Preview, Generate on branch. */
function serviceRow(p, svc, row, { refresh }) {
  const out = el('div', { className: 'mt' }), enabled = el('input', { type: 'checkbox', checked: !!row.enabled, 'aria-label': `Enable Cursor rules for ${svc.name}` });
  const show = async (approve) => {
    clear(out, skeletonLines(3));
    try { const pv = await api(`/projects/${p.id}/cursor-rules/preview?service_id=${svc.id}`); clear(out, previewView(p, svc, pv, { approve, onDone: async () => { await refresh(); } })); }
    catch (e) { clear(out, el('div', { className: 'callout bad small', role: 'alert', textContent: e.message })); }
  };
  enabled.addEventListener('change', () => busy(enabled, async () => {
    try { await api(`/projects/${p.id}/cursor-rules/optin`, { service_id: svc.id, enabled: enabled.checked }); toast(enabled.checked ? `Cursor rules enabled for ${svc.name}` : `Cursor rules disabled for ${svc.name}`, 'ok'); await refresh(); }
    catch (e) { enabled.checked = !enabled.checked; toastError(e); }
  }));
  return el('div', { className: 'rules-row' },
    el('div', { className: 'row' }, el('b', { textContent: svc.name }), el('code', { className: 'small', textContent: svc.path && svc.path !== '.' ? svc.path : 'repo root' }), rulesStatusBadge(row.status),
      row.pending_branches.length ? badge(`${row.pending_branches.length} pending review`, 's-review') : null, el('span', { style: { flex: 1 } }),
      el('label', { className: 'row small', title: 'Off by default. Only enabled services can get rules committed (always via a review branch).' }, enabled, 'enabled'),
      el('button', { className: 'btn sm sec', textContent: 'Preview', onclick: () => show(false) }),
      el('button', { className: 'btn sm', textContent: 'Generate on branch\u2026', disabled: !row.enabled || row.status === 'unavailable', title: row.enabled ? 'Shows the exact files first; nothing is written until you approve' : 'Enable the service first', onclick: () => show(true) })),
    row.problem ? el('div', { className: 'callout warn small', textContent: row.problem }) : null, out);
}

async function panel(p, services, host) {
  const refresh = async () => { await draw(); };
  async function draw() {
    let ov;
    try { ov = await api(`/projects/${p.id}/cursor-rules`); } catch (e) { return clear(host, el('div', { className: 'callout bad small', textContent: e.message })); }
    const byId = new Map(ov.services.map((r) => [r.service_id, r]));
    clear(host, ...(services.length ? services.map((s) => serviceRow(p, s, byId.get(s.id) || { enabled: false, status: 'unavailable', pending_branches: [], problem: null }, { refresh })) : [el('div', { className: 'dim small', textContent: 'No services yet.' })]));
  }
  await draw();
}

/** Card for the project Settings tab (every active service). */
export function cursorRulesCard(p, services) {
  const host = el('div', { className: 'stack' }, skeletonLines(2));
  const card = el('div', { className: 'card' }, el('h3', { textContent: 'Cursor rules (.cursor/rules)' }),
    el('div', { className: 'small dim mb', textContent: 'Optional and off by default. Generates .cursor/rules/*.mdc (project rules always on; architecture, memory and service rules on request or by file glob) and an AGENTS.md pointer from this project\'s RULES / ARCHITECTURE / MEMORY and service map, so Cursor outside the orchestrator follows them too. Files carrying the generated-by marker are the only ones ever rewritten; hand-written rules are left alone. The result always goes to a review branch.' }), host);
  panel(p, services, host);
  return card;
}

/** Modal for one service (opened from the service card). */
export function cursorRulesModal(p, service) {
  const host = el('div', { className: 'stack' }, skeletonLines(2));
  modal({ title: `Cursor rules: ${service.name}`, wide: true, body: el('div', {}, el('div', { className: 'small dim mb', textContent: 'Preview shows exactly what would be committed. Generating always creates a new review branch plus a review task; nothing reaches the default branch without your merge.' }), host), footer: null });
  panel(p, [service], host);
}

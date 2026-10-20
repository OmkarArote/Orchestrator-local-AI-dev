// Vertical lineage timeline for one task. Plain DOM, no dependencies.
import { el, clear, api, badge } from './ui.js';
import { icon } from './icons.js';

const LIVE = new Set(['approved', 'running', 'checking']);

function look(status) {
  const s = String(status || '');
  if (['ok', 'review', 'passed', 'done', 'merged'].includes(s)) return { cls: 'ln-ok', mark: 'circle-check' };
  if (['running', 'checking', 'approved'].includes(s)) return { cls: 'ln-run', mark: 'refresh' };
  if (['failed', 'fail', 'merge_rolled_back', 'error'].includes(s)) return { cls: 'ln-bad', mark: 'alert-triangle' };
  return { cls: 'ln-skip', mark: 'circle' };
}

function chain(n) {
  if (n.kind !== 'step') return [];
  const names = [];
  for (const c of n.children || []) {
    if (!['attempt', 'repair', 'escalation'].includes(c.kind)) continue;
    const label = c.model || c.engine;
    if (label && names[names.length - 1] !== label) names.push(label);
  }
  return names;
}

function card(n) {
  const view = look(n.status);
  const head = el('div', { className: 'ln-head' },
    el('b', {}, n.kind),
    n.file && n.file !== '(task)' ? el('code', {}, n.file) : null,
    n.engine ? badge(n.engine) : null,
    n.model ? badge(n.model) : null,
    n.status ? el('span', { className: 'small' }, n.status) : null,
    n.ms != null ? el('span', { className: 'small dim' }, `${n.ms} ms`) : null);
  const names = chain(n);
  const reason = n.reason ? el('div', { className: 'small' }, n.reason) : null;
  const steps = names.length > 1 ? el('div', { className: 'ln-chain' }, names.join(' → ')) : null;
  const bits = [];
  if (n.check) bits.push(el('div', { className: 'small dim' }, 'Check'), el('pre', { className: 'plain' }, String(n.check).slice(-400)));
  if (n.sha) bits.push(el('div', { className: 'small dim' }, 'Commit'), el('code', {}, String(n.sha).slice(0, 12)));
  const details = bits.length ? el('details', { className: 'ln-details' }, el('summary', {}, 'Details'), ...bits) : null;
  const kids = (n.children || []).map(card);
  return el('article', { className: `ln-card ${view.cls}` },
    el('div', { className: 'ln-mark', title: n.status || n.kind }, icon(view.mark, { size: 16 })),
    el('div', {}, head, reason, steps, details, kids.length ? el('div', { className: 'ln-branch' }, ...kids) : null));
}

function paint(body, data) {
  const tree = data && data.tree;
  clear(body, tree ? el('div', { className: 'ln-timeline' }, card(tree)) : el('div', { className: 'small dim' }, 'No lineage yet'));
}

export function lineageCard(id) {
  const body = el('div', { className: 'ln-body' }, el('div', { className: 'small dim' }, 'Loading lineage…'));
  const box = el('details', { className: 'callout lineage', open: true }, el('summary', {}, el('b', {}, 'Lineage')), body);
  let timer = null;
  let last = '';
  let busy = false;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  async function load() {
    if (!box.isConnected) { stop(); return; }
    if (busy) return;
    busy = true;
    try {
      const data = await api(`/tasks/${id}/lineage`);
      if (!box.isConnected) { stop(); return; }
      const sig = JSON.stringify(data && data.tree) + (data && data.status);
      if (sig !== last) { last = sig; paint(body, data); }
      const live = LIVE.has(data && data.status);
      if (live && !timer) timer = setInterval(load, 2000);
      if (!live) stop();
    } catch (e) {
      if (box.isConnected) clear(body, el('div', { className: 'small dim' }, e.message));
      stop();
    } finally { busy = false; }
  }
  queueMicrotask(() => { if (box.isConnected) load(); });
  return box;
}

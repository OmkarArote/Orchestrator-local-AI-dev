// Collapsible lineage tree for one task. Plain DOM, no dependencies.
import { el, clear, api } from './ui.js';

const tone = (status) => {
  const s = String(status || '');
  if (s === 'ok' || s === 'review' || s === 'passed') return 'ln-ok';
  if (s === 'failed' || s === 'fail') return 'ln-bad';
  if (s === 'running' || s === 'checking') return 'ln-warn';
  if (s === 'cursor') return 'ln-cloud';
  return 'ln-dim';
};

function bits(n) {
  const out = [n.kind];
  if (n.file && n.file !== '(task)') out.push(n.file);
  if (n.engine) out.push(n.engine);
  if (n.model) out.push(n.model);
  if (n.reason) out.push(n.reason);
  if (n.status) out.push(n.status);
  if (n.check) out.push(n.check);
  if (n.ms != null) out.push(`${n.ms}ms`);
  if (n.sha) out.push(String(n.sha).slice(0, 7));
  return out.join(' · ');
}

function branch(n, open) {
  const kids = n.children || [];
  const summary = el('summary', {}, el('span', { className: tone(n.status || n.engine) }, bits(n)));
  if (!kids.length) return el('div', { className: 'ln-leaf', role: 'treeitem' }, el('span', { className: tone(n.status || n.engine) }, bits(n)));
  return el('details', { open: open !== false, role: 'treeitem' }, summary, el('div', { className: 'ln-kids', role: 'group' }, ...kids.map((c, i) => branch(c, i === 0))));
}

export function lineageCard(id) {
  const body = el('div', { className: 'ln-body' }, el('div', { className: 'small dim' }, 'Loading lineage…'));
  const box = el('details', { className: 'callout lineage', open: true }, el('summary', {}, el('b', {}, 'Lineage')), body);
  api(`/tasks/${id}/lineage`).then((data) => {
    const tree = data && data.tree;
    clear(body, tree ? el('div', { role: 'tree' }, branch(tree, true)) : el('div', { className: 'small dim' }, 'No lineage yet'));
  }).catch((e) => clear(body, el('div', { className: 'small dim' }, e.message)));
  return box;
}

// Chat attachment chips. Uploads go to POST /api/attachments as raw bytes. Nothing here renders file contents.
import { el, bytes } from './ui.js';

export async function uploadFile(file) {
  const r = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Orch-Upload': '1', 'X-Filename': encodeURIComponent(file.name || 'upload') },
    body: file,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `upload failed (${r.status})`);
  return j;
}

export function chipRow(items, onRemove) {
  if (!items.length) return null;
  return el('div', { className: 'row att-chips' }, ...items.map((it) => el('span', { className: 'chip' },
    `${it.name || 'file'}`,
    el('span', { className: 'small dim', textContent: ` ${it.kind || ''} ${it.size ? bytes(it.size) : ''}`.trim() }),
    el('button', { className: 'chip-x', type: 'button', 'aria-label': `Remove ${it.name || 'attachment'}`, textContent: '\u2715', onclick: () => onRemove(it.id) }))));
}

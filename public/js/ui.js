// Shared UI helpers: DOM builder, API client, toasts, modals/dialogs, small widgets. Plain ES module, no dependencies.
import { icon, ICONS } from './icons.js';
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

/** el('div', {className, onclick, dataset:{}, style}, ...children) - strings become text nodes (never HTML). */
export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && k !== 'list') { try { e[k] = v; } catch { e.setAttribute(k, v); } } else e.setAttribute(k, v === true ? '' : v);
  }
  append(e, kids);
  return e;
}
function append(parent, kids) {
  for (const k of kids.flat(Infinity)) { if (k === null || k === undefined || k === false) continue; parent.append(k instanceof Node ? k : document.createTextNode(String(k))); }
}
export const clear = (node, ...kids) => { node.replaceChildren(); append(node, kids); return node; };

// ---------------------------------------------------------------- API
export class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data || {}; } }
export async function api(path, body, { method } = {}) {
  const hasBody = body !== undefined;
  const r = await fetch('/api' + path, hasBody ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || r.statusText || `HTTP ${r.status}`, r.status, j);
  return j;
}

// ---------------------------------------------------------------- format
export const hhmmss = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
export function bytes(n) { if (n === null || n === undefined) return '-'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(n); while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; } return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`; }
export function ago(iso) { const s = Math.max(0, (Date.now() - new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso.replace(' ', 'T') + 'Z')) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`; }
export const shortPath = (p) => (p ? String(p).replace(/^\/Users\/[^/]+/, '~') : '');

// ---------------------------------------------------------------- widgets
export const badge = (text, cls = '', title) => el('span', { className: `badge ${cls}`, title, textContent: text });
export const chip = (text, cls = '', title) => el('span', { className: `chip ${cls}`, title, textContent: text });
export const statusBadge = (s) => badge(s, 's-' + s);
export function empty({ icon: name = 'circle', title, text, action }) {
  const mark = ICONS[name] ? icon(name) : name;
  return el('div', { className: 'empty' }, el('div', { className: 'big ico' }, mark), el('h3', { textContent: title }), text ? el('p', { textContent: text }) : null, action || null);
}
export function skeletonCards(n = 3, cls = 'skel-card') { return el('div', { className: 'grid auto', 'aria-busy': 'true' }, ...Array.from({ length: n }, () => el('div', { className: `skel ${cls}` }))); }
export function skeletonLines(n = 4) { return el('div', { className: 'stack', 'aria-busy': 'true' }, ...Array.from({ length: n }, (_, i) => el('div', { className: 'skel', style: { width: `${90 - i * 12}%` } }))); }
export function field(label, input, hint) { return el('div', { className: 'field' }, el('label', {}, label), input, hint ? el('div', { className: 'hint', textContent: hint }) : null); }
export function select(options, value, props = {}) { const s = el('select', props, ...options.map(([v, l]) => el('option', { value: v, textContent: l }))); if (value !== undefined) s.value = value; return s; }

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', ms = 4500) {
  const host = $('#toasts');
  const t = el('div', { className: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, el('div', {}, String(msg)), el('button', { className: 'x ico', 'aria-label': 'Dismiss', onclick: () => t.remove() }, icon('x')));
  host.append(t);
  if (ms) setTimeout(() => t.remove(), kind === 'bad' ? Math.max(ms, 8000) : ms);
  return t;
}
export const toastError = (e) => toast(e && e.message ? e.message : String(e), 'bad');

// ---------------------------------------------------------------- modals
const stack = [];
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && stack.length) { const m = stack[stack.length - 1]; if (m.dismissable()) m.close(null); }
  if (ev.key === 'Tab' && stack.length) { // keep focus inside the top modal
    const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', stack[stack.length - 1].overlay).filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); } else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
});
/** modal({title, body, footer, wide, onClose, dismissable}) -> {close, body, foot, overlay}. Esc / backdrop click close it. */
export function modal({ title, body, footer, wide = false, dismissable = () => true, onClose } = {}) {
  const prevFocus = document.activeElement;
  const bodyEl = el('div', { className: 'modal-body' }, body);
  const foot = el('div', { className: 'modal-foot' }, footer);
  const overlay = el('div', { className: 'overlay' });
  const box = el('div', { className: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'dialog' },
    el('div', { className: 'modal-head' }, el('h3', { textContent: title || '' }), el('button', { className: 'btn ghost icon ico', 'aria-label': 'Close', onclick: () => api2.close(null) }, icon('x'))),
    bodyEl, footer === undefined ? null : foot);
  overlay.append(box);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && api2.dismissable()) api2.close(null); });
  const api2 = { overlay, body: bodyEl, foot, dismissable, close(v) { const i = stack.indexOf(api2); if (i >= 0) stack.splice(i, 1); overlay.remove(); if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* gone */ } if (onClose) onClose(v); } };
  stack.push(api2);
  $('#modal-root').append(overlay);
  setTimeout(() => { const f = $('input:not([type=checkbox]), select, textarea, button.primary', bodyEl) || $('.btn', foot); if (f) f.focus(); }, 30);
  return api2;
}
/** Close every open modal (used on route changes so a stale dialog never sits over another page). */
export function closeAllModals() { for (const m of [...stack]) m.close(null); }
/** confirmDialog({title, message, confirmText, danger, typeToConfirm}) -> Promise<boolean>. typeToConfirm: user must type that exact text. */
export function confirmDialog({ title = 'Are you sure?', message, confirmText = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const inp = typeToConfirm ? el('input', { placeholder: typeToConfirm, 'aria-label': `type ${typeToConfirm} to confirm`, autocomplete: 'off' }) : null;
    const ok = el('button', { className: `btn ${danger ? 'bad' : 'ok'} primary`, textContent: confirmText, disabled: !!typeToConfirm, onclick: () => { m.close(true); } });
    if (inp) inp.addEventListener('input', () => { ok.disabled = inp.value !== typeToConfirm; });
    if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) m.close(true); });
    const m = modal({ title, body: el('div', { className: 'stack' }, el('div', { style: { whiteSpace: 'pre-wrap' } }, message), inp ? el('div', {}, el('label', {}, `Type "${typeToConfirm}" to confirm`), inp) : null),
      footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close(false) }), ok], onClose: (v) => fin(v === true) });
  });
}
/** promptDialog({title, label, placeholder, required, multiline, value}) -> Promise<string|null> */
export function promptDialog({ title, label, placeholder = '', required = true, multiline = false, value = '', confirmText = 'OK' }) {
  return new Promise((resolve) => {
    const inp = multiline ? el('textarea', { placeholder, value }) : el('input', { placeholder, value });
    const msg = el('div', { className: 'hint t-bad' });
    const go = () => { const v = inp.value.trim(); if (required && !v) { msg.textContent = 'required'; return; } m.close(v); };
    if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const m = modal({ title, body: el('div', {}, label ? el('label', {}, label) : null, inp, msg), footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close(null) }), el('button', { className: 'btn primary', textContent: confirmText, onclick: go })], onClose: (v) => resolve(v === undefined ? null : v) });
  });
}
/** Run an async action on a button: disables it, toasts errors. Returns the result or undefined on error. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toastError(e); } finally { if (btn) btn.disabled = false; }
}
export function copyText(text) { try { navigator.clipboard.writeText(text); toast('copied', 'ok', 1500); } catch { toast('copy failed', 'bad'); } }

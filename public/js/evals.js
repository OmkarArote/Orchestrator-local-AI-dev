// Eval runs. Compares saved npm run eval results. Nothing here starts a run.
import { el, clear, api, empty } from './ui.js';

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return 'skipped';
  return `${Math.round(Number(n) * 1000) / 10}%`;
}

export async function render(main) {
  const wrap = el('div', { className: 'stack' });
  main.append(el('h2', {}, 'Evals'), el('p', { className: 'dim' }, 'Saved runs from npm run eval. The table does not start a run and does not change settings.'), wrap);
  clear(wrap, el('div', { className: 'skel', style: { height: '80px' } }));
  let rows = [];
  try { rows = await api('/evals/runs'); } catch (e) { clear(wrap, el('div', { className: 'callout bad' }, e.message)); return; }
  if (!rows.length) {
    clear(wrap, empty({ icon: 'list', title: 'No eval runs yet', text: 'npm run eval writes evals/results. This page only reads those files.' }));
    return;
  }
  const head = el('tr', {}, ...['Run', 'Flags', 'Pass', 'Tokens / task', 'Escalated', 'Decider', 'Judge'].map((h) => el('th', {}, h)));
  const body = rows.map((r) => {
    const s = r.summary || {};
    const flags = Object.entries(r.flags || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    return el('tr', {},
      el('td', {}, el('code', {}, r.id)),
      el('td', {}, flags || '-'),
      el('td', {}, pct(s.passRate)),
      el('td', {}, s.tokensPerTask == null ? '-' : String(Math.round(s.tokensPerTask))),
      el('td', {}, pct(s.escalationRate)),
      el('td', {}, pct(s.deciderAccuracy)),
      el('td', {}, s.judgeSkipped ? 'skipped' : 'scored'));
  });
  clear(wrap, el('div', { className: 'card' }, el('table', {}, el('thead', {}, head), el('tbody', {}, ...body))));
}

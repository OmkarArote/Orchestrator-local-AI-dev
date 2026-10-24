// Entry point: hash router (#/projects, #/projects/:id/:tab, #/tasks, #/tasks/:id, #/models, #/chat, #/chat/:id, #/features, #/features/:id), sidebar, theme, background refresh.
import { $, el, clear, badge, toast, closeAllModals } from './js/ui.js';
import { icon } from './js/icons.js';
import { S, loadProjects, loadTasks, loadMem, loadCfg, loadCursor, loadOllama, loadDecider, onChange, ACTIVE_STATUSES } from './js/state.js';
import * as projectsView from './js/projects.js';
import * as tasksView from './js/tasks.js';
import * as modelsView from './js/models.js';
import * as chatView from './js/chat.js';
import * as featuresView from './js/features.js';
import * as evalsView from './js/evals.js';

// legacy deep links (#project=3&task=7 / &panel=services) -> new routes
(() => {
  const h = location.hash.slice(1);
  if (!h || h.startsWith('/')) return;
  const q = new URLSearchParams(h); const ns = q.get('nostream') ? '?nostream=1' : '';
  if (q.get('task')) location.hash = `#/tasks/${q.get('task')}${ns}`;
  else if (q.get('project')) location.hash = `#/projects/${q.get('project')}/${q.get('panel') || 'services'}${ns}`;
})();

const theme = localStorage.getItem('theme'); if (theme) { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; }
const qTheme = new URLSearchParams((location.hash.split('?')[1]) || '').get('theme'); if (qTheme === 'light' || qTheme === 'dark') { document.documentElement.dataset.theme = qTheme; document.documentElement.style.colorScheme = qTheme; } // deep link for screenshots (not persisted)
const NAV = [['#/projects', 'folder', 'Projects', 'projects'], ['#/tasks', 'list', 'Tasks', 'tasks'], ['#/features', 'arrows-exchange', 'Features', 'features'], ['#/chat', 'message', 'Chat', 'chat'], ['#/models', 'cpu', 'Models', 'models'], ['#/evals', 'check', 'Evals', 'evals']];

function parseRoute() {
  const [pathPart, qs] = location.hash.slice(1).split('?');
  const seg = (pathPart || '/projects').split('/').filter(Boolean);
  return { area: seg[0] || 'projects', id: seg[1] || null, tab: seg[2] || null, query: new URLSearchParams(qs || '') };
}
function narrowNav() { return matchMedia('(max-width: 1023px)').matches; }
function applyNav() {
  const app = document.getElementById('app');
  const narrow = narrowNav();
  const collapsed = localStorage.getItem('navCollapsed') === '1';
  app.classList.toggle('side-collapsed', !narrow && collapsed);
  if (!narrow) app.classList.remove('nav-open');
  const open = narrow ? app.classList.contains('nav-open') : !collapsed;
  const btn = document.getElementById('nav-toggle');
  const scrim = document.getElementById('scrim');
  if (scrim) scrim.hidden = !(narrow && app.classList.contains('nav-open'));
  if (!btn) return;
  const label = narrow ? (open ? 'Close navigation' : 'Open navigation') : (collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}
function onNavToggle() {
  const app = document.getElementById('app');
  if (narrowNav()) {
    const open = app.classList.toggle('nav-open');
    applyNav();
    if (open) { const first = document.querySelector('#nav a'); if (first) first.focus(); }
    return;
  }
  localStorage.setItem('navCollapsed', localStorage.getItem('navCollapsed') === '1' ? '0' : '1');
  applyNav();
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const nx = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nx;
  document.documentElement.style.colorScheme = nx;
  localStorage.setItem('theme', nx);
}
function mountChrome() {
  const start = $('#topbar-start'), end = $('#topbar-end');
  if (!start || start.childElementCount) return;
  start.append(el('button', { type: 'button', id: 'nav-toggle', className: 'btn ghost icon', 'aria-controls': 'side', 'aria-expanded': 'true', onclick: onNavToggle }, icon('menu')));
  end.append(el('button', { type: 'button', className: 'btn ghost sm', title: 'Switch light / dark', 'aria-label': 'Switch light or dark theme', onclick: toggleTheme }, icon('circle-half'), ' Theme'));
  $('#scrim').addEventListener('click', () => { document.getElementById('app').classList.remove('nav-open'); applyNav(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !document.getElementById('app').classList.contains('nav-open')) return;
    document.getElementById('app').classList.remove('nav-open');
    applyNav();
    const btn = document.getElementById('nav-toggle'); if (btn) btn.focus();
  });
  matchMedia('(max-width: 1023px)').addEventListener('change', () => { document.getElementById('app').classList.remove('nav-open'); applyNav(); });
  applyNav();
}

let cleanup = null, current = null;
async function route() {
  const r = parseRoute(); current = r;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  closeAllModals();
  document.getElementById('app').classList.remove('nav-open');
  applyNav();
  const main = $('#main'); main.replaceChildren(); window.scrollTo(0, 0);
  const view = { projects: projectsView, tasks: tasksView, models: modelsView, chat: chatView, features: featuresView, evals: evalsView }[r.area];
  if (!view) { location.hash = '#/projects'; return; }
  renderNav();
  try { cleanup = (await view.render(main, r)) || null; } catch (e) { clear(main, el('div', { className: 'callout bad' }, `Could not render this page: ${e.message}`)); console.error(e); }
  main.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

/** Tooltip of the Cursor chip: counted, not capped. tasks = distinct tasks with an implementation/plan run. */
const cursorTip = (u) => `Cursor runs on Cursor servers and uses your Pro usage. Counted, not capped (every run needs your approval).\nToday: ${u.today.tasks} task(s) \u2013 ${u.today.task_runs} implementation, ${u.today.plans} plan, ${u.today.reviews} review run(s), ${u.today.sessions} session(s)\nTotal: ${u.total.tasks} task(s) \u2013 ${u.total.task_runs} implementation, ${u.total.plans} plan, ${u.total.reviews} review run(s), ${u.total.sessions} session(s)`;
function renderNav() {
  const r = current || parseRoute();
  const active = S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length, review = S.tasks.filter((t) => t.status === 'review').length;
  const counts = { tasks: review ? `${review} review` : active ? `${active} active` : '', projects: S.projects.filter((p) => !p.archived).length || '' };
  clear($('#nav'), ...NAV.map(([href, ico, label, key]) => el('a', { href, title: label, className: r.area === key ? 'on' : '', 'aria-current': r.area === key ? 'page' : null }, el('span', { className: 'ico' }, icon(ico)), el('span', { className: 'nav-label' }, label), counts[key] ? el('span', { className: 'count', textContent: counts[key] }) : null)));
  const cu = S.cursor, ol = S.ollama, dec = S.decider, pend = S.memProps.filter((m) => m.status === 'pending').length;
  const deciderLabel = dec ? (dec.backend === 'laya' ? 'Laya' : dec.backend === 'ornith' ? 'ornith fallback' : 'down') : '';
  const deciderTip = dec ? [dec.setup, dec.fallback].filter(Boolean).join(' — ') || 'Scope gate backend' : '';
  clear($('#side-foot'),
    ol ? el('div', { className: 'chip ico', title: ol.error ? ol.error.message : `Ollama ${ol.version} at ${ol.base_url}` }, el('span', { className: ol.reachable ? 't-ok' : 't-bad' }, icon('point')), ` Ollama ${ol.reachable ? ol.version : 'offline'}`) : null,
    dec ? el('div', { className: 'chip ico', title: deciderTip }, el('span', { className: dec.backend === 'laya' ? 't-ok' : dec.backend === 'ornith' ? 't-warn' : 't-bad' }, icon('point')), ` Decider ${deciderLabel}`) : null,
    cu ? el('div', { className: `chip ico ${cu.error || !cu.logged_in ? '' : 'cloud'}`, title: cu.error || !cu.usage ? 'Cursor tasks run on Cursor servers and use your Pro usage' : cursorTip(cu.usage) }, cu.error ? 'Cursor: unavailable' : [icon('cloud'), ` Cursor ${cu.logged_in ? `${cu.usage.today.tasks} today \u00B7 ${cu.usage.total.tasks} total` : 'not logged in'}`]) : null,
    pend ? el('a', { className: 'chip ico', href: '#/projects', title: 'Pending memory proposals (nothing is added to memory without your approval)', onclick: () => { const p = S.projects.find((x) => S.memProps.some((m) => m.status === 'pending' && m.project_id === x.id)); if (p) location.hash = `#/projects/${p.id}/memory`; } }, icon('pencil'), ` ${pend} memory proposal${pend > 1 ? 's' : ''}`) : null);
}
onChange(renderNav);

mountChrome();
async function boot() {
  $('#main').append(el('div', { className: 'skel', style: { width: '40%', height: '28px' } }));
  await Promise.all([loadCfg(), loadProjects().catch((e) => toast(e.message, 'bad')), loadTasks().catch(() => {}), loadMem(), loadCursor(), loadOllama(), loadDecider()]);
  await route();
  setInterval(() => { loadTasks().catch(() => {}); loadMem(); }, 4000);
  setInterval(() => { loadCursor(); loadOllama(); loadDecider(); loadProjects().catch(() => {}); }, 30000);
}
boot();

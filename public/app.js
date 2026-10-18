// Entry point: hash router (#/projects, #/projects/:id/:tab, #/tasks, #/tasks/:id, #/models), sidebar, theme, background refresh.
import { $, el, clear, badge, toast, closeAllModals } from './js/ui.js';
import { S, loadProjects, loadTasks, loadMem, loadCfg, loadCursor, loadOllama, onChange, ACTIVE_STATUSES } from './js/state.js';
import * as projectsView from './js/projects.js';
import * as tasksView from './js/tasks.js';
import * as modelsView from './js/models.js';

// legacy deep links (#project=3&task=7 / &panel=services) -> new routes
(() => {
  const h = location.hash.slice(1);
  if (!h || h.startsWith('/')) return;
  const q = new URLSearchParams(h); const ns = q.get('nostream') ? '?nostream=1' : '';
  if (q.get('task')) location.hash = `#/tasks/${q.get('task')}${ns}`;
  else if (q.get('project')) location.hash = `#/projects/${q.get('project')}/${q.get('panel') || 'services'}${ns}`;
})();

const theme = localStorage.getItem('theme'); if (theme) document.documentElement.dataset.theme = theme;
const qTheme = new URLSearchParams((location.hash.split('?')[1]) || '').get('theme'); if (qTheme === 'light' || qTheme === 'dark') document.documentElement.dataset.theme = qTheme; // deep link for screenshots (not persisted)
const NAV = [['#/projects', '\u25A6', 'Projects', 'projects'], ['#/tasks', '\u2630', 'Tasks', 'tasks'], ['#/models', '\u25C8', 'Models', 'models']];

function parseRoute() {
  const [pathPart, qs] = location.hash.slice(1).split('?');
  const seg = (pathPart || '/projects').split('/').filter(Boolean);
  return { area: seg[0] || 'projects', id: seg[1] || null, tab: seg[2] || null, query: new URLSearchParams(qs || '') };
}
let cleanup = null, current = null;
async function route() {
  const r = parseRoute(); current = r;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  closeAllModals();
  const main = $('#main'); main.replaceChildren(); window.scrollTo(0, 0);
  const view = { projects: projectsView, tasks: tasksView, models: modelsView }[r.area];
  if (!view) { location.hash = '#/projects'; return; }
  renderNav();
  try { cleanup = (await view.render(main, r)) || null; } catch (e) { clear(main, el('div', { className: 'callout bad' }, `Could not render this page: ${e.message}`)); console.error(e); }
  main.focus({ preventScroll: true });
}
window.addEventListener('hashchange', route);

function renderNav() {
  const r = current || parseRoute();
  const active = S.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length, review = S.tasks.filter((t) => t.status === 'review').length;
  const counts = { tasks: review ? `${review} review` : active ? `${active} active` : '', projects: S.projects.filter((p) => !p.archived).length || '' };
  clear($('#nav'), ...NAV.map(([href, ico, label, key]) => el('a', { href, className: r.area === key ? 'on' : '', 'aria-current': r.area === key ? 'page' : null }, el('span', { className: 'ico', textContent: ico }), label, counts[key] ? el('span', { className: 'count', textContent: counts[key] }) : null)));
  const cu = S.cursor, ol = S.ollama, pend = S.memProps.filter((m) => m.status === 'pending').length;
  const themeBtn = el('button', { className: 'btn ghost sm', title: 'Switch light / dark', textContent: '\u25D0 Theme', onclick: () => { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; localStorage.setItem('theme', nx); } });
  clear($('#side-foot'),
    ol ? el('div', { className: 'chip', title: ol.error ? ol.error.message : `Ollama ${ol.version} at ${ol.base_url}` }, ol.reachable ? el('span', { className: 't-ok' }, '\u25CF') : el('span', { className: 't-bad' }, '\u25CF'), ` Ollama ${ol.reachable ? ol.version : 'offline'}`) : null,
    cu ? el('div', { className: `chip ${cu.error || !cu.logged_in ? '' : 'cloud'}`, title: 'Cursor tasks run on Cursor servers and use your Pro usage' }, cu.error ? 'Cursor: unavailable' : `\u2601 Cursor ${cu.logged_in ? `${cu.usage.used}/${cu.usage.cap} today` : 'not logged in'}`) : null,
    pend ? el('a', { className: 'chip', href: '#/projects', title: 'Pending memory proposals (nothing is added to memory without your approval)', onclick: () => { const p = S.projects.find((x) => S.memProps.some((m) => m.status === 'pending' && m.project_id === x.id)); if (p) location.hash = `#/projects/${p.id}/memory`; } }, `\u270E ${pend} memory proposal${pend > 1 ? 's' : ''}`) : null,
    themeBtn);
}
onChange(renderNav);

async function boot() {
  $('#main').append(el('div', { className: 'skel', style: { width: '40%', height: '28px' } }));
  await Promise.all([loadCfg(), loadProjects().catch((e) => toast(e.message, 'bad')), loadTasks().catch(() => {}), loadMem(), loadCursor(), loadOllama()]);
  await route();
  setInterval(() => { loadTasks().catch(() => {}); loadMem(); }, 4000);
  setInterval(() => { loadCursor(); loadOllama(); loadProjects().catch(() => {}); }, 30000);
}
boot();

// Shared client state + loaders (one place, so views stay small).
import { api } from './ui.js';

export const S = { projects: [], tasks: [], cfg: null, memProps: [], svc: {}, cursor: null, ollama: null, filter: { project: localStorage.getItem('projFilter') || '' } };
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => listeners.forEach((f) => f());

export async function loadProjects({ archived = true } = {}) {
  S.projects = await api('/projects' + (archived ? '?archived=1' : ''));
  if (S.filter.project && !S.projects.find((p) => String(p.id) === String(S.filter.project))) setProjectFilter('');
  notify(); return S.projects;
}
export async function loadTasks() { S.tasks = await api('/tasks'); notify(); return S.tasks; }
export async function loadMem() { try { S.memProps = await api('/memory-proposals'); } catch { /* keep previous */ } notify(); return S.memProps; }
export async function loadServices(pid, force = true) {
  if (!force && S.svc[pid]) return S.svc[pid];
  try { S.svc[pid] = await api(`/projects/${pid}/services?archived=1`); } catch { S.svc[pid] = S.svc[pid] || []; }
  return S.svc[pid];
}
export async function loadCfg() { try { S.cfg = await api('/config'); } catch { /* ignore */ } return S.cfg; }
export async function loadCursor() { try { S.cursor = await api('/cursor/status'); } catch (e) { S.cursor = { error: e.message }; } notify(); return S.cursor; }
export async function loadOllama() { try { S.ollama = await api('/ollama/status'); } catch (e) { S.ollama = { reachable: false, error: { message: e.message } }; } notify(); return S.ollama; }
export async function loadDecider() { try { S.decider = await api('/decider/status'); } catch (e) { S.decider = { backend: 'down', setup: e.message }; } notify(); return S.decider; }
export function setProjectFilter(v) { S.filter.project = v ? String(v) : ''; localStorage.setItem('projFilter', S.filter.project); }
export const project = (id) => S.projects.find((p) => String(p.id) === String(id));
export const projName = (id) => (project(id) || {}).name || `#${id}`;
export const activeServices = (pid) => (S.svc[pid] || []).filter((s) => !s.archived);
export const ACTIVE_STATUSES = ['pending', 'approved', 'running', 'checking', 'awaiting_escalation', 'awaiting_plan', 'awaiting_approval'];

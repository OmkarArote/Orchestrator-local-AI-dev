// Tasks: list + detail (live terminal log, coloured diff, approvals, overrides, routing/plan/review cards, new-task modal).
import { el, clear, api, badge, chip, statusBadge, empty, skeletonLines, field, select, modal, confirmDialog, promptDialog, toast, toastError, busy, hhmmss, copyText, shortPath } from './ui.js';
import { uploadFile } from './attachments.js';
import { S, loadTasks, loadMem, loadServices, loadProjects, project, projName, activeServices, ACTIVE_STATUSES, setProjectFilter } from './state.js';

const isCloud = (t) => t.engine !== 'local';
const FILTERS = [['all', 'All'], ['active', 'Active'], ['review', 'Review'], ['done', 'Done'], ['failed', 'Failed']];
const matches = (t, f) => f === 'all' || (f === 'active' && ACTIVE_STATUSES.includes(t.status)) || (f === 'review' && t.status === 'review') || (f === 'done' && t.status === 'done') || (f === 'failed' && ['failed', 'rejected'].includes(t.status));

export function taskBadges(t) {
  const out = [badge(t.engine === 'local' ? 'LOCAL' : t.engine === 'cursor' ? '\u2601 CURSOR' : 'AUTO', `e-${t.engine} nodot`)];
  if (isCloud(t)) out.push(chip(t.model_used ? `${t.model || 'auto'} \u2192 ${t.model_used}` : t.model || 'auto'));
  if (t.service_name) out.push(chip('svc: ' + t.service_name));
  if (t.feature_id) out.push(chip(`feature #${t.feature_id} ${t.feature_role || ''}`.trim(), '', 'Part of a cross-repo feature (contract-first, merge-order guarded)'));
  if (t.routing_state === 'routing') out.push(badge('routing\u2026', 's-pending'));
  else if (t.routing_source) out.push(chip('routed: ' + t.routing_source));
  if (t.supervised) out.push(badge('SUPERVISED', 's-awaiting_escalation'));
  if (t.group_id) out.push(chip(`seq #${t.group_id} step ${t.step_no}`));
  if (t.plan_first) out.push(chip('plan first' + (t.plan_state ? ': ' + t.plan_state : '')));
  return out;
}

// ---------------------------------------------------------------- memory proposal card (also used by the project Memory tab)
export function proposalCard(m, after, inTask) {
  const c = el('div', { className: 'callout mem stack' });
  c.append(el('div', { className: 'row' }, el('b', {}, `Memory proposal #${m.id}`), badge(m.status, m.status === 'pending' ? 's-pending' : m.status === 'approved' ? 's-done' : 's-rejected'),
    el('span', { className: 'small dim' }, `${projName(m.project_id)}${m.service_name ? ' / ' + m.service_name : ''}${!inTask && m.task_id ? ' \u00B7 task #' + m.task_id + ' ' + (m.task_title || '') : ''}`)));
  if (m.status !== 'pending') { c.append(el('pre', { className: 'plain' }, m.text)); return c; }
  const ta = el('textarea', { value: m.text, style: { minHeight: '90px' } });
  c.append(el('div', { className: 'small dim' }, 'Drafted by the local model. Edit freely. It is appended to the project MEMORY.md only if you approve.'), ta);
  const go = (label, cls, path, body) => el('button', { className: `btn sm ${cls}`, textContent: label, onclick: (e) => busy(e.currentTarget, async () => { await api(`/memory-proposals/${m.id}/${path}`, body()); toast(`proposal ${path === 'approve' ? 'approved' : path === 'reject' ? 'rejected' : 'saved'}`, 'ok'); await after(); }) });
  c.append(el('div', { className: 'row' }, go('Approve & append to MEMORY', 'ok', 'approve', () => ({ text: ta.value })), go('Save edit', 'sec', 'update', () => ({ text: ta.value })), go('Reject', 'bad', 'reject', () => ({ reason: 'rejected in dashboard' }))));
  return c;
}

// ---------------------------------------------------------------- new task
export async function newTaskModal(defaultProject, defaultService) {
  const projects = S.projects.filter((p) => !p.archived);
  if (!projects.length) { toast('Create a project first (Projects \u2192 New project).', 'warn'); location.hash = '#/projects'; return; }
  const pSel = select(projects.map((p) => [p.id, p.name]), defaultProject || S.filter.project || projects[0].id);
  const title = el('input', { maxLength: 200, placeholder: 'Short title' });
  const prompt = el('textarea', { placeholder: 'What should the model do?', style: { minHeight: '110px' } });
  const svc = select([['', '\u2014 choose a service \u2014']], '');
  const files = el('textarea', { placeholder: 'one per line; relative to the service folder when a service is chosen', style: { minHeight: '60px' } });
  const check = el('input', { placeholder: 'blank = service / project default' });
  const engine = select([['local', 'local (aider + ollama, on this Mac)'], ['cursor', '\u2601 cursor (Cursor servers, uses Pro usage)'], ['auto', 'auto (local first, escalate to cursor)'], ['auto-route', 'auto-route (local model suggests; you confirm)']], 'local');
  const localModel = select([['', 'default'], ['auto', 'auto']], '');
  api('/ollama/models').then((r) => { for (const m of (r.models || [])) localModel.append(el('option', { value: m.name, textContent: m.name })); }).catch(() => {});
  const localBox = el('div', {}, field('Local model', localModel, 'default uses the coding role; auto chooses an installed model and never downloads'));
  const attPending = [];
  const attList = el('div', { className: 'row att-chips' });
  const attInput = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Task files', onchange: async (e) => {
    const files = [...e.currentTarget.files]; e.currentTarget.value = '';
    for (const f of files) {
      if (attPending.length >= 20) { toast('At most 20 attachments.', 'warn'); break; }
      try { const up = await uploadFile(f); attPending.push({ id: up.id, name: up.name || f.name, to_cloud: false }); } catch (err) { toastError(err); }
    }
    drawAtt();
  } });
  function drawAtt() {
    const cloud = engine.value !== 'local';
    clear(attList, ...attPending.map((a) => el('span', { className: 'chip' }, a.name,
      cloud ? el('label', { className: 'small' }, el('input', { type: 'checkbox', checked: !!a.to_cloud, 'aria-label': `Send ${a.name} to Cursor`, onchange: (ev) => { a.to_cloud = ev.currentTarget.checked; } }), ' to Cursor') : null,
      el('button', { type: 'button', className: 'chip-x', 'aria-label': `Remove ${a.name}`, textContent: '\u2715', onclick: () => { attPending.splice(attPending.indexOf(a), 1); drawAtt(); } }))));
  }
  const attBox = el('div', { className: 'full' }, el('div', { className: 'small dim' }, 'Attachments (derived text only; files are not copied into the worktree)'), attList, attInput, el('button', { type: 'button', className: 'btn sm sec', textContent: 'Attach', onclick: () => attInput.click() }));
  const cm = el('input', { placeholder: (S.cfg && S.cfg.cursor_default_model) || 'auto', list: 'cursor-models' }); const dl = el('datalist', { id: 'cursor-models' });
  api('/cursor/models').then((r) => dl.replaceChildren(...r.models.map((x) => el('option', { value: x.id, textContent: x.name })))).catch(() => {});
  const plan = el('input', { type: 'checkbox' }), esc = el('input', { type: 'checkbox' }), review = el('input', { type: 'checkbox' });
  const cursorBox = el('div', { className: 'callout warn stack mb' });
  const planL = el('label', { className: 'chk' }, plan, 'plan first (Cursor writes a plan; you approve it before any code is written)'), escL = el('label', { className: 'chk' }, esc, 'allow escalation to Cursor if local fails (still needs your click)');
  cursorBox.append(el('div', { className: 'small' }, '\u2601 Cursor runs on Cursor servers and uses your Pro usage.'), field('Cursor model', cm), planL, escL, dl);
  const syncEngine = () => { const e = engine.value; cursorBox.style.display = e === 'local' ? 'none' : ''; localBox.style.display = e === 'local' ? '' : 'none'; escL.style.display = e === 'auto' || e === 'auto-route' ? '' : 'none'; planL.style.display = e === 'cursor' || e === 'auto-route' ? '' : 'none'; if (e === 'local') { plan.checked = false; esc.checked = false; } drawAtt(); };
  const syncProject = async () => {
    const p = project(pSel.value); await loadServices(pSel.value);
    svc.replaceChildren(...[['', activeServices(pSel.value).length ? '\u2014 choose a service \u2014' : 'no services yet \u2013 add one first'], ...(activeServices(pSel.value).length > 1 ? [['auto', 'auto (local model picks from the service map)']] : []), ...activeServices(pSel.value).map((s) => [String(s.id), `${s.name}${s.path && s.path !== '.' ? ' (' + s.path + ')' : ''}`])].map(([v, l]) => el('option', { value: v, textContent: l })));
    if (defaultService && activeServices(pSel.value).some((s) => String(s.id) === String(defaultService))) svc.value = String(defaultService);
    else if (activeServices(pSel.value).length === 1) svc.value = String(activeServices(pSel.value)[0].id);
    else if (activeServices(pSel.value).length > 1) svc.value = 'auto';
    if (p && !engine.dataset.touched) { engine.value = p.engine; syncEngine(); }
  };
  pSel.onchange = () => { engine.dataset.touched = ''; syncProject(); }; engine.onchange = () => { engine.dataset.touched = '1'; syncEngine(); };
  syncProject(); syncEngine();
  const msg = el('div', { className: 'callout bad', style: { display: 'none' } });
  const create = el('button', { className: 'btn primary', textContent: 'Create task', onclick: (e) => busy(e.currentTarget, async () => {
    msg.style.display = 'none';
    try {
      const t = await api('/tasks', { project_id: pSel.value, title: title.value, prompt: prompt.value, files: files.value, check_cmd: check.value, engine: engine.value, model: engine.value === 'local' ? localModel.value : cm.value, service_id: svc.value || undefined, allow_escalation: esc.checked, ai_review: review.checked, plan_first: plan.checked, attachments: attPending.map((a) => ({ id: a.id, to_cloud: engine.value !== 'local' && !!a.to_cloud })) });
      m.close(); toast(`task #${t.id} created (waiting for your approval)`, 'ok'); await loadTasks(); location.hash = `#/tasks/${t.id}`;
    } catch (er) { msg.textContent = er.message; msg.style.display = ''; }
  }) });
  const m = modal({ title: 'New task', wide: true,
    body: el('div', {}, el('div', { className: 'form-grid' }, el('div', { className: 'full' }, field('Project', pSel)), el('div', { className: 'full' }, field('Title', title)), el('div', { className: 'full' }, field('Prompt', prompt)),
      field('Service', svc, 'the local model can pick it from the service map'), field('Check command', check), el('div', { className: 'full' }, field('Files', files, 'aider edits these; cursor gets them as a hint')), el('div', { className: 'full' }, field('Engine', engine)), localBox, attBox),
      cursorBox, el('label', { className: 'chk' }, review, 'advisory AI review by Cursor after checks pass (uses 1 Cursor call; never blocks merge)'), msg),
    footer: [el('button', { className: 'btn sec', textContent: 'Cancel', onclick: () => m.close() }), create] });
}

// ---------------------------------------------------------------- diff view
export function renderDiff(box, r) {
  const files = []; let cur = null;
  for (const line of String(r.diff || '').split('\n')) {
    if (line.startsWith('diff --git')) { cur = { name: (line.match(/ b\/(.+)$/) || [])[1] || line, lines: [], add: 0, del: 0 }; files.push(cur); continue; }
    if (!cur) continue; cur.lines.push(line);
    if (line.startsWith('+') && !line.startsWith('+++')) cur.add++; else if (line.startsWith('-') && !line.startsWith('---')) cur.del++;
  }
  const head = el('div', { className: 'row small dim mb' }, el('span', {}, `[${r.note || ''}]${r.truncated ? ' (truncated)' : ''}`), r.repo ? chip(shortPath(r.repo), 'mono') : null, r.service ? chip('svc: ' + r.service) : null);
  const kids = [head, r.stat ? el('pre', { className: 'diffstat-pre' }, r.stat) : null];
  if (!files.length) kids.push(empty({ icon: '\u00B1', title: 'No diff', text: r.note && /failed/.test(r.note) ? r.note : 'This task has not changed any tracked file (yet).' }));
  else {
    const wrap = el('div', { className: 'diff' });
    files.forEach((f, i) => {
      let o = 0, n = 0; const rows = [];
      for (const line of f.lines.slice(0, 1500)) {
        let cls = 'ctx', num = '';
        if (/^(\+\+\+|---|index |new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(line)) cls = 'meta';
        else if (line.startsWith('@@')) { cls = 'hunk'; const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/); if (m) { o = Number(m[1]); n = Number(m[2]); } }
        else if (line.startsWith('+')) { cls = 'add'; num = n++; } else if (line.startsWith('-')) { cls = 'del'; num = o++; } else if (line !== '') { num = n; n++; o++; }
        if (cls === 'meta' && /^(\+\+\+|---)/.test(line)) continue;
        rows.push(el('div', { className: `dl ${cls}` }, el('span', { className: 'n' }, String(num)), el('span', { className: 'c' }, line || ' ')));
      }
      if (f.lines.length > 1500) rows.push(el('div', { className: 'dl meta' }, el('span', { className: 'n' }), el('span', { className: 'c' }, `\u2026 ${f.lines.length - 1500} more lines`)));
      wrap.append(el('details', { className: 'diff-file', open: i < 6 }, el('summary', {}, f.name, el('span', { className: 'diff-stat' }, el('span', { className: 'a' }, `+${f.add}`), ' ', el('span', { className: 'd' }, `\u2212${f.del}`))), el('div', { className: 'diff-body' }, ...rows)));
    });
    kids.push(wrap);
  }
  clear(box, ...kids);
}

// ---------------------------------------------------------------- terminal log
function terminal(taskId, { stream }) {
  const body = el('div', { className: 'term-body', role: 'log', 'aria-live': 'off', tabIndex: 0 });
  let follow = true; const follow_cb = el('input', { type: 'checkbox', checked: true, onchange: () => { follow = follow_cb.checked; if (follow) body.scrollTop = body.scrollHeight; } });
  const status = el('span', {}, 'connecting\u2026'); const lines = [];
  const add = (r) => { lines.push(`${hhmmss(r.ts)} [${r.kind}] ${r.message}`); const near = body.scrollTop + body.clientHeight >= body.scrollHeight - 50; body.append(el('div', { className: `term-line l-${r.kind}` }, el('span', { className: 'ts' }, hhmmss(r.ts)), el('span', { className: 'k' }, r.kind), el('span', { className: 'm' }, r.message))); if (follow && near) body.scrollTop = body.scrollHeight; };
  const node = el('div', { className: 'term' }, el('div', { className: 'term-bar' }, el('div', { className: 'dots' }, el('i'), el('i'), el('i')), el('span', { className: 'spacer' }, `task #${taskId} \u00B7 live log \u00B7 `, status),
    el('label', {}, follow_cb, 'follow'), el('button', { className: 'btn sm ghost', style: { color: '#8b95a7' }, textContent: 'copy', onclick: () => copyText(lines.join('\n')) })), body);
  let es = null;
  if (!stream) { status.textContent = 'snapshot'; api(`/tasks/${taskId}/events`).then((rows) => rows.forEach(add)); }
  else {
    es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.addEventListener('log', (m) => { try { add(JSON.parse(m.data)); } catch { /* ignore */ } });
    es.addEventListener('status', () => { loadTasks(); });
    es.onopen = () => { status.textContent = 'live'; }; es.onerror = () => { status.textContent = 'reconnecting\u2026'; };
  }
  return { node, close: () => es && es.close() };
}

// ---------------------------------------------------------------- detail
const ovr = {}, planEdit = {};
function initOverrides(t) {
  const r = t.routing, sug = r && r.suggestion, req = (r && r.request) || { service: true, engine: true };
  const o = { service_id: t.service_id || '', engine: t.engine, model: t.model || '', plan_first: !!t.plan_first, allow_escalation: !!t.allow_escalation };
  if (sug) { if (req.service) o.service_id = sug.service_id || ''; if (req.engine) { o.engine = sug.policy.engine; o.plan_first = !!sug.policy.plan_first; o.allow_escalation = !!sug.policy.allow_escalation; } }
  return o;
}
function routingCard(t) {
  const r = t.routing;
  if (t.routing_state === 'routing') return el('div', { className: 'callout route' }, `Routing in progress: the local model (${S.cfg ? S.cfg.router.model : 'local'}) is reading the service map\u2026`);
  if (!r || !r.suggestion) return t.route_requested ? el('div', { className: 'callout route' }, `Routing was requested but produced no suggestion (${t.routing_state || '?'}). You can still choose manually below.`) : null;
  const s = r.suggestion;
  return el('div', { className: 'callout route stack' }, el('div', {}, el('b', {}, `Routing suggestion (${s.source}) `), el('span', { className: 'dim' }, '\u2013 a suggestion only; you confirm or override it when approving')),
    el('div', { className: 'row small' }, chip(`service: ${s.service || '(none / cross-service)'}`), chip(`confidence ${s.confidence}`), chip(`difficulty ${s.difficulty}`), chip(`thinking: ${s.needs_thinking}`)),
    s.multi_service ? el('div', { className: 'callout warn' }, el('b', {}, 'Looks multi-service. '), s.hint, s.candidates && s.candidates.length ? ` Candidates: ${s.candidates.join(', ')}.` : '') : null,
    el('div', { className: 'small dim' }, `policy: ${s.policy.rule}`), el('div', { className: 'small dim' }, `reason: ${s.reason}`),
    r.fallback_reason ? el('div', { className: 'small t-bad' }, `fallback to keyword matching: ${r.fallback_reason}`) : null,
    r.llm ? el('div', { className: 'small dim' }, `local model ${r.llm.model} via ${r.llm.api}: ${r.llm.ms} ms, ${r.llm.prompt_tokens ?? '?'} prompt tokens${r.llm.error ? ' | problem: ' + r.llm.error : ''}`) : null,
    s.local_model ? el('div', { className: 'small' }, `local model: ${s.local_model.rule} \u2192 ${s.local_model.model || 'none'}`) : null);
}
function overrideForm(t, o, rerender) {
  const svcs = activeServices(t.project_id);
  const box = el('div', { className: 'card flat stack' }, el('h4', {}, 'Start settings (override before approving)'));
  const sSel = select([...(o.service_id ? [] : [['', '\u2014 choose a service \u2014']]), ...svcs.map((x) => [String(x.id), `${x.name}${x.path && x.path !== '.' ? ' (' + x.path + ')' : ''}`])], String(o.service_id || ''), { onchange: () => { o.service_id = sSel.value; } });
  const eSel = select([['local', 'local (aider + ollama)'], ['auto', 'auto (local, then escalate)'], ['cursor', '\u2601 cursor (Pro usage)']], o.engine, { onchange: () => { o.engine = eSel.value; if (o.engine !== 'cursor') o.plan_first = false; if (o.engine !== 'auto') o.allow_escalation = false; if (o.engine === 'auto' && t.routing) o.allow_escalation = true; rerender(); } });
  box.append(el('div', { className: 'form-grid' }, field('Service', sSel), field('Engine', eSel)));
  if (o.engine !== 'local') box.append(field('Cursor model', el('input', { value: o.model, placeholder: (S.cfg && S.cfg.cursor_default_model) || 'auto', oninput: (e) => { o.model = e.target.value; } })));
  const chk = (label, key) => el('label', { className: 'chk' }, el('input', { type: 'checkbox', checked: !!o[key], onchange: (e) => { o[key] = e.target.checked; } }), label);
  if (o.engine === 'cursor') box.append(chk('plan first: Cursor writes a plan (--mode plan) and waits for your approval before coding', 'plan_first'));
  if (o.engine === 'auto') box.append(chk('allow escalation to Cursor if local fails (still needs your click)', 'allow_escalation'));
  if (o.engine !== 'local') box.append(el('div', { className: 'small t-warn' }, '\u2601 runs on Cursor servers and uses your Pro usage (counted in the Cursor usage counters; there is no cap, every run needs your click).'));
  return box;
}

async function renderDetail(pane, id, { stream, tab: startTab }) {
  let sig = '', tab = 'log', term = null, timer = null, diffLoaded = false;
  const head = el('div', { className: 'stack' }); const logHost = el('div'); const diffHost = el('div', { style: { display: 'none' } });
  const tabLog = el('button', { className: 'on', textContent: 'Live log', onclick: () => setTab('log') }), tabDiff = el('button', { textContent: 'Diff', onclick: () => setTab('diff') });
  clear(pane, head, el('div', { className: 'tabs mt' }, tabLog, tabDiff), logHost, diffHost);
  term = terminal(id, { stream }); logHost.append(term.node);
  function setTab(t) { tab = t; logHost.style.display = t === 'log' ? '' : 'none'; diffHost.style.display = t === 'diff' ? '' : 'none'; tabLog.className = t === 'log' ? 'on' : ''; tabDiff.className = t === 'diff' ? 'on' : ''; if (t === 'diff') loadDiff(); }
  async function loadDiff() { clear(diffHost, skeletonLines(5)); try { renderDiff(diffHost, await api(`/tasks/${id}/diff`)); } catch (e) { clear(diffHost, el('div', { className: 'callout bad' }, e.message)); } }
  let attInfo = null;
  const mpOf = (t) => S.memProps.filter((m) => m.task_id === t.id);
  api(`/tasks/${id}`).then((d) => { attInfo = d; draw(true); }).catch(() => {});
  function draw(force) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) { clear(head, empty({ icon: '?', title: `Task #${id} not found`, text: 'It may have been deleted with its project.' })); return; }
    const s = JSON.stringify([t, mpOf(t), (S.svc[t.project_id] || []).length, S.cfg && S.cfg.router]);
    if (!force && s === sig && head.childNodes.length) return; sig = s;
    const p = project(t.project_id);
    const svcPath = t.service_id ? ((S.svc[t.project_id] || []).find((x) => x.id === t.service_id) || {}).path : null;
    const kids = [
      el('div', { className: 'crumbs' }, el('a', { href: '#/tasks' }, 'Tasks'), ' / ', el('a', { href: `#/projects/${t.project_id}/services` }, t.project_name || projName(t.project_id))),
      el('div', { className: 'row' }, el('h2', {}, `#${t.id} ${t.title}`), statusBadge(t.status)),
      el('div', { className: 'row' }, ...taskBadges(t), isCloud(t) ? badge('runs on Cursor servers (uses Pro usage)', 'cloud') : badge(`local: aider + ollama on this Mac${S.cfg ? ' (' + S.cfg.local_model + ')' : ''}`, 'e-local nodot'),
        t.engine_used ? chip('engine used: ' + t.engine_used) : null, t.allow_escalation ? chip('escalation allowed') : null, t.ai_review ? chip(`AI review (${t.review_model || 'auto'})`) : null),
      el('dl', { className: 'kv small' }, el('dt', {}, 'Service'), el('dd', {}, t.service_name ? t.service_name + (svcPath && svcPath !== '.' ? ` (${svcPath})` : '') : '-'), el('dt', {}, 'Branch'), el('dd', {}, t.branch ? el('code', {}, t.branch) : '-'),
        el('dt', {}, 'Files'), el('dd', {}, t.files.join(', ') || '-'), el('dt', {}, 'Check'), el('dd', {}, t.check_cmd || `${t.service_name ? 'service/' : ''}project default (${p ? p.check_cmd : '?'})`), t.head_sha ? [el('dt', {}, 'Head'), el('dd', {}, el('code', {}, t.head_sha.slice(0, 10)))] : null),
      el('pre', { className: 'plain' }, t.prompt),
      attInfo && attInfo.attachments && attInfo.attachments.length ? el('div', { className: 'small' }, `sent to Cursor: ${attInfo.sent_to_cursor ? 'yes' : 'no'}`) : null,
    ];
    if (t.context) kids.push(el('div', { className: 'small dim' }, `context bundle given to the engine: ${t.context.total_chars}/${t.context.max_chars} chars (${t.context.parts.map((x) => x.name + (x.truncated ? '*' : '')).join(', ')}); file: ${shortPath(t.context.file)}`));
    const rc = routingCard(t); if (rc) kids.push(rc);
    if (t.result_summary) kids.push(el('div', { className: 'callout' }, el('b', {}, 'Result: '), t.result_summary));
    if (t.supervised) kids.push(el('div', { className: 'callout warn' }, "SUPERVISED: a hands-on session (Cursor IDE / CLI) is open on this task's worktree. The runner is paused for it; merge and approvals are blocked. Edit as you like, then click Release: the orchestrator runs the check and commits the worktree state on the task branch (\u2192 review)."));
    if (t.group_id) kids.push(el('div', { className: 'small dim' }, `Part of sequence #${t.group_id}, step ${t.step_no}${t.base_ref ? '; built on top of ' + t.base_ref : ''}. Diff compares against ${t.base_ref || 'the default branch'}. `, el('a', { href: `#/projects/${t.project_id}/sequences` }, 'open sequences')));
    if (t.status === 'awaiting_escalation') kids.push(el('div', { className: 'callout warn' }, `Local attempt failed. Escalate to Cursor (model ${t.model || 'auto'})? This runs on Cursor servers and uses your Pro usage. Nothing has been sent to Cursor yet.`));
    if (t.plan_text) {
      const pc = el('div', { className: 'callout plan stack' }, el('b', {}, `Cursor plan (${t.plan_state}${t.model_used ? ', model ' + t.model_used : ''})`));
      if (t.status === 'awaiting_plan') {
        planEdit[t.id] = planEdit[t.id] ?? t.plan_text;
        const ta = el('textarea', { className: 'big', style: { minHeight: '240px' }, value: planEdit[t.id], oninput: () => { planEdit[t.id] = ta.value; } });
        pc.append(el('div', { className: 'small dim' }, 'Read-only planning run (--mode plan). You can edit the plan; implementation (a second Cursor run, counted in the usage counters) starts only after you approve.'), ta);
      } else pc.append(el('pre', { className: 'plain' }, t.plan_text));
      kids.push(pc);
    }
    if (t.review_summary) kids.push(el('div', { className: 'callout info stack' }, el('b', {}, 'Advisory AI review'), el('pre', { className: 'plain' }, t.review_summary)));
    for (const m of mpOf(t)) kids.push(proposalCard(m, async () => { await loadMem(); draw(true); }, true));

    const pending = t.status === 'pending'; let o = null;
    if (pending && t.routing_state !== 'routing') { o = ovr[t.id] || (ovr[t.id] = initOverrides(t)); kids.push(overrideForm(t, o, () => draw(true))); }
    const row = el('div', { className: 'row' });
    const act = (label, cls, path, { reason = false, ask = null, body = null, danger = false } = {}) => row.append(el('button', { className: `btn ${cls}`, textContent: label, onclick: async (e) => {
      const b = body ? body() : {}; const btn = e.currentTarget;
      if (reason) { const r = await promptDialog({ title: label, label: 'Reason (required)', placeholder: 'why?', confirmText: label }); if (!r) return; b.reason = r; }
      const cm = typeof ask === 'function' ? ask() : ask;
      if (cm && !(await confirmDialog({ title: label, message: cm, confirmText: label, danger }))) return;
      btn.disabled = true;
      try { await api(`/tasks/${t.id}/${path}`, b); delete ovr[t.id]; delete planEdit[t.id]; toast(`${label}: done`, 'ok'); } catch (er) { if (er.data && er.data.override_required) await overrideDialog({ taskId: t.id, providerTaskId: er.data.provider_task_id, providerStatus: er.data.provider_status, message: er.message }); else toastError(er); }
      await loadTasks(); draw(true); if (tab === 'diff') loadDiff();
    } }));
    const base = p ? p.default_branch : 'base'; const sup = t.supervised;
    if (pending) {
      if (t.routing_state === 'routing') kids.push(el('div', { className: 'small dim' }, 'Approve start is available once routing finishes.'));
      else {
        act('Approve start', 'ok', 'approve-start', { ask: () => (o.engine !== 'local' ? `This task runs on Cursor servers (engine ${o.engine}) and may use your Pro usage. Start it?` : null),
          body: () => ({ service_id: o.service_id || undefined, engine: o.engine, model: o.engine !== 'local' ? o.model : '', plan_first: o.plan_first, allow_escalation: o.allow_escalation, use_routing: !!(t.routing && t.routing.suggestion) }) });
        if (t.route_requested) act('Re-route', 'sec', 'reroute', { body: () => { delete ovr[t.id]; return {}; } });
        act('Reject', 'bad', 'reject-start', { reason: true });
      }
    }
    if (t.status === 'awaiting_plan' && !sup) { act('Approve plan & implement', 'ok', 'approve-plan', { ask: 'Run the implementation with Cursor now (a second Cursor run; uses Pro usage)?', body: () => (planEdit[t.id] !== undefined && planEdit[t.id] !== t.plan_text ? { plan: planEdit[t.id] } : {}) }); act('Reject plan', 'bad', 'reject-plan', { reason: true }); }
    if (t.status === 'awaiting_escalation' && !sup) { act('Approve escalation to Cursor', 'ok', 'approve-escalation', { ask: 'Run this task on Cursor servers (uses Pro usage)?' }); act('Reject escalation', 'bad', 'reject-escalation', { reason: true }); }
    if (t.status === 'review' && !sup) { act(`Approve & merge into ${base}`, 'ok', 'approve-merge', { ask: `Merge ${t.branch} into ${base} with --no-ff in ${t.service_name ? 'the repository of service ' + t.service_name : 'the project repo'}?` }); act('Reject', 'bad', 'reject-merge', { reason: true }); }
    if (['failed', 'rejected'].includes(t.status)) row.append(el('button', { className: 'btn primary', textContent: 'Re-run', title: 'Creates a new pending task with the same title, prompt, service and engine. You still approve its start.', onclick: async (e) => {
      await busy(e.currentTarget, async () => { try { const nt = await api(`/tasks/${t.id}/rerun`, {}); toast(`task #${nt.id} created as a re-run of #${t.id} (waiting for your approval)`, 'ok'); await loadTasks(); location.hash = `#/tasks/${nt.id}`; } catch (er) { toastError(er); } });
    } }));
    if (['running', 'checking'].includes(t.status)) act('Cancel', 'bad', 'cancel', { danger: true });
    if (sup) act('Release (run check + commit \u2192 review)', 'ok', 'release', { ask: 'Run the check and commit the current worktree state on the task branch?' });
    if (!sup && t.worktree_path && ['review', 'failed', 'awaiting_escalation', 'awaiting_plan'].includes(t.status)) {
      for (const [label, mode] of [['Open in Cursor IDE', 'ide'], ['Open Cursor CLI in Terminal', 'terminal']]) row.append(el('button', { className: 'btn sec', textContent: label, onclick: async (e) => {
        if (!(await confirmDialog({ title: label, message: `Open this task's ${t.service_name ? 'service folder (' + t.service_name + ')' : 'worktree'} ${mode === 'ide' ? 'in the Cursor IDE' : 'in a Terminal running an interactive Cursor agent (--model auto)'}? The task becomes SUPERVISED (runner paused for it) until you click Release.` }))) return;
        await busy(e.currentTarget, async () => { const r = await api(`/tasks/${t.id}/open-cursor`, { mode }); const mm = modal({ title: 'Opened', body: el('pre', { className: 'plain' }, r.notes.join('\n\n')), footer: [el('button', { className: 'btn primary', textContent: 'OK', onclick: () => mm.close() })] }); });
        await loadTasks(); draw(true);
      } }));
    }
    kids.push(row);
    clear(head, ...kids);
  }
  draw(true);
  if (startTab === 'diff') setTab('diff');
  const unsub = () => {};
  timer = setInterval(() => draw(false), 1500);
  const diffTimer = setInterval(() => { if (tab === 'diff') { const t = S.tasks.find((x) => x.id === id); if (t && ACTIVE_STATUSES.includes(t.status)) loadDiff(); } }, 8000);
  return () => { clearInterval(timer); clearInterval(diffTimer); term.close(); unsub(); };
}

// ---------------------------------------------------------------- page
export async function render(main, route) {
  const id = route.id ? Number(route.id) : null; const stream = !route.query.get('nostream');
  let filter = sessionStorage.getItem('taskFilter') || 'all'; let detailCleanup = null;
  const projSel = select([['', 'All projects'], ...S.projects.filter((p) => !p.archived).map((p) => [p.id, p.name])], S.filter.project, { 'aria-label': 'Filter by project' });
  const seg = el('div', { className: 'seg' });
  const list = el('div', { className: 'list' }); const detail = el('div', { className: 'pane' });
  const newBtn = el('button', { className: 'btn', textContent: '+ New task', onclick: () => newTaskModal() });
  main.append(el('div', { className: 'page-head' }, el('div', { className: 'grow' }, el('h1', {}, 'Tasks'), el('p', {}, 'Every change is a task on its own branch. Nothing starts or merges without your approval.')), newBtn),
    el('div', { className: 'split' }, el('div', { className: 'pane' }, el('div', { className: 'row mb' }, el('div', { style: { flex: 1, minWidth: '140px' } }, projSel), seg), list), detail));
  const drawSeg = () => clear(seg, ...FILTERS.map(([k, l]) => el('button', { className: filter === k ? 'on' : '', textContent: l, onclick: () => { filter = k; sessionStorage.setItem('taskFilter', k); drawSeg(); drawList(); } })));
  projSel.onchange = () => { setProjectFilter(projSel.value); drawList(); };
  function drawList() {
    const rows = S.tasks.filter((t) => (!S.filter.project || String(t.project_id) === S.filter.project) && matches(t, filter));
    if (!rows.length) { clear(list, S.tasks.length === 0 ? empty({ icon: '\u2630', title: 'No tasks yet', text: 'Create a task: describe a change, pick a service and an engine. You approve before anything runs.', action: el('button', { className: 'btn', textContent: '+ New task', onclick: () => newTaskModal() }) }) : empty({ icon: '\u2205', title: 'Nothing here', text: 'No task matches this filter.' })); return; }
    clear(list, ...rows.map((t) => el('a', { href: `#/tasks/${t.id}${stream ? '' : '?nostream=1'}`, style: { color: 'inherit', textDecoration: 'none' } }, el('div', { className: `card hover task-row${t.id === id ? ' sel' : ''}` },
      el('span', { className: 'num' }, `#${t.id}`), el('div', { style: { minWidth: 0, flex: 1 } }, el('div', { className: 't ellipsis', title: t.title }, t.title), el('div', { className: 'sub' }, chip(t.project_name || projName(t.project_id)), ...taskBadges(t))), statusBadge(t.status)))));
  }
  drawSeg(); drawList();
  const unsubList = (() => { const iv = setInterval(drawList, 2500); return () => clearInterval(iv); })();
  if (id) { await loadServices((S.tasks.find((t) => t.id === id) || {}).project_id || 0); await loadMem(); detailCleanup = await renderDetail(detail, id, { stream, tab: route.query.get('tab') }); }
  else clear(detail, empty({ icon: '\u261C', title: 'Select a task', text: 'Pick a task on the left to see its live log, diff and approvals.' }));
  return () => { unsubList(); if (detailCleanup) detailCleanup(); };
}
